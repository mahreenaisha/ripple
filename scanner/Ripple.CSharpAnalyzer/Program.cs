using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Operations;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: Ripple.CSharpAnalyzer <repository-path> <config-json>");
    return 2;
}

try
{
    var options = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };
    var config = JsonSerializer.Deserialize<AnalyzerConfig>(
        await File.ReadAllTextAsync(args[1]),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
    ) ?? throw new InvalidOperationException("Analyzer configuration is empty.");
    var analyzer = new RepositoryAnalyzer(Path.GetFullPath(args[0]), config);
    var result = await analyzer.AnalyzeAsync();
    Console.WriteLine(JsonSerializer.Serialize(result, options));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.ToString());
    return 1;
}

internal sealed record AnalyzerConfig(
    IReadOnlyList<ServiceConfig> Services,
    int MaxDepth = 6,
    int MaxPathsPerTrigger = 8,
    int MaxFlows = 500
);

internal sealed record ServiceConfig(string Name, string Path);

internal sealed record AnalyzerResult(
    string SchemaVersion,
    GeneratorInfo Generator,
    LimitInfo Limits,
    IReadOnlyList<Flow> Flows,
    IReadOnlyList<AnalyzerWarning> Warnings
);

internal sealed record GeneratorInfo(string Name, bool Deterministic, string Strategy);
internal sealed record LimitInfo(int MaxDepth, int MaxPathsPerTrigger, int MaxFlows);
internal sealed record AnalyzerWarning(string Code, string Message, string? File, int? Line);
internal sealed record TriggerInfo(string Kind, string Label, string? MessageType = null);

internal sealed record Flow(
    string Id,
    string Service,
    TriggerInfo Trigger,
    string Confidence,
    IReadOnlyList<FlowStep> Steps,
    IReadOnlyList<IReadOnlyList<FlowStep>>? Branches = null
);

internal sealed record FlowStep(
    string Kind,
    string Symbol,
    string Label,
    string File,
    int Line,
    string Confidence,
    IReadOnlyList<string> Evidence
);

internal sealed record MethodNode(
    IMethodSymbol Symbol,
    IOperation Operation,
    string File,
    int Line
);

internal sealed record RouteTrigger(
    string Kind,
    string Label,
    IMethodSymbol Handler,
    string File,
    int Line,
    string Service,
    string Evidence,
    string? MessageType = null
);

internal sealed record Boundary(string Kind, string Label, string Confidence, string Evidence);
internal sealed record ResolvedCall(MethodNode Method, string Confidence, string Evidence);

internal sealed class RepositoryAnalyzer
{
    private static readonly HashSet<string> IgnoredDirectories = new(
        new[]
        {
            ".git", ".hg", ".svn", ".idea", ".vscode", "bin", "obj", "out", "build",
            "dist", "generated", "vendor", "node_modules", "test", "tests", "__tests__",
        },
        StringComparer.OrdinalIgnoreCase
    );

    private static readonly HashSet<string> DataMethods = new(
        new[]
        {
            "Add", "AddAsync", "Bulk", "Create", "Delete", "Execute", "ExecuteAsync",
            "Find", "FindAsync", "First", "FirstAsync", "Get", "GetAsync", "Index",
            "Insert", "List", "Load", "LoadAsync", "Query", "QueryAsync", "Remove",
            "Save", "SaveAsync", "SaveChanges", "SaveChangesAsync", "Search", "SearchAsync",
            "Single", "SingleAsync", "Update", "Upsert",
        },
        StringComparer.Ordinal
    );

    private readonly string _root;
    private readonly AnalyzerConfig _config;
    private readonly Dictionary<string, MethodNode> _methods = new(StringComparer.Ordinal);
    private readonly HashSet<INamedTypeSymbol> _types = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<string, string> _registrations = new(StringComparer.Ordinal);
    private readonly List<RouteTrigger> _triggers = [];
    private readonly List<AnalyzerWarning> _warnings = [];
    private readonly HashSet<string> _warningKeys = new(StringComparer.Ordinal);

    public RepositoryAnalyzer(string root, AnalyzerConfig config)
    {
        if (!Directory.Exists(root))
        {
            throw new DirectoryNotFoundException($"Repository path is not a directory: {root}");
        }
        _root = root;
        _config = config;
    }

    public async Task<AnalyzerResult> AnalyzeAsync()
    {
        if (!MSBuildLocator.IsRegistered)
        {
            MSBuildLocator.RegisterDefaults();
        }

        using var workspace = MSBuildWorkspace.Create();
        workspace.WorkspaceFailed += (_, eventArgs) =>
            AddWarning("workspace-diagnostic", eventArgs.Diagnostic.Message, null, null);

        foreach (var projectFile in ProjectFiles())
        {
            try
            {
                await workspace.OpenProjectAsync(projectFile);
            }
            catch (Exception error)
            {
                AddWarning(
                    "project-load-failed",
                    $"Could not load {Relative(projectFile)}: {error.Message}",
                    Relative(projectFile),
                    1
                );
            }
        }

        var projects = workspace.CurrentSolution.Projects
            .OrderBy(project => project.FilePath, StringComparer.Ordinal)
            .ToArray();
        foreach (var project in projects)
        {
            await IndexProjectAsync(project);
        }
        foreach (var project in projects)
        {
            await DiscoverRegistrationsAndTriggersAsync(project);
        }
        DiscoverQueueTriggers();

        var limits = new LimitInfo(
            Math.Max(1, _config.MaxDepth),
            Math.Max(1, _config.MaxPathsPerTrigger),
            Math.Max(1, _config.MaxFlows)
        );
        var flows = BuildFlows(limits);
        return new AnalyzerResult(
            "1.0.0",
            new GeneratorInfo("ripple-csharp-roslyn", true, "roslyn-semantic-analysis"),
            limits,
            flows,
            _warnings
                .OrderBy(item => item.File, StringComparer.Ordinal)
                .ThenBy(item => item.Line)
                .ThenBy(item => item.Code, StringComparer.Ordinal)
                .ToArray()
        );
    }

    private IEnumerable<string> ProjectFiles()
    {
        var seen = new HashSet<string>(PathComparer());
        foreach (var service in _config.Services.OrderBy(item => item.Path, StringComparer.Ordinal))
        {
            var directory = Path.GetFullPath(Path.Combine(_root, service.Path));
            if (!IsInsideRoot(directory) || !Directory.Exists(directory))
            {
                AddWarning(
                    "invalid-service-path",
                    $"Service path is outside the repository or missing: {service.Path}",
                    null,
                    null
                );
                continue;
            }
            var projects = Directory.EnumerateFiles(directory, "*.csproj", SearchOption.TopDirectoryOnly)
                .OrderBy(item => item, StringComparer.Ordinal)
                .ToArray();
            var selected = projects.FirstOrDefault(project =>
                string.Equals(
                    Path.GetFileNameWithoutExtension(project),
                    service.Name,
                    StringComparison.OrdinalIgnoreCase
                )
            ) ?? projects.FirstOrDefault();
            if (selected is not null && seen.Add(selected))
            {
                yield return selected;
            }
        }
    }

    private async Task IndexProjectAsync(Project project)
    {
        foreach (var document in project.Documents.OrderBy(item => item.FilePath, StringComparer.Ordinal))
        {
            if (!IsAnalyzable(document.FilePath))
            {
                continue;
            }
            var root = await document.GetSyntaxRootAsync();
            var model = await document.GetSemanticModelAsync();
            if (root is null || model is null)
            {
                continue;
            }

            foreach (var declaration in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(declaration) is INamedTypeSymbol type)
                {
                    _types.Add(type);
                }
            }
            foreach (var declaration in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(declaration) is not IMethodSymbol method)
                {
                    continue;
                }
                var operation = declaration.Body is not null
                    ? model.GetOperation(declaration.Body)
                    : declaration.ExpressionBody is not null
                        ? model.GetOperation(declaration.ExpressionBody.Expression)
                        : null;
                AddMethod(method, operation, declaration);
            }
            foreach (var declaration in root.DescendantNodes().OfType<LocalFunctionStatementSyntax>())
            {
                if (model.GetDeclaredSymbol(declaration) is not IMethodSymbol method)
                {
                    continue;
                }
                var operation = declaration.Body is not null
                    ? model.GetOperation(declaration.Body)
                    : declaration.ExpressionBody is not null
                        ? model.GetOperation(declaration.ExpressionBody.Expression)
                        : null;
                AddMethod(method, operation, declaration);
            }
        }
    }

    private void AddMethod(IMethodSymbol method, IOperation? operation, SyntaxNode declaration)
    {
        if (operation is null || declaration.SyntaxTree.FilePath is null)
        {
            return;
        }
        var key = method.OriginalDefinition;
        _methods.TryAdd(
            MethodId(key),
            new MethodNode(
                key,
                operation,
                Relative(declaration.SyntaxTree.FilePath),
                declaration.GetLocation().GetLineSpan().StartLinePosition.Line + 1
            )
        );
    }

    private async Task DiscoverRegistrationsAndTriggersAsync(Project project)
    {
        var documents = new List<(SyntaxNode Root, SemanticModel Model, string File)>();
        foreach (var document in project.Documents.OrderBy(item => item.FilePath, StringComparer.Ordinal))
        {
            if (!IsAnalyzable(document.FilePath))
            {
                continue;
            }
            var root = await document.GetSyntaxRootAsync();
            var model = await document.GetSemanticModelAsync();
            if (root is null || model is null)
            {
                continue;
            }
            documents.Add((root, model, Relative(document.FilePath!)));
        }
        var odataPrefix = documents
            .Select(item => DiscoverODataPrefix(item.Root, item.Model))
            .FirstOrDefault(prefix => prefix is not null);
        foreach (var document in documents)
        {
            DiscoverControllerRoutes(document.Root, document.Model, document.File, odataPrefix);
            DiscoverInvocations(document.Root, document.Model, document.File);
        }
    }

    private void DiscoverControllerRoutes(
        SyntaxNode root,
        SemanticModel model,
        string file,
        string? odataPrefix
    )
    {
        foreach (var declaration in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
        {
            if (model.GetDeclaredSymbol(declaration) is not INamedTypeSymbol type)
            {
                continue;
            }
            var isOData = TypeHierarchy(type).Any(item =>
                item.Name is "ODataController" or "ODataBaseController"
            );
            var classRoute = RouteTemplate(type.GetAttributes(), "RouteAttribute")
                ?.Replace("[controller]", type.Name.Replace("Controller", ""), StringComparison.OrdinalIgnoreCase);
            var isController = isOData
                || type.Name.EndsWith("Controller", StringComparison.Ordinal)
                || TypeHierarchy(type).Any(item => item.Name is "Controller" or "ControllerBase")
                || classRoute is not null;
            if (!isController)
            {
                continue;
            }

            foreach (var method in declaration.Members.OfType<MethodDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(method) is not IMethodSymbol symbol
                    || symbol.DeclaredAccessibility != Accessibility.Public)
                {
                    continue;
                }
                var attributes = symbol.GetAttributes();
                var httpAttributes = attributes
                    .Where(attribute => HttpVerbs(attribute).Count > 0)
                    .ToArray();
                foreach (var attribute in httpAttributes)
                {
                    var template = FirstString(attribute);
                    foreach (var verb in HttpVerbs(attribute))
                    {
                        AddApiTrigger(
                            $"{verb} {JoinRoute(classRoute, template)}",
                            symbol,
                            file,
                            AttributeLine(attribute, method),
                            "Roslyn resolved the ASP.NET HTTP attribute to this method"
                        );
                    }
                }
                if (httpAttributes.Length == 0 && isOData && odataPrefix is not null)
                {
                    var verb = ODataVerb(symbol.Name);
                    if (verb is not null)
                    {
                        AddApiTrigger(
                            $"{verb} {ODataRoute(odataPrefix, type.Name, symbol)}",
                            symbol,
                            file,
                            method.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                            "Roslyn resolved an OData controller convention to this public method"
                        );
                    }
                }
            }
        }
    }

    private void DiscoverInvocations(SyntaxNode root, SemanticModel model, string file)
    {
        foreach (var syntax in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (model.GetOperation(syntax) is not IInvocationOperation invocation)
            {
                continue;
            }
            DiscoverRegistration(invocation);
            var methodName = invocation.TargetMethod.Name;
            var verb = methodName switch
            {
                "MapGet" => "GET",
                "MapPost" => "POST",
                "MapPut" => "PUT",
                "MapPatch" => "PATCH",
                "MapDelete" => "DELETE",
                "MapHealthChecks" => "GET",
                _ => null,
            };
            if (verb is null || invocation.Arguments.Length == 0)
            {
                continue;
            }
            var routeArgument = invocation.Arguments
                .Select((argument, index) => new
                {
                    Argument = argument,
                    Index = index,
                    Route = ConstantString(argument.Value),
                })
                .FirstOrDefault(item => item.Route is not null);
            var route = routeArgument?.Route;
            if (route is null)
            {
                AddWarning(
                    "dynamic-route",
                    $"{methodName} route is not a compile-time constant.",
                    file,
                    Line(syntax)
                );
                continue;
            }
            var handler = invocation.Arguments
                .Where((_, index) => index != routeArgument!.Index)
                .Select(argument => ResolveHandler(argument.Value, model))
                .FirstOrDefault(item => item is not null);
            if (handler is null)
            {
                if (methodName != "MapHealthChecks")
                {
                    AddWarning(
                        "unresolved-route-handler",
                        $"Roslyn could not resolve the handler for {verb} {route}.",
                        file,
                        Line(syntax)
                    );
                }
                continue;
            }
            AddApiTrigger(
                $"{verb} {JoinRoute(null, route)}",
                handler,
                file,
                Line(syntax),
                "Roslyn resolved the minimal API registration and handler symbol"
            );
        }
    }

    private IMethodSymbol? ResolveHandler(IOperation operation, SemanticModel model)
    {
        operation = Unwrap(operation);
        if (operation is IMethodReferenceOperation methodReference)
        {
            return methodReference.Method;
        }
        if (operation is IDelegateCreationOperation delegateCreation)
        {
            return ResolveHandler(delegateCreation.Target, model);
        }
        if (operation is IAnonymousFunctionOperation anonymous)
        {
            var syntax = anonymous.Syntax;
            var node = new MethodNode(
                anonymous.Symbol.OriginalDefinition,
                anonymous.Body,
                Relative(syntax.SyntaxTree.FilePath),
                Line(syntax)
            );
            _methods[MethodId(node.Symbol)] = node;
            return node.Symbol;
        }
        return model.GetSymbolInfo(operation.Syntax).Symbol as IMethodSymbol;
    }

    private void DiscoverRegistration(IInvocationOperation invocation)
    {
        if (invocation.TargetMethod.Name is not ("AddScoped" or "AddSingleton" or "AddTransient"))
        {
            return;
        }
        var arguments = invocation.TargetMethod.TypeArguments;
        if (arguments.Length >= 2
            && arguments[0] is INamedTypeSymbol contract
            && arguments[1] is INamedTypeSymbol implementation)
        {
            _registrations[TypeId(contract)] = TypeId(implementation);
            return;
        }
        var typeArguments = invocation.Arguments
            .Select(argument => Unwrap(argument.Value))
            .OfType<ITypeOfOperation>()
            .Select(operation => operation.TypeOperand)
            .OfType<INamedTypeSymbol>()
            .ToArray();
        if (typeArguments.Length >= 2)
        {
            _registrations[TypeId(typeArguments[0])] = TypeId(typeArguments[1]);
        }
    }

    private void DiscoverQueueTriggers()
    {
        var discriminators = new List<(string Label, INamedTypeSymbol Type, string File, int Line)>();
        foreach (var method in _methods.Values)
        {
            foreach (var arm in Descendants(method.Operation).OfType<ISwitchExpressionArmOperation>())
            {
                var label = ConstantString(arm.Pattern);
                var type = Descendants(arm.Value).OfType<ITypeOfOperation>().FirstOrDefault()?.TypeOperand
                    as INamedTypeSymbol;
                if (label is not null && type is not null)
                {
                    discriminators.Add((label, type, method.File, Line(arm.Syntax)));
                }
            }
        }

        foreach (var discriminator in discriminators)
        {
            foreach (var type in _types.OrderBy(TypeName, StringComparer.Ordinal))
            {
                if (!HandlesMessage(type, discriminator.Type))
                {
                    continue;
                }
                var handler = type.GetMembers()
                    .OfType<IMethodSymbol>()
                    .Where(method => method.Name.StartsWith("Handle", StringComparison.Ordinal))
                    .Where(method => method.Parameters.Any(parameter =>
                        TypeId(parameter.Type) == TypeId(discriminator.Type)
                    ))
                    .OrderBy(method => method.Name, StringComparer.Ordinal)
                    .FirstOrDefault();
                if (handler is null || !_methods.ContainsKey(MethodId(handler)))
                {
                    continue;
                }
                _triggers.Add(
                    new RouteTrigger(
                        "queue",
                        discriminator.Label,
                        handler.OriginalDefinition,
                        discriminator.File,
                        discriminator.Line,
                        ServiceFor(discriminator.File),
                        $"Roslyn resolved discriminator \"{discriminator.Label}\" to {TypeName(discriminator.Type)} and matched the handler message type",
                        TypeName(discriminator.Type)
                    )
                );
            }
        }
    }

    private IReadOnlyList<Flow> BuildFlows(LimitInfo limits)
    {
        var flows = new List<Flow>();
        var unique = _triggers
            .GroupBy(
                trigger => $"{trigger.Kind}\0{trigger.Label}\0{trigger.File}\0{trigger.Line}",
                StringComparer.Ordinal
            )
            .Select(group => group.First())
            .OrderBy(trigger => trigger.File, StringComparer.Ordinal)
            .ThenBy(trigger => trigger.Line)
            .ThenBy(trigger => trigger.Label, StringComparer.Ordinal);

        foreach (var trigger in unique)
        {
            if (flows.Count >= limits.MaxFlows)
            {
                break;
            }
            if (!_methods.TryGetValue(MethodId(trigger.Handler), out var handler))
            {
                AddWarning(
                    "unresolved-handler",
                    $"Could not load the body for {MethodName(trigger.Handler)}.",
                    trigger.File,
                    trigger.Line
                );
                continue;
            }
            var triggerStep = Step(
                trigger.Kind == "queue" ? "queue-trigger" : "api-trigger",
                trigger.Label,
                trigger.Label,
                trigger.File,
                trigger.Line,
                "high",
                trigger.Evidence
            );
            var handlerStep = Step(
                "handler",
                MethodName(handler.Symbol),
                MethodName(handler.Symbol),
                handler.File,
                handler.Line,
                "high",
                trigger.Kind == "queue"
                    ? "Roslyn matched the queue message type to this handler symbol"
                    : "Roslyn matched the ASP.NET route registration to this handler symbol"
            );
            var visited = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default)
            {
                handler.Symbol,
            };
            var tails = PathsFrom(handler, 1, visited, limits)
                .OrderByDescending(PathScore)
                .ThenBy(PathKey, StringComparer.Ordinal)
                .Take(limits.MaxPathsPerTrigger)
                .ToArray();
            if (tails.Length == 0)
            {
                tails = [Array.Empty<FlowStep>()];
            }
            var paths = tails
                .Select(tail => (IReadOnlyList<FlowStep>)[triggerStep, handlerStep, .. tail])
                .ToArray();
            var primary = paths[0];
            var branches = paths.Skip(1).ToArray();
            flows.Add(
                new Flow(
                    StableId(trigger),
                    trigger.Service,
                    new TriggerInfo(trigger.Kind, trigger.Label, trigger.MessageType),
                    primary.Any(step => step.Confidence != "high") ? "medium" : "high",
                    primary,
                    branches.Length > 0 ? branches : null
                )
            );
        }

        if (flows.Count >= limits.MaxFlows && _triggers.Count > flows.Count)
        {
            AddWarning(
                "flow-cap-reached",
                $"Output stopped at the configured maximum of {limits.MaxFlows} flows.",
                null,
                null
            );
        }
        return flows;
    }

    private IReadOnlyList<IReadOnlyList<FlowStep>> PathsFrom(
        MethodNode method,
        int depth,
        HashSet<IMethodSymbol> visited,
        LimitInfo limits
    )
    {
        if (depth >= limits.MaxDepth)
        {
            return
            [
                [
                    Step(
                        "inference-limit",
                        "depth-limit",
                        "Depth limit reached",
                        method.File,
                        method.Line,
                        "high",
                        $"Traversal stopped at configured depth {limits.MaxDepth}"
                    ),
                ],
            ];
        }

        var paths = new List<IReadOnlyList<FlowStep>>();
        foreach (var invocation in Descendants(method.Operation)
            .OfType<IInvocationOperation>()
            .OrderBy(invocation => invocation.Syntax.SpanStart))
        {
            if (IsObservabilityCall(invocation.TargetMethod))
            {
                continue;
            }
            var boundary = BoundaryFor(invocation);
            if (boundary is not null)
            {
                paths.Add(
                    [
                        Step(
                            boundary.Kind,
                            InvocationName(invocation),
                            boundary.Label,
                            Relative(invocation.Syntax.SyntaxTree.FilePath),
                            Line(invocation.Syntax),
                            boundary.Confidence,
                            boundary.Evidence
                        ),
                    ]
                );
                continue;
            }

            var resolved = ResolveCall(invocation);
            if (resolved is null)
            {
                if (IsSourceAbstraction(invocation.TargetMethod.ContainingType))
                {
                    var symbol = MethodName(invocation.TargetMethod);
                    var file = Relative(invocation.Syntax.SyntaxTree.FilePath);
                    var line = Line(invocation.Syntax);
                    AddWarning(
                        "unresolved-call",
                        $"Roslyn resolved {symbol}, but no source implementation was selected.",
                        file,
                        line
                    );
                    paths.Add(
                        [
                            Step(
                                "inference-limit",
                                symbol,
                                $"Unresolved dispatch: {symbol}",
                                file,
                                line,
                                "medium",
                                "The call symbol is known, but its runtime implementation is not determined by a supported DI registration or unique source implementation"
                            ),
                        ]
                    );
                }
                continue;
            }
            if (visited.Contains(resolved.Method.Symbol))
            {
                continue;
            }
            var callStep = Step(
                "call",
                MethodName(resolved.Method.Symbol),
                MethodName(resolved.Method.Symbol),
                resolved.Method.File,
                resolved.Method.Line,
                resolved.Confidence,
                resolved.Evidence
            );
            var nested = PathsFrom(
                resolved.Method,
                depth + 1,
                new HashSet<IMethodSymbol>(visited, SymbolEqualityComparer.Default)
                {
                    resolved.Method.Symbol,
                },
                limits
            );
            if (nested.Count == 0)
            {
                paths.Add([callStep]);
            }
            else
            {
                paths.AddRange(nested.Select(tail =>
                    (IReadOnlyList<FlowStep>)[callStep, .. tail]
                ));
            }
        }
        return paths
            .OrderByDescending(PathScore)
            .ThenBy(PathKey, StringComparer.Ordinal)
            .Take(limits.MaxPathsPerTrigger)
            .ToArray();
    }

    private ResolvedCall? ResolveCall(IInvocationOperation invocation)
    {
        var target = invocation.TargetMethod.ReducedFrom ?? invocation.TargetMethod;
        if (_methods.TryGetValue(MethodId(target), out var direct))
        {
            return new ResolvedCall(
                direct,
                "high",
                $"Roslyn resolved the invocation to {target.ToDisplayString()}"
            );
        }

        var containingType = target.ContainingType?.OriginalDefinition;
        if (containingType is null || containingType.TypeKind != TypeKind.Interface)
        {
            return null;
        }
        var implementations = new List<(INamedTypeSymbol Type, string Confidence, string Evidence)>();
        if (_registrations.TryGetValue(TypeId(containingType), out var registeredTypeId))
        {
            var registered = _types.FirstOrDefault(type => TypeId(type) == registeredTypeId);
            if (registered is not null)
            {
                implementations.Add((
                    registered,
                    "high",
                    $"Roslyn resolved {TypeName(containingType)} through an explicit .NET DI registration to {TypeName(registered)}"
                ));
            }
        }
        else
        {
            var candidates = _types
                .Where(type => type.TypeKind == TypeKind.Class && !type.IsAbstract)
                .Where(type => type.AllInterfaces.Any(item =>
                    TypeId(item) == TypeId(containingType)
                ))
                .ToArray();
            if (candidates.Length == 1)
            {
                implementations.Add((
                    candidates[0],
                    "medium",
                    $"Roslyn found one source implementation of {TypeName(containingType)}; no supported DI registration selected it"
                ));
            }
        }
        foreach (var implementation in implementations)
        {
            var member = implementation.Type.FindImplementationForInterfaceMember(target.OriginalDefinition)
                    as IMethodSymbol
                ?? implementation.Type.GetMembers(target.Name)
                    .OfType<IMethodSymbol>()
                    .FirstOrDefault(candidate => SameSignature(candidate, target));
            if (member is not null
                && _methods.TryGetValue(MethodId(member), out var method))
            {
                return new ResolvedCall(method, implementation.Confidence, implementation.Evidence);
            }
        }
        return null;
    }

    private static Boundary? BoundaryFor(IInvocationOperation invocation)
    {
        var method = invocation.TargetMethod.ReducedFrom ?? invocation.TargetMethod;
        var type = method.ContainingType;
        if (type is null)
        {
            return null;
        }
        var typeEvidence = string.Join(
            " ",
            TypeHierarchy(type).Select(item =>
                $"{item.ToDisplayString()} {item.ContainingNamespace.ToDisplayString()}"
            )
        );
        var expression = InvocationName(invocation);
        var target = invocation.Arguments
            .Select(argument => ConstantString(argument.Value))
            .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
        Boundary Make(string kind, string label, string confidence, string reason) =>
            new(
                kind,
                label,
                confidence,
                $"{reason}; Roslyn symbol: {method.ToDisplayString()}"
            );

        if (typeEvidence.Contains("Microsoft.EntityFrameworkCore", StringComparison.Ordinal)
            || TypeHierarchy(type).Any(item => item.Name is "DbContext" or "DbSet"))
        {
            return Make("database", $"EF Core via {expression}", "high", "Resolved EF Core type");
        }
        if (typeEvidence.Contains("DynamoDB", StringComparison.OrdinalIgnoreCase)
            || type.Name.Contains("DBRepository", StringComparison.OrdinalIgnoreCase))
        {
            return Make("database", $"DynamoDB via {expression}", "high", "Resolved DynamoDB client type");
        }
        if ((type.Name.Contains("Repository", StringComparison.OrdinalIgnoreCase)
                || type.Name.Contains("EntityProvider", StringComparison.OrdinalIgnoreCase)
                || type.Name.Contains("DataProvider", StringComparison.OrdinalIgnoreCase))
            && DataMethods.Contains(method.Name))
        {
            return Make(
                "database",
                $"data provider via {expression}",
                "medium",
                "Resolved repository/provider abstraction on a known data operation"
            );
        }
        if (typeEvidence.Contains("System.Net.Http.HttpClient", StringComparison.Ordinal)
            || type.Name.Contains("HttpClient", StringComparison.OrdinalIgnoreCase)
            || type.Name.EndsWith("ApiClient", StringComparison.OrdinalIgnoreCase))
        {
            return Make("external", $"HTTP via {expression}", "high", "Resolved HTTP client type");
        }
        if (typeEvidence.Contains("AmazonIot", StringComparison.OrdinalIgnoreCase)
            || type.Name.Contains("IotData", StringComparison.OrdinalIgnoreCase))
        {
            return Make("external", $"AWS IoT via {expression}", "high", "Resolved AWS IoT client type");
        }
        if (type.Name.Contains("Mqtt", StringComparison.OrdinalIgnoreCase))
        {
            return Make("external", $"MQTT via {expression}", "high", "Resolved MQTT client type");
        }
        if (type.Name.Contains("Notification", StringComparison.OrdinalIgnoreCase)
            && method.Name.Contains("Send", StringComparison.OrdinalIgnoreCase))
        {
            return Make(
                "external",
                $"notification service via {expression}",
                "medium",
                "Resolved notification abstraction"
            );
        }
        if (typeEvidence.Contains("EventBridge", StringComparison.OrdinalIgnoreCase))
        {
            return Make(
                "queue",
                target is null ? $"EventBridge via {expression}" : $"EventBridge target \"{target}\"",
                "high",
                "Resolved EventBridge client type"
            );
        }
        if (typeEvidence.Contains("AmazonSQS", StringComparison.OrdinalIgnoreCase)
            || type.Name.Contains("Sqs", StringComparison.OrdinalIgnoreCase))
        {
            return Make(
                "queue",
                target is null ? $"SQS via {expression}" : $"SQS queue \"{target}\"",
                "high",
                "Resolved SQS client type"
            );
        }
        if ((type.Name.Contains("Queue", StringComparison.OrdinalIgnoreCase)
                || type.Name.Contains("Publisher", StringComparison.OrdinalIgnoreCase))
            && method.Name.Contains(
                new[] { "Publish", "Send", "Enqueue", "Produce" },
                StringComparer.OrdinalIgnoreCase
            ))
        {
            return Make(
                "queue",
                target is null ? $"queue via {expression}" : $"queue \"{target}\"",
                "medium",
                "Resolved queue/publisher abstraction"
            );
        }
        return null;
    }

    private static bool IsObservabilityCall(IMethodSymbol method)
    {
        var typeName = method.ContainingType?.Name ?? "";
        return typeName.Contains(
                new[] { "Logger", "Logging", "Metric", "Telemetry", "Tracer", "Statsd" },
                StringComparer.OrdinalIgnoreCase
            )
            || method.Name.StartsWith(
                new[] { "Log", "Histogram", "Gauge", "Increment", "Decrement", "Counter", "Timing" },
                StringComparer.OrdinalIgnoreCase
            );
    }

    private static IEnumerable<IOperation> Descendants(IOperation operation)
    {
        var stack = new Stack<IOperation>();
        stack.Push(operation);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            yield return current;
            foreach (var child in current.ChildOperations.Reverse())
            {
                stack.Push(child);
            }
        }
    }

    private static IOperation Unwrap(IOperation operation)
    {
        while (operation is IConversionOperation conversion)
        {
            operation = conversion.Operand;
        }
        return operation;
    }

    private void AddApiTrigger(
        string label,
        IMethodSymbol handler,
        string file,
        int line,
        string evidence
    )
    {
        var normalized = label.Contains(' ')
            ? $"{label.Split(' ', 2)[0]} {JoinRoute(null, label.Split(' ', 2)[1])}"
            : label;
        _triggers.Add(
            new RouteTrigger(
                "api",
                normalized,
                handler.OriginalDefinition,
                file,
                line,
                ServiceFor(file),
                evidence
            )
        );
    }

    private string ServiceFor(string file)
    {
        return _config.Services
            .Where(service =>
            {
                var prefix = service.Path.Replace('\\', '/').Trim('/');
                return prefix.Length == 0 || prefix == "." || file == prefix
                    || file.StartsWith($"{prefix}/", StringComparison.Ordinal);
            })
            .OrderByDescending(service => service.Path.Length)
            .Select(service => service.Name)
            .FirstOrDefault() ?? "repository";
    }

    private static IReadOnlyList<string> HttpVerbs(AttributeData attribute)
    {
        var name = attribute.AttributeClass?.Name;
        if (name is null)
        {
            return [];
        }
        if (name == "AcceptVerbsAttribute")
        {
            return attribute.ConstructorArguments
                .SelectMany(argument => argument.Kind == TypedConstantKind.Array
                    ? argument.Values
                    : [argument])
                .Select(argument => argument.Value?.ToString()?.ToUpperInvariant())
                .Where(value => value is not null)
                .Cast<string>()
                .ToArray();
        }
        return name switch
        {
            "HttpGetAttribute" => ["GET"],
            "HttpPostAttribute" => ["POST"],
            "HttpPutAttribute" => ["PUT"],
            "HttpPatchAttribute" => ["PATCH"],
            "HttpDeleteAttribute" => ["DELETE"],
            _ => [],
        };
    }

    private static string? RouteTemplate(IEnumerable<AttributeData> attributes, string name) =>
        attributes
            .Where(attribute => attribute.AttributeClass?.Name == name)
            .Select(FirstString)
            .FirstOrDefault(value => value is not null);

    private static string? FirstString(AttributeData attribute) =>
        attribute.ConstructorArguments
            .Select(argument => argument.Value as string)
            .FirstOrDefault(value => value is not null);

    private static string? ConstantString(IOperation operation)
    {
        operation = Unwrap(operation);
        if (operation.ConstantValue.HasValue && operation.ConstantValue.Value is string value)
        {
            return value;
        }
        if (operation is IConstantPatternOperation pattern)
        {
            return ConstantString(pattern.Value);
        }
        return null;
    }

    private static int AttributeLine(AttributeData attribute, SyntaxNode fallback) =>
        attribute.ApplicationSyntaxReference?.GetSyntax().GetLocation()
            .GetLineSpan().StartLinePosition.Line + 1
        ?? Line(fallback);

    private static string JoinRoute(string? prefix, string? route)
    {
        var parts = new[] { prefix, route }
            .Where(part => !string.IsNullOrWhiteSpace(part))
            .Select(part => part!.Trim('/'));
        var joined = "/" + string.Join("/", parts);
        while (joined.Contains("//", StringComparison.Ordinal))
        {
            joined = joined.Replace("//", "/", StringComparison.Ordinal);
        }
        return joined;
    }

    private static string? DiscoverODataPrefix(SyntaxNode root, SemanticModel model)
    {
        foreach (var syntax in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (model.GetOperation(syntax) is not IInvocationOperation invocation
                || !invocation.TargetMethod.Name.Contains("OData", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var prefix = invocation.Arguments
                .Select(argument => ConstantString(argument.Value))
                .FirstOrDefault(value => value is not null);
            if (prefix is not null)
            {
                return prefix;
            }
        }
        return null;
    }

    private static string? ODataVerb(string methodName)
    {
        foreach (var verb in new[] { "Get", "Post", "Put", "Patch", "Delete" })
        {
            if (methodName.StartsWith(verb, StringComparison.Ordinal))
            {
                return verb.ToUpperInvariant();
            }
        }
        return null;
    }

    private static string ODataRoute(string prefix, string controllerName, IMethodSymbol method)
    {
        var entitySet = controllerName.Replace("Controller", "", StringComparison.Ordinal);
        var baseRoute = JoinRoute(prefix, entitySet);
        var hasKey = method.Parameters.Any(parameter =>
            parameter.Name.Equals("key", StringComparison.OrdinalIgnoreCase)
        );
        if (method.Name == "Get")
        {
            return baseRoute;
        }
        if (method.Name == $"Get{entitySet.TrimEnd('s')}")
        {
            return $"{baseRoute}({{key}})";
        }
        if (method.Name.StartsWith("Post", StringComparison.Ordinal))
        {
            return baseRoute;
        }
        if (method.Name.StartsWith(
            new[] { "Put", "Patch", "Delete" },
            StringComparer.Ordinal
        ))
        {
            return $"{baseRoute}({{key}})";
        }
        return $"{(hasKey ? $"{baseRoute}({{key}})" : baseRoute)}/{method.Name}";
    }

    private static bool HandlesMessage(INamedTypeSymbol type, INamedTypeSymbol message)
    {
        return TypeHierarchy(type)
            .SelectMany(item => item.TypeArguments)
            .Any(argument => TypeId(argument) == TypeId(message))
            && TypeHierarchy(type).Any(item =>
                item.Name.Contains("Handler", StringComparison.OrdinalIgnoreCase)
            );
    }

    private static IEnumerable<INamedTypeSymbol> TypeHierarchy(INamedTypeSymbol? type)
    {
        var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        for (var current = type; current is not null; current = current.BaseType)
        {
            if (seen.Add(current))
            {
                yield return current;
            }
            foreach (var contract in current.AllInterfaces)
            {
                if (seen.Add(contract))
                {
                    yield return contract;
                }
            }
        }
    }

    private bool IsSourceAbstraction(INamedTypeSymbol? type) =>
        type is not null
        && (type.Locations.Any(location => location.IsInSource)
            || _types.Any(candidate => candidate.AllInterfaces.Any(contract =>
                TypeId(contract) == TypeId(type)
            )));

    private bool IsAnalyzable(string? filePath)
    {
        if (filePath is null || !IsInsideRoot(Path.GetFullPath(filePath)))
        {
            return false;
        }
        return !Relative(filePath)
            .Split('/')
            .Any(segment => IgnoredDirectories.Contains(segment));
    }

    private bool IsInsideRoot(string path) =>
        path.Equals(_root, PathComparison())
        || path.StartsWith(_root + Path.DirectorySeparatorChar, PathComparison());

    private string Relative(string filePath) =>
        Path.GetRelativePath(_root, Path.GetFullPath(filePath)).Replace('\\', '/');

    private static StringComparison PathComparison() =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static StringComparer PathComparer() =>
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private static int Line(SyntaxNode syntax) =>
        syntax.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    private static string TypeName(ITypeSymbol type) =>
        type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);

    private static string TypeId(ITypeSymbol type) =>
        DocumentationCommentId.CreateDeclarationId(type.OriginalDefinition)
        ?? type.OriginalDefinition.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);

    private static string MethodId(IMethodSymbol method) =>
        DocumentationCommentId.CreateDeclarationId(method.OriginalDefinition)
        ?? method.OriginalDefinition.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);

    private static bool SameSignature(IMethodSymbol candidate, IMethodSymbol contract) =>
        candidate.Name == contract.Name
        && candidate.Arity == contract.Arity
        && candidate.Parameters.Length == contract.Parameters.Length
        && candidate.Parameters.Zip(contract.Parameters).All(pair =>
            pair.First.RefKind == pair.Second.RefKind
            && TypeId(pair.First.Type) == TypeId(pair.Second.Type)
        );

    private static string MethodName(IMethodSymbol method) =>
        $"{TypeName(method.ContainingType)}.{method.Name}";

    private static string InvocationName(IInvocationOperation invocation)
    {
        var receiver = invocation.Instance?.Type is null
            ? TypeName(invocation.TargetMethod.ContainingType)
            : TypeName(invocation.Instance.Type);
        return $"{receiver}.{invocation.TargetMethod.Name}";
    }

    private static FlowStep Step(
        string kind,
        string symbol,
        string label,
        string file,
        int line,
        string confidence,
        string evidence
    ) => new(kind, symbol, label, file, Math.Max(1, line), confidence, [evidence]);

    private static int PathScore(IReadOnlyList<FlowStep> path)
    {
        var boundary = path.Any(step => step.Kind is "database" or "external" or "queue")
            ? 1000
            : 0;
        var depth = path.Count(step => step.Kind == "call") * 20;
        var inferencePenalty = path.Any(step => step.Kind == "inference-limit") ? 500 : 0;
        var trivialPenalty = path.Count(step =>
            step.Symbol.Contains(
                new[] { "Parameter", "Accessor", "GetKey", "Parse", "Validate", "Helper", "Result" },
                StringComparer.OrdinalIgnoreCase
            )
        ) * 30;
        return boundary + depth - inferencePenalty - trivialPenalty;
    }

    private static string PathKey(IReadOnlyList<FlowStep> path) =>
        string.Join("\0", path.Select(step => $"{step.Kind}:{step.Symbol}:{step.File}:{step.Line}"));

    private static string StableId(RouteTrigger trigger)
    {
        var bytes = SHA1.HashData(
            Encoding.UTF8.GetBytes(
                $"{trigger.Service}\0{trigger.Kind}\0{trigger.Label}\0{trigger.File}\0{trigger.Line}"
            )
        );
        return $"flow-{Convert.ToHexString(bytes).ToLowerInvariant()[..12]}";
    }

    private void AddWarning(string code, string message, string? file, int? line)
    {
        var key = $"{code}\0{message}\0{file}\0{line}";
        if (_warningKeys.Add(key))
        {
            _warnings.Add(new AnalyzerWarning(code, message, file, line));
        }
    }
}

internal static class StringExtensions
{
    public static bool Contains(
        this string value,
        IEnumerable<string> candidates,
        StringComparer comparer
    ) => candidates.Any(candidate =>
        value.Contains(
            candidate,
            comparer == StringComparer.OrdinalIgnoreCase
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal
        )
    );

    public static bool StartsWith(
        this string value,
        IEnumerable<string> candidates,
        StringComparer comparer
    ) => candidates.Any(candidate =>
        value.StartsWith(
            candidate,
            comparer == StringComparer.OrdinalIgnoreCase
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal
        )
    );
}
