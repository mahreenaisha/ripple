using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

internal sealed record TechnologyDefinition(
    string Id,
    string Label,
    string Kind,
    string Description,
    string[] ClientTypes,
    string[] Namespaces,
    string[] Packages,
    string[] Keywords
);

internal sealed record MapEvidence(
    string File,
    int Line,
    string Symbol,
    string Reason,
    string Kind,
    string Confidence,
    string Resolution
);

internal sealed record MapObservation(
    string ProjectKey,
    string TechnologyId,
    string? Direction,
    MapEvidence Evidence,
    IReadOnlyList<string> MethodKeys,
    string? SiteKey
);

internal sealed record MapPackage(string Id, int Line);
internal sealed record MapReference(string TargetFile, int Line);
internal sealed record MapOpenApiReference(string Spec, string ClassName, int Line);
internal sealed record MapConfigEntry(
    MapProject Project,
    string File,
    string Path,
    string Key,
    string Value,
    int Line
);
internal sealed record MapReceiver(
    string TypeName,
    string File,
    string DeclarationFile,
    string ProjectKey,
    int Line,
    string MethodName,
    IReadOnlyList<string> MethodKeys,
    string SiteKey
);
internal sealed record MapHelperCall(
    string ProjectKey,
    string CalleeId,
    string CalleeName,
    string File,
    int Line,
    IReadOnlyList<string> MethodKeys
);
internal sealed record TechnologyMatch(
    TechnologyDefinition Technology,
    string TypeName,
    string Confidence,
    string Resolution
);
internal sealed record MapFileContext(
    string File,
    MapProject Project,
    SemanticModel Model,
    HashSet<string> Usings
);

internal sealed class MapProject
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    public required string Directory { get; init; }
    public required string File { get; init; }
    public bool IsTest { get; init; }
    public List<MapReference> References { get; } = [];
    public List<MapPackage> Packages { get; } = [];
    public List<string> ProjectUsings { get; } = [];
    public List<MapOpenApiReference> OpenApiReferences { get; } = [];
    public HashSet<string> GlobalUsings { get; } = new(StringComparer.Ordinal);
    public HashSet<string> ExternalGlobalUsings { get; } = new(StringComparer.Ordinal);
    public ServiceConfig? Service { get; set; }
    public string Kind => Service is null ? "library" : "service";
}

internal sealed partial class RepositoryAnalyzer
{
    private const int MaxMapNodes = 500;
    private const int MaxMapEdges = 2000;
    private const int MaxEvidencePerEdge = 50;

    private static readonly TechnologyDefinition[] Technologies =
    [
        new("aws-iot", "AWS IoT", "external", "AWS IoT Core things, certificates, policies, and jobs",
            ["IAmazonIoT", "AmazonIoTClient"], ["Amazon.IoT"], ["AWSSDK.IoT"], []),
        new("aws-iot-data", "AWS IoT Data (MQTT)", "queue", "MQTT publishing and device shadows through AWS IoT Core",
            ["IAmazonIotData", "AmazonIotDataClient"], ["Amazon.IotData"], ["AWSSDK.IotData"], []),
        new("aws-greengrass", "AWS IoT Greengrass", "external", "Edge deployments and Greengrass core devices",
            ["IAmazonGreengrass", "AmazonGreengrassClient", "IAmazonGreengrassV2", "AmazonGreengrassV2Client"],
            ["Amazon.Greengrass", "Amazon.GreengrassV2"], ["AWSSDK.Greengrass", "AWSSDK.GreengrassV2"], ["Greengrass"]),
        new("aws-sqs", "Amazon SQS", "queue", "Message queues",
            ["IAmazonSQS", "AmazonSQSClient"], ["Amazon.SQS"], ["AWSSDK.SQS"], ["Sqs"]),
        new("aws-sns", "Amazon SNS", "queue", "Publish/subscribe notifications",
            ["IAmazonSimpleNotificationService", "AmazonSimpleNotificationServiceClient"],
            ["Amazon.SimpleNotificationService"], ["AWSSDK.SimpleNotificationService"], ["Sns"]),
        new("aws-eventbridge", "Amazon EventBridge", "queue", "Event bus",
            ["IAmazonEventBridge", "AmazonEventBridgeClient"], ["Amazon.EventBridge"], ["AWSSDK.EventBridge"], ["EventBridge"]),
        new("aws-kinesis", "Amazon Kinesis", "queue", "Data streams",
            ["IAmazonKinesis", "AmazonKinesisClient", "IAmazonKinesisFirehose", "AmazonKinesisFirehoseClient"],
            ["Amazon.Kinesis", "Amazon.KinesisFirehose"], ["AWSSDK.Kinesis", "AWSSDK.KinesisFirehose"], ["Kinesis"]),
        new("aws-dynamodb", "Amazon DynamoDB", "database", "Key-value and document tables",
            ["IAmazonDynamoDB", "AmazonDynamoDBClient", "IDynamoDBContext", "DynamoDBContext"],
            ["Amazon.DynamoDBv2"], ["AWSSDK.DynamoDBv2"], ["DynamoDb"]),
        new("aws-s3", "Amazon S3", "database", "Object storage",
            ["IAmazonS3", "AmazonS3Client", "ITransferUtility", "TransferUtility"], ["Amazon.S3"], ["AWSSDK.S3"], ["S3"]),
        new("aws-lambda", "AWS Lambda", "external", "Function invocations",
            ["IAmazonLambda", "AmazonLambdaClient"], ["Amazon.Lambda"], ["AWSSDK.Lambda"], []),
        new("aws-secrets-manager", "AWS Secrets Manager", "external", "Secret storage",
            ["IAmazonSecretsManager", "AmazonSecretsManagerClient"], ["Amazon.SecretsManager"], ["AWSSDK.SecretsManager"], ["SecretsManager"]),
        new("aws-ssm", "AWS Systems Manager", "external", "Parameter Store and Systems Manager APIs",
            ["IAmazonSimpleSystemsManagement", "AmazonSimpleSystemsManagementClient"],
            ["Amazon.SimpleSystemsManagement"], ["AWSSDK.SimpleSystemsManagement"], []),
        new("aws-cognito", "Amazon Cognito", "external", "User pools and identity",
            ["IAmazonCognitoIdentityProvider", "AmazonCognitoIdentityProviderClient"],
            ["Amazon.CognitoIdentityProvider"], ["AWSSDK.CognitoIdentityProvider"], ["Cognito"]),
        new("search", "Elasticsearch", "database", "Search cluster reached through Elasticsearch or OpenSearch clients",
            ["IElasticClient", "ElasticClient", "IElasticLowLevelClient", "ElasticLowLevelClient", "ElasticsearchClient",
                "IOpenSearchClient", "OpenSearchClient", "IOpenSearchLowLevelClient", "OpenSearchLowLevelClient"],
            ["Nest", "Elasticsearch.Net", "Elastic.Clients.Elasticsearch", "OpenSearch.Client", "OpenSearch.Net"],
            ["NEST", "Elasticsearch.Net", "Elasticsearch.Net.Aws", "Elastic.Clients.Elasticsearch",
                "OpenSearch.Client", "OpenSearch.Net", "OpenSearch.Net.Auth.AwsSigV4"],
            ["OpenSearch", "Elasticsearch"]),
        new("sqlserver", "SQL Server", "database", "Relational database",
            ["SqlConnection", "SqlCommand"], ["Microsoft.Data.SqlClient", "System.Data.SqlClient"],
            ["Microsoft.Data.SqlClient", "System.Data.SqlClient", "Microsoft.EntityFrameworkCore.SqlServer"], ["SqlServer"]),
        new("postgresql", "PostgreSQL", "database", "Relational database",
            ["NpgsqlConnection", "NpgsqlDataSource", "NpgsqlCommand"], ["Npgsql"],
            ["Npgsql", "Npgsql.EntityFrameworkCore.PostgreSQL"], ["Npgsql"]),
        new("mysql", "MySQL", "database", "Relational database",
            ["MySqlConnection", "MySqlCommand"], ["MySqlConnector", "MySql.Data"],
            ["MySqlConnector", "MySql.Data", "Pomelo.EntityFrameworkCore.MySql"], ["MySql"]),
        new("sqlite", "SQLite", "database", "Embedded relational database",
            ["SqliteConnection", "SqliteCommand"], ["Microsoft.Data.Sqlite"],
            ["Microsoft.Data.Sqlite", "Microsoft.EntityFrameworkCore.Sqlite"], ["Sqlite"]),
        new("efcore", "SQL database (EF Core)", "database", "Relational database reached through Entity Framework Core",
            ["DbContext", "DbSet"], ["Microsoft.EntityFrameworkCore"],
            ["Microsoft.EntityFrameworkCore", "Microsoft.EntityFrameworkCore.Relational"], ["DbContext"]),
        new("mongodb", "MongoDB", "database", "Document database",
            ["IMongoClient", "MongoClient", "IMongoDatabase", "IMongoCollection"], ["MongoDB.Driver"], ["MongoDB.Driver"], ["Mongo"]),
        new("redis", "Redis", "database", "In-memory data store",
            ["IConnectionMultiplexer", "ConnectionMultiplexer", "IDatabase", "ISubscriber"], ["StackExchange.Redis"],
            ["StackExchange.Redis", "Microsoft.Extensions.Caching.StackExchangeRedis"], ["Redis"]),
        new("cosmosdb", "Azure Cosmos DB", "database", "Document database",
            ["CosmosClient"], ["Microsoft.Azure.Cosmos"], ["Microsoft.Azure.Cosmos"], ["Cosmos"]),
        new("azure-blob", "Azure Blob Storage", "database", "Object storage",
            ["BlobServiceClient", "BlobContainerClient", "BlobClient"], ["Azure.Storage.Blobs"], ["Azure.Storage.Blobs"], []),
        new("azure-service-bus", "Azure Service Bus", "queue", "Message broker",
            ["ServiceBusClient", "ServiceBusSender", "ServiceBusProcessor", "ServiceBusReceiver"],
            ["Azure.Messaging.ServiceBus"], ["Azure.Messaging.ServiceBus"], ["ServiceBus"]),
        new("kafka", "Kafka", "queue", "Event streaming",
            ["IProducer", "IConsumer", "IAdminClient"], ["Confluent.Kafka"], ["Confluent.Kafka"], ["Kafka"]),
        new("rabbitmq", "RabbitMQ", "queue", "Message broker",
            ["IModel", "IChannel", "IConnection", "ConnectionFactory"], ["RabbitMQ.Client"], ["RabbitMQ.Client"], ["RabbitMq"]),
        new("mqtt", "MQTT broker", "queue", "MQTT publish/subscribe",
            ["IMqttClient", "MqttClient", "IManagedMqttClient"], ["MQTTnet"], ["MQTTnet"], ["Mqtt"]),
    ];

    private static readonly string[] ConfigHostKeys =
    [
        "HostName", "Host", "BaseUrl", "BaseUri", "BaseAddress", "ServiceUrl", "ServiceUri", "Endpoint",
        "EndpointUrl", "EndpointUri", "Url", "Uri", "ApiUrl", "ApiBaseUrl",
    ];

    private static readonly string[] IgnoredConfigSections =
    [
        "Logging", "Serilog", "OpenTelemetry", "Telemetry", "Monitoring", "Metrics", "Tracing", "Swagger",
        "HealthChecks", "Kestrel",
    ];

    private static readonly HashSet<string> ProvenanceDenylist = new(
        [
            "ILogger", "ILoggerFactory", "IConfiguration", "IConfigurationSection", "IConfigurationRoot",
            "IServiceProvider", "IServiceCollection", "IServiceScope", "IServiceScopeFactory", "IHttpClientFactory",
            "IHttpContextAccessor", "IHostEnvironment", "IWebHostEnvironment", "IHostApplicationLifetime",
            "IHostedService", "IMemoryCache", "IDistributedCache", "IOptions", "IOptionsMonitor", "IOptionsSnapshot",
            "IMapper", "IMediator", "ISender", "IPublisher", "IFeatureManager", "IAuthorizationService",
            "IAuthenticationService", "IDataProtectionProvider", "IStringLocalizer", "IValidator", "ISystemClock",
            "IApplicationBuilder", "IEndpointRouteBuilder", "IServiceProviderFactory", "ContainerBuilder",
            "ILoggerProvider", "IConfigurationProvider", "BackgroundService", "IFileProvider", "HttpContext",
            "ActionContext", "ControllerContext", "IAuthorizationPolicyProvider", "IAuthenticationSchemeProvider",
            "IApiVersionDescriptionProvider", "IActionDescriptorCollectionProvider", "IContentTypeProvider",
            "ITempDataProvider", "IEmailSender", "DefaultHttpContext", "IProblemDetailsService", "IHostingEnvironment",
        ],
        StringComparer.Ordinal
    );

    private static readonly string[] PlumbingNamespaces =
    [
        "Microsoft.Extensions.Logging", "Microsoft.Extensions.Options", "Microsoft.Extensions.DependencyInjection",
        "Microsoft.Extensions.Configuration", "Microsoft.Extensions.Hosting", "Microsoft.AspNetCore.Builder",
        "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing",
    ];

    private static readonly string[] RegistrationReceiverTypes =
    [
        "IServiceCollection", "ServiceCollection", "IHostBuilder", "HostBuilder", "IHostApplicationBuilder",
        "HostApplicationBuilder", "WebApplicationBuilder", "IWebHostBuilder", "WebApplication", "IApplicationBuilder",
        "IEndpointRouteBuilder", "IMvcBuilder", "IMvcCoreBuilder", "IHealthChecksBuilder", "IHttpClientBuilder",
        "ILoggingBuilder", "ContainerBuilder",
    ];

    private static readonly string[] RegistrationReceiverNames =
    [
        "services", "serviceCollection", "builder", "hostBuilder", "webBuilder", "app", "application", "host",
    ];

    private static readonly string[] ImplicitUsings =
    [
        "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading",
        "System.Threading.Tasks",
    ];

    private static readonly string[] WebImplicitUsings =
    [
        "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting",
        "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing", "Microsoft.Extensions.Configuration",
        "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging",
    ];

    private static readonly string[] WorkerImplicitUsings =
    [
        "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection",
        "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging",
    ];

    private static readonly string[] ClientSuffixes =
    [
        "Client", "Provider", "Repository", "Context", "Publisher", "Producer", "Consumer", "Sender", "Receiver",
        "Store", "Service", "Gateway",
    ];

    private static readonly string[] TestPackages =
    [
        "Microsoft.NET.Test.Sdk", "xunit", "xunit.core", "xunit.v3", "NUnit", "MSTest", "MSTest.TestFramework",
        "MSTest.Sdk",
    ];

    private static readonly Regex TestProjectName = new(
        @"(^|[._-])(tests?|unittests?|integrationtests?|functionaltests?|contracttests?|acceptancetests?|e2e|specs?|benchmarks?)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    private static readonly Regex HostPattern = new(
        @"^(?<host>[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::\d{1,5})?$",
        RegexOptions.CultureInvariant
    );

    private readonly List<MapProject> _mapProjects = [];
    private readonly List<MapObservation> _mapObservations = [];
    private readonly Dictionary<string, TechnologyDefinition> _mapTechnologies =
        Technologies.ToDictionary(item => item.Id, StringComparer.Ordinal);
    private readonly Dictionary<string, string> _generatedClients = new(StringComparer.Ordinal);
    private readonly List<MapConfigEntry> _configEntries = [];
    private readonly Dictionary<string, HashSet<string>> _usingsByFile = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> _externalUsingsByFile = new(StringComparer.Ordinal);
    private readonly List<MapReceiver> _unmatchedReceivers = [];
    private readonly Dictionary<string, List<MapObservation>> _wiringByMethod = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _helperCallsByMethod = new(StringComparer.Ordinal);
    private readonly List<MapHelperCall> _helperCalls = [];
    private readonly Dictionary<string, string> _boundaryImplementations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, bool> _namespaceExists = new(StringComparer.Ordinal);
    private readonly List<AnalyzerWarning> _mapWarnings = [];
    private Dictionary<string, List<IMethodSymbol>>? _extensionMethods;

    private async Task CollectArchitectureEvidenceAsync(IReadOnlyList<Project> projects)
    {
        DiscoverMapProjects();
        LoadConfigEntries();
        LoadGeneratedClients();

        var documents = new List<(SyntaxNode Root, SemanticModel Model, string File, MapProject Owner)>();
        foreach (var project in projects)
        {
            foreach (var document in project.Documents.OrderBy(item => item.FilePath, StringComparer.Ordinal))
            {
                if (!IsAnalyzable(document.FilePath))
                {
                    continue;
                }
                var file = Relative(document.FilePath!);
                var owner = MapOwner(file);
                if (owner is null || owner.IsTest)
                {
                    continue;
                }
                var root = await document.GetSyntaxRootAsync();
                var model = await document.GetSemanticModelAsync();
                if (root is not null && model is not null)
                {
                    documents.Add((root, model, file, owner));
                }
            }
        }
        if (documents.Count == 0)
        {
            CollectProjectDeclarations();
            return;
        }

        var compilation = documents[0].Model.Compilation;
        foreach (var document in documents)
        {
            var usings = new HashSet<string>(StringComparer.Ordinal);
            var external = new HashSet<string>(StringComparer.Ordinal);
            foreach (var directive in document.Root.DescendantNodes().OfType<UsingDirectiveSyntax>())
            {
                if (directive.Alias is not null
                    || directive.StaticKeyword.IsKind(SyntaxKind.StaticKeyword)
                    || directive.Name is null)
                {
                    continue;
                }
                var name = directive.Name.ToString().Replace("global::", "", StringComparison.Ordinal);
                var isExternal = !NamespaceExists(compilation, name);
                if (directive.GlobalKeyword.IsKind(SyntaxKind.GlobalKeyword))
                {
                    document.Owner.GlobalUsings.Add(name);
                    if (isExternal)
                    {
                        document.Owner.ExternalGlobalUsings.Add(name);
                    }
                }
                usings.Add(name);
                if (isExternal)
                {
                    external.Add(name);
                }
            }
            _usingsByFile[document.File] = usings;
            _externalUsingsByFile[document.File] = external;
        }
        foreach (var project in _mapProjects)
        {
            foreach (var name in project.ProjectUsings)
            {
                project.GlobalUsings.Add(name);
                if (!NamespaceExists(compilation, name))
                {
                    project.ExternalGlobalUsings.Add(name);
                }
            }
        }

        foreach (var document in documents)
        {
            var usings = _usingsByFile[document.File];
            usings.UnionWith(document.Owner.GlobalUsings);
            _externalUsingsByFile[document.File].UnionWith(document.Owner.ExternalGlobalUsings);
            var context = new MapFileContext(document.File, document.Owner, document.Model, usings);
            CollectInjections(document.Root, context);
            foreach (var invocation in document.Root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                CollectInvocation(invocation, context);
            }
            foreach (var creation in document.Root.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
            {
                CollectCreation(creation, context);
            }
        }
        InferWrapperTechnologies();
        AttributeRegistrationHelpers();
        CollectProjectDeclarations();
    }

    private void DiscoverMapProjects()
    {
        var files = new List<string>();
        var queue = new Queue<string>();
        queue.Enqueue(_root);
        while (queue.Count > 0)
        {
            var directory = queue.Dequeue();
            string[] children;
            try
            {
                children = Directory.EnumerateFileSystemEntries(directory)
                    .OrderBy(item => item, StringComparer.Ordinal)
                    .ToArray();
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            foreach (var child in children)
            {
                if (Directory.Exists(child))
                {
                    if (!IgnoredDirectories.Contains(Path.GetFileName(child)))
                    {
                        queue.Enqueue(child);
                    }
                }
                else if (Path.GetExtension(child).Equals(".csproj", StringComparison.OrdinalIgnoreCase))
                {
                    files.Add(child);
                }
            }
        }
        foreach (var file in files)
        {
            if (ReadMapProject(file) is { } project)
            {
                _mapProjects.Add(project);
            }
        }
        foreach (var service in _config.Services
            .OrderBy(item => item.Path, StringComparer.Ordinal)
            .ThenBy(item => item.Name, StringComparer.Ordinal))
        {
            var directory = NormalizeDirectory(service.Path);
            var project = _mapProjects.FirstOrDefault(item =>
                !item.IsTest && item.Service is null && item.Directory == directory
            );
            if (project is null)
            {
                project = new MapProject
                {
                    Key = $"service:{directory}\0{service.Name}",
                    Name = service.Name,
                    Directory = directory,
                    File = service.EntryFile ?? directory,
                };
                _mapProjects.Add(project);
            }
            project.Service = service;
        }
    }

    private MapProject? ReadMapProject(string path)
    {
        XDocument document;
        try
        {
            document = XDocument.Load(path, LoadOptions.SetLineInfo);
        }
        catch (Exception error) when (error is XmlException or IOException or UnauthorizedAccessException)
        {
            _mapWarnings.Add(new AnalyzerWarning(
                "project-file-unreadable",
                $"Could not read {Path.GetFileName(path)}: {error.Message}",
                Relative(path),
                null
            ));
            return null;
        }
        var projectDirectory = Path.GetDirectoryName(path)!;
        var file = Relative(path);
        var name = Path.GetFileNameWithoutExtension(path);
        var elements = document.Descendants().ToArray();
        var packages = elements
            .Where(element => element.Name.LocalName == "PackageReference")
            .Select(element => (Id: XmlAttribute(element, "Include"), Line: XmlLine(element)))
            .Where(item => !string.IsNullOrWhiteSpace(item.Id))
            .Select(item => new MapPackage(item.Id!.Trim(), item.Line))
            .ToArray();
        var isTest = elements.Any(element =>
                element.Name.LocalName == "IsTestProject"
                && element.Value.Trim().Equals("true", StringComparison.OrdinalIgnoreCase))
            || packages.Any(package => TestPackages.Contains(package.Id, StringComparer.OrdinalIgnoreCase))
            || (document.Root is not null
                && (XmlAttribute(document.Root, "Sdk") ?? "").Contains("MSTest.Sdk", StringComparison.OrdinalIgnoreCase))
            || TestProjectName.IsMatch(name);
        var project = new MapProject
        {
            Key = $"project:{file}",
            Name = name,
            Directory = NormalizeDirectory(Relative(projectDirectory)),
            File = file,
            IsTest = isTest,
        };
        project.Packages.AddRange(packages);
        foreach (var element in elements.Where(element => element.Name.LocalName == "ProjectReference"))
        {
            var target = ProjectRelativePath(projectDirectory, XmlAttribute(element, "Include"));
            if (target is not null)
            {
                project.References.Add(new MapReference(target, XmlLine(element)));
            }
        }
        var implicitUsings = elements.Any(element =>
            element.Name.LocalName == "ImplicitUsings"
            && element.Value.Trim() is var value
            && (value.Equals("enable", StringComparison.OrdinalIgnoreCase)
                || value.Equals("true", StringComparison.OrdinalIgnoreCase)));
        if (implicitUsings)
        {
            var sdk = document.Root is null ? "" : XmlAttribute(document.Root, "Sdk") ?? "";
            project.ProjectUsings.AddRange(ImplicitUsings);
            if (sdk.Contains("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase)
                || sdk.Contains("Microsoft.NET.Sdk.Razor", StringComparison.OrdinalIgnoreCase))
            {
                project.ProjectUsings.AddRange(WebImplicitUsings);
            }
            else if (sdk.Contains("Microsoft.NET.Sdk.Worker", StringComparison.OrdinalIgnoreCase))
            {
                project.ProjectUsings.AddRange(WorkerImplicitUsings);
            }
        }
        foreach (var element in elements.Where(element => element.Name.LocalName == "Using"))
        {
            var include = XmlAttribute(element, "Include");
            if (!string.IsNullOrWhiteSpace(include)
                && XmlAttribute(element, "Alias") is null
                && !string.Equals(XmlAttribute(element, "Static"), "true", StringComparison.OrdinalIgnoreCase))
            {
                project.ProjectUsings.Add(include.Trim());
            }
            if (XmlAttribute(element, "Remove") is { Length: > 0 } removed)
            {
                project.ProjectUsings.RemoveAll(item => item == removed.Trim());
            }
        }
        foreach (var element in elements.Where(element => element.Name.LocalName == "OpenApiReference"))
        {
            var spec = ProjectRelativePath(projectDirectory, XmlAttribute(element, "Include"));
            if (spec is null)
            {
                continue;
            }
            var className = (XmlAttribute(element, "ClassName")
                ?? element.Elements().FirstOrDefault(child => child.Name.LocalName == "ClassName")?.Value)?.Trim();
            if (string.IsNullOrWhiteSpace(className))
            {
                className = new string(Path.GetFileNameWithoutExtension(spec).Where(char.IsLetterOrDigit).ToArray()) + "Client";
            }
            project.OpenApiReferences.Add(new MapOpenApiReference(spec, className, XmlLine(element)));
        }
        return project;
    }

    private string? ProjectRelativePath(string projectDirectory, string? include)
    {
        if (string.IsNullOrWhiteSpace(include) || include.Contains("$(", StringComparison.Ordinal))
        {
            return null;
        }
        var target = Path.GetFullPath(Path.Combine(
            projectDirectory,
            include.Trim().Replace('\\', Path.DirectorySeparatorChar)
        ));
        return IsInsideRoot(target) ? Relative(target) : null;
    }

    private static string? XmlAttribute(XElement element, string name) =>
        element.Attributes()
            .FirstOrDefault(attribute => attribute.Name.LocalName.Equals(name, StringComparison.OrdinalIgnoreCase))
            ?.Value;

    private static int XmlLine(XObject node) =>
        node is IXmlLineInfo info && info.HasLineInfo() ? Math.Max(1, info.LineNumber) : 1;

    private static string NormalizeDirectory(string value)
    {
        var normalized = value.Replace('\\', '/').Trim('/');
        return normalized.Length == 0 ? "." : normalized;
    }

    private MapProject? MapOwner(string file)
    {
        MapProject? best = null;
        var bestScore = -1;
        foreach (var project in _mapProjects)
        {
            var directory = project.Directory;
            var score = directory == "." ? 0 : directory.Length + 1;
            if (directory != "." && !file.StartsWith($"{directory}/", StringComparison.Ordinal))
            {
                continue;
            }
            if (score > bestScore || (score == bestScore && best is not null && best.IsTest && !project.IsTest))
            {
                best = project;
                bestScore = score;
            }
        }
        return best;
    }

    private bool NamespaceExists(Compilation compilation, string name)
    {
        if (_namespaceExists.TryGetValue(name, out var exists))
        {
            return exists;
        }
        INamespaceSymbol? current = compilation.GlobalNamespace;
        foreach (var part in name.Split('.'))
        {
            current = current?.GetNamespaceMembers().FirstOrDefault(item => item.Name == part);
            if (current is null)
            {
                break;
            }
        }
        _namespaceExists[name] = current is not null;
        return current is not null;
    }

    private void LoadConfigEntries()
    {
        foreach (var project in _mapProjects
            .Where(item => !item.IsTest)
            .OrderBy(item => item.File, StringComparer.Ordinal))
        {
            var directory = project.Directory == "." ? _root : Path.Combine(_root, project.Directory);
            if (!Directory.Exists(directory))
            {
                continue;
            }
            foreach (var path in Directory.EnumerateFiles(directory, "appsettings*.json")
                .OrderBy(item => item, StringComparer.Ordinal))
            {
                foreach (var entry in ReadConfigStrings(path))
                {
                    _configEntries.Add(new MapConfigEntry(
                        project,
                        Relative(path),
                        entry.Path,
                        entry.Key,
                        entry.Value,
                        entry.Line
                    ));
                }
            }
        }
    }

    private static List<(string Path, string Key, string Value, int Line)> ReadConfigStrings(string path)
    {
        var results = new List<(string Path, string Key, string Value, int Line)>();
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return results;
        }
        var start = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        var lineStarts = new List<int> { 0 };
        for (var index = 0; index < bytes.Length; index++)
        {
            if (bytes[index] == (byte)'\n')
            {
                lineStarts.Add(index + 1);
            }
        }
        var reader = new Utf8JsonReader(
            bytes.AsSpan(start),
            new JsonReaderOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }
        );
        var sections = new List<string>();
        string? property = null;
        try
        {
            while (reader.Read())
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.PropertyName:
                        property = reader.GetString();
                        break;
                    case JsonTokenType.StartObject:
                        sections.Add(property ?? "");
                        property = null;
                        break;
                    case JsonTokenType.StartArray:
                        sections.Add(property is null ? "" : $"{property}[]");
                        property = null;
                        break;
                    case JsonTokenType.EndObject:
                    case JsonTokenType.EndArray:
                        if (sections.Count > 0)
                        {
                            sections.RemoveAt(sections.Count - 1);
                        }
                        property = null;
                        break;
                    case JsonTokenType.String:
                        if (property is not null && ConfigHostKeys.Contains(property, StringComparer.OrdinalIgnoreCase))
                        {
                            var offset = (int)reader.TokenStartIndex + start;
                            var line = lineStarts.BinarySearch(offset);
                            line = line >= 0 ? line + 1 : ~line;
                            var configPath = string.Join(
                                ".",
                                sections.Where(section => section.Length > 0).Append(property)
                            );
                            results.Add((configPath, property, reader.GetString() ?? "", line));
                        }
                        property = null;
                        break;
                    default:
                        property = null;
                        break;
                }
            }
        }
        catch (JsonException)
        {
            return results;
        }
        return results;
    }

    private void LoadGeneratedClients()
    {
        foreach (var project in _mapProjects.Where(item => !item.IsTest))
        {
            foreach (var reference in project.OpenApiReferences)
            {
                var (title, specHost) = ReadOpenApiSpec(Path.Combine(_root, reference.Spec));
                var stem = reference.ClassName.EndsWith("Client", StringComparison.Ordinal)
                    ? reference.ClassName[..^"Client".Length]
                    : reference.ClassName;
                var configHost = stem.Length == 0
                    ? null
                    : _configEntries
                        .Where(entry => entry.Path
                            .Split('.')
                            .SkipLast(1)
                            .Any(section => section.Contains(stem, StringComparison.OrdinalIgnoreCase)))
                        .Select(entry => ParseHost(entry.Value))
                        .FirstOrDefault(host => host is not null && !IsLocalHost(host) && !IsAwsHost(host));
                var host = specHost ?? configHost;
                var description = title is null
                    ? $"HTTP API called through the generated {reference.ClassName}"
                    : $"{title}, called through the generated {reference.ClassName}";
                var technology = host is not null
                    ? HostTechnology(host, description)
                    : RegisterTechnology(new TechnologyDefinition(
                        $"api:{reference.ClassName}",
                        title ?? stem,
                        "external",
                        description,
                        [],
                        [],
                        [],
                        []
                    ));
                _generatedClients.TryAdd(reference.ClassName, technology.Id);
                _generatedClients.TryAdd($"I{reference.ClassName}", technology.Id);
            }
        }
    }

    private static (string? Title, string? Host) ReadOpenApiSpec(string path)
    {
        string text;
        try
        {
            text = File.ReadAllText(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return (null, null);
        }
        if (path.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                using var json = JsonDocument.Parse(text, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip });
                var title = json.RootElement.TryGetProperty("info", out var info)
                    && info.TryGetProperty("title", out var titleElement)
                    ? titleElement.GetString()
                    : null;
                var url = json.RootElement.TryGetProperty("servers", out var servers)
                    && servers.ValueKind == JsonValueKind.Array
                    ? servers.EnumerateArray()
                        .Select(server => server.TryGetProperty("url", out var value) ? value.GetString() : null)
                        .FirstOrDefault(value => value is not null)
                    : json.RootElement.TryGetProperty("host", out var swaggerHost)
                        ? $"http://{swaggerHost.GetString()}"
                        : null;
                return (title, SpecHost(url));
            }
            catch (JsonException)
            {
                return (null, null);
            }
        }
        string? section = null;
        string? yamlTitle = null;
        string? yamlHost = null;
        foreach (var line in text.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith('#'))
            {
                continue;
            }
            if (!char.IsWhiteSpace(line[0]) && line[0] != '-')
            {
                section = trimmed.Split(':', 2)[0].Trim().Trim('"', '\'');
                continue;
            }
            if (section == "info" && yamlTitle is null && trimmed.StartsWith("title:", StringComparison.Ordinal))
            {
                yamlTitle = trimmed["title:".Length..].Trim().Trim('"', '\'');
            }
            if (section == "servers" && yamlHost is null)
            {
                var item = trimmed.TrimStart('-').Trim();
                if (item.StartsWith("url:", StringComparison.Ordinal))
                {
                    yamlHost = SpecHost(item["url:".Length..].Trim().Trim('"', '\''));
                }
            }
        }
        return (string.IsNullOrWhiteSpace(yamlTitle) ? null : yamlTitle, yamlHost);
    }

    private static string? SpecHost(string? url) =>
        url is not null
        && Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme is "http" or "https"
        && uri.Host.Length > 0
        && !IsLocalHost(uri.Host.ToLowerInvariant())
            ? uri.Host.ToLowerInvariant()
            : null;

    private TechnologyDefinition RegisterTechnology(TechnologyDefinition technology)
    {
        if (!_mapTechnologies.TryGetValue(technology.Id, out var existing))
        {
            _mapTechnologies[technology.Id] = technology;
            return technology;
        }
        return existing;
    }

    private TechnologyDefinition HostTechnology(string host, string? description) =>
        RegisterTechnology(new TechnologyDefinition(
            $"host:{host}",
            host,
            "external",
            description ?? "HTTP service configured by host name",
            [],
            [],
            [],
            []
        ));

    private static string? ParseHost(string value)
    {
        var text = value.Trim();
        if (text.Length == 0
            || !text.Any(char.IsLetter)
            || text.Contains('{')
            || text.Contains('%')
            || text.Contains(' ')
            || text.Contains("$(", StringComparison.Ordinal))
        {
            return null;
        }
        if (text.Contains("://", StringComparison.Ordinal))
        {
            return Uri.TryCreate(text, UriKind.Absolute, out var uri) && uri.Host.Length > 0
                ? uri.Host.ToLowerInvariant()
                : null;
        }
        var match = HostPattern.Match(text);
        return match.Success ? match.Groups["host"].Value.ToLowerInvariant() : null;
    }

    private static bool IsLocalHost(string host) =>
        host is "localhost" or "0.0.0.0" or "::1" or "[::1]" or "host.docker.internal" or "localstack" or "*" or "+"
        || host.StartsWith("127.", StringComparison.Ordinal)
        || host.EndsWith(".localhost", StringComparison.Ordinal);

    private static bool IsAwsHost(string host) =>
        host.EndsWith(".amazonaws.com", StringComparison.Ordinal)
        || host.EndsWith(".amazonaws.com.cn", StringComparison.Ordinal);

    private TechnologyDefinition? AwsEndpointTechnology(string host)
    {
        if (!IsAwsHost(host))
        {
            return null;
        }
        var labels = host.Split('.');
        string? id = labels[0] switch
        {
            "sqs" => "aws-sqs",
            "sns" => "aws-sns",
            "events" => "aws-eventbridge",
            "dynamodb" => "aws-dynamodb",
            "s3" => "aws-s3",
            "kinesis" or "firehose" => "aws-kinesis",
            "lambda" => "aws-lambda",
            "secretsmanager" => "aws-secrets-manager",
            "ssm" => "aws-ssm",
            "cognito-idp" => "aws-cognito",
            "greengrass" => "aws-greengrass",
            "iot" => "aws-iot",
            _ => null,
        };
        if (labels.Length > 1 && labels[1] == "iot" && labels[0] != "iot")
        {
            id = "aws-iot-data";
        }
        if (labels.Contains("es") || labels.Contains("aoss"))
        {
            id = "search";
        }
        if (id is null && (labels.Contains("s3") || labels[0].StartsWith("s3-", StringComparison.Ordinal)))
        {
            id = "aws-s3";
        }
        return id is null ? null : _mapTechnologies[id];
    }

    private void CollectInjections(SyntaxNode root, MapFileContext context)
    {
        foreach (var declaration in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
        {
            var members = new List<(TypeSyntax Type, string Member, SyntaxNode Node)>();
            if (declaration.ParameterList is { } primary)
            {
                members.AddRange(primary.Parameters
                    .Where(parameter => parameter.Type is not null)
                    .Select(parameter => (parameter.Type!, parameter.Identifier.ValueText, (SyntaxNode)parameter)));
            }
            foreach (var member in declaration.Members)
            {
                switch (member)
                {
                    case FieldDeclarationSyntax field:
                        members.AddRange(field.Declaration.Variables.Select(variable =>
                            (field.Declaration.Type, variable.Identifier.ValueText, (SyntaxNode)variable)));
                        break;
                    case PropertyDeclarationSyntax property:
                        members.Add((property.Type, property.Identifier.ValueText, property));
                        break;
                    case ConstructorDeclarationSyntax constructor:
                        members.AddRange(constructor.ParameterList.Parameters
                            .Where(parameter => parameter.Type is not null)
                            .Select(parameter => (parameter.Type!, parameter.Identifier.ValueText, (SyntaxNode)parameter)));
                        break;
                }
            }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var typeName = declaration.Identifier.ValueText;
            foreach (var (type, member, node) in members)
            {
                var match = MatchTypeSyntax(type, context);
                if (match is null || !seen.Add(match.Technology.Id))
                {
                    continue;
                }
                AddObservation(
                    context,
                    match.Technology,
                    null,
                    new MapEvidence(
                        context.File,
                        Line(node),
                        $"{typeName}.{member}",
                        $"{typeName} receives {match.TypeName} as {member}",
                        "injection",
                        match.Confidence,
                        match.Resolution
                    ),
                    [],
                    null,
                    null
                );
            }
        }
    }

    private void CollectInvocation(InvocationExpressionSyntax invocation, MapFileContext context)
    {
        var name = InvokedName(invocation);
        if (name is null)
        {
            return;
        }
        var methodName = name.Identifier.ValueText;
        var line = Line(name);
        var site = $"{context.File}:{Line(invocation)}";
        var methodKeys = ContainingMethodKeys(invocation, context.File);
        var methodId = ContainingMethodId(invocation, context.Model);

        var wiring = WiringKind(methodName);
        if (wiring is not null)
        {
            var types = new List<TypeSyntax>();
            if (name is GenericNameSyntax generic)
            {
                types.AddRange(generic.TypeArgumentList.Arguments);
            }
            types.AddRange(invocation.ArgumentList.Arguments
                .Select(argument => argument.Expression)
                .OfType<TypeOfExpressionSyntax>()
                .Select(expression => expression.Type));
            foreach (var type in types)
            {
                var match = MatchTypeSyntax(type, context);
                if (match is null)
                {
                    continue;
                }
                AddObservation(
                    context,
                    match.Technology,
                    QueueDirection(methodName),
                    new MapEvidence(
                        context.File,
                        line,
                        $"{methodName}<{match.TypeName}>",
                        wiring == "registration"
                            ? $"Registers {match.TypeName} with dependency injection through {methodName}"
                            : $"Resolves {match.TypeName} from dependency injection",
                        wiring,
                        match.Confidence,
                        match.Resolution
                    ),
                    methodKeys,
                    methodId,
                    site
                );
            }
        }

        if (InvocationReceiver(invocation) is { } receiver)
        {
            var (type, qualifier, declarationTree) = ReceiverType(receiver, context.Model);
            if (type is not null && !IsObservabilityName(type.Name, methodName))
            {
                var match = MatchClientType(type, qualifier, context, declarationTree);
                if (match is not null)
                {
                    AddObservation(
                        context,
                        match.Technology,
                        QueueDirection(methodName),
                        new MapEvidence(
                            context.File,
                            line,
                            $"{match.TypeName}.{methodName}",
                            $"Calls {match.TypeName}.{methodName}",
                            "call",
                            match.Confidence,
                            match.Resolution
                        ),
                        methodKeys,
                        null,
                        site
                    );
                    return;
                }
                if (type.TypeKind == TypeKind.Error
                    && type.Name.Length > 0
                    && !(receiver is IdentifierNameSyntax identifier && identifier.Identifier.ValueText == type.Name))
                {
                    _unmatchedReceivers.Add(new MapReceiver(
                        type.Name,
                        context.File,
                        declarationTree?.FilePath is { Length: > 0 } declarationPath && IsInsideRoot(declarationPath)
                            ? Relative(declarationPath)
                            : context.File,
                        context.Project.Key,
                        line,
                        methodName,
                        methodKeys,
                        site
                    ));
                }
            }
        }

        if (!methodName.StartsWith(new[] { "Add", "TryAdd", "Use", "Register", "Configure" }, StringComparer.Ordinal)
            || !IsRegistrationReceiver(invocation, context.Model))
        {
            return;
        }
        var target = ResolveSourceMethod(invocation, context);
        if (target is not null)
        {
            var calleeId = MethodId(target);
            if (methodId is not null)
            {
                if (!_helperCallsByMethod.TryGetValue(methodId, out var callees))
                {
                    _helperCallsByMethod[methodId] = callees = [];
                }
                callees.Add(calleeId);
            }
            if (_methods.TryGetValue(calleeId, out var callee)
                && MapOwner(callee.File) is { } calleeOwner
                && calleeOwner.Key != context.Project.Key)
            {
                _helperCalls.Add(new MapHelperCall(
                    context.Project.Key,
                    calleeId,
                    MethodName(target),
                    context.File,
                    line,
                    methodKeys
                ));
            }
            return;
        }
        var bound = context.Model.GetSymbolInfo(invocation);
        if (new[] { bound.Symbol }.Concat(bound.CandidateSymbols)
            .Any(symbol => symbol is not null && symbol.Locations.Any(location => location.IsInSource)))
        {
            return;
        }
        foreach (var technology in Technologies.Where(item =>
            item.Keywords.Any(keyword => ContainsKeyword(methodName, keyword))))
        {
            AddObservation(
                context,
                technology,
                QueueDirection(methodName),
                new MapEvidence(
                    context.File,
                    line,
                    methodName,
                    $"Registers {technology.Label} services through {methodName} from an external package",
                    "registration",
                    "medium",
                    "inferred"
                ),
                methodKeys,
                methodId,
                site
            );
        }
    }

    private void CollectCreation(BaseObjectCreationExpressionSyntax creation, MapFileContext context)
    {
        var match = creation is ObjectCreationExpressionSyntax explicitCreation
            ? MatchTypeSyntax(explicitCreation.Type, context)
            : MatchClientType(context.Model.GetTypeInfo(creation).Type, null, context, null);
        if (match is null)
        {
            return;
        }
        AddObservation(
            context,
            match.Technology,
            null,
            new MapEvidence(
                context.File,
                Line(creation),
                $"new {match.TypeName}",
                $"Creates {match.TypeName}",
                "registration",
                match.Confidence,
                match.Resolution
            ),
            ContainingMethodKeys(creation, context.File),
            ContainingMethodId(creation, context.Model),
            $"{context.File}:{Line(creation)}"
        );
    }

    private void AddObservation(
        MapFileContext context,
        TechnologyDefinition technology,
        string? direction,
        MapEvidence evidence,
        IReadOnlyList<string> methodKeys,
        string? methodId,
        string? siteKey
    )
    {
        var observation = new MapObservation(
            context.Project.Key,
            technology.Id,
            direction,
            evidence,
            methodKeys,
            siteKey
        );
        _mapObservations.Add(observation);
        if (methodId is not null && evidence.Kind is "registration" or "injection")
        {
            if (!_wiringByMethod.TryGetValue(methodId, out var observations))
            {
                _wiringByMethod[methodId] = observations = [];
            }
            observations.Add(observation);
        }
    }

    private TechnologyMatch? MatchTypeSyntax(TypeSyntax syntax, MapFileContext context)
    {
        var simple = syntax is NullableTypeSyntax nullable ? nullable.ElementType : syntax;
        var fallback = simple switch
        {
            QualifiedNameSyntax qualified => qualified.Right.Identifier.ValueText,
            SimpleNameSyntax name => name.Identifier.ValueText,
            _ => null,
        };
        return MatchClientType(
            context.Model.GetTypeInfo(syntax).Type,
            Qualifier(syntax),
            context,
            null,
            fallback
        );
    }

    private TechnologyMatch? MatchClientType(
        ITypeSymbol? type,
        string? qualifier,
        MapFileContext context,
        SyntaxTree? declarationTree,
        string? fallbackName = null
    )
    {
        if (type is IArrayTypeSymbol or IPointerTypeSymbol or ITypeParameterSymbol)
        {
            return null;
        }
        var name = type?.Name is { Length: > 0 } typeName ? typeName : fallbackName;
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }
        if (_generatedClients.TryGetValue(name, out var generated))
        {
            return new TechnologyMatch(_mapTechnologies[generated], name, "high", "direct");
        }
        if (type is INamedTypeSymbol named
            && named.TypeKind != TypeKind.Error
            && named.Locations.Any(location => location.IsInSource))
        {
            var declaration = named.DeclaringSyntaxReferences.FirstOrDefault()?.SyntaxTree;
            foreach (var ancestor in TypeHierarchy(named).Skip(1))
            {
                var inherited = ancestor.TypeKind == TypeKind.Error
                    ? MatchCatalogType(ancestor.Name, ErrorNamespace(ancestor), context, declaration)
                    : ancestor.Locations.Any(location => location.IsInSource)
                        ? null
                        : MatchCatalogType(ancestor.Name, NamespaceName(ancestor), context, declaration);
                if (inherited is not null)
                {
                    return inherited with { TypeName = name };
                }
            }
            return null;
        }
        if (type is not null && type.TypeKind != TypeKind.Error)
        {
            return MatchCatalogType(name, NamespaceName(type), context, declarationTree);
        }
        return MatchCatalogType(name, qualifier ?? ErrorNamespace(type), context, declarationTree);
    }

    private TechnologyMatch? MatchCatalogType(
        string name,
        string? ns,
        MapFileContext context,
        SyntaxTree? declarationTree
    )
    {
        foreach (var technology in Technologies)
        {
            if (!technology.ClientTypes.Contains(name, StringComparer.Ordinal))
            {
                continue;
            }
            if (ns is not null)
            {
                if (technology.Namespaces.Any(candidate => NamespaceWithin(ns, candidate)))
                {
                    return new TechnologyMatch(technology, name, "high", "direct");
                }
                continue;
            }
            if (ImportsTechnology(technology, context, declarationTree))
            {
                return new TechnologyMatch(technology, name, "high", "direct");
            }
        }
        return null;
    }

    private bool ImportsTechnology(
        TechnologyDefinition technology,
        MapFileContext context,
        SyntaxTree? declarationTree
    )
    {
        IEnumerable<string> usings = context.Usings;
        if (declarationTree?.FilePath is { Length: > 0 } path
            && _usingsByFile.TryGetValue(Relative(path), out var declared))
        {
            usings = usings.Concat(declared);
        }
        return usings.Any(item =>
            technology.Namespaces.Any(candidate => NamespaceWithin(item, candidate))
            || TechnologyForNamespace(item)?.Id == technology.Id
        );
    }

    private static bool NamespaceWithin(string ns, string candidate) =>
        ns == candidate || ns.StartsWith($"{candidate}.", StringComparison.Ordinal);

    private static string NamespaceName(ITypeSymbol type) =>
        type.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : "";

    private static string? ErrorNamespace(ITypeSymbol? type) =>
        type?.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : null;

    private static string? Qualifier(TypeSyntax syntax) => syntax switch
    {
        NullableTypeSyntax nullable => Qualifier(nullable.ElementType),
        QualifiedNameSyntax qualified => qualified.Left.ToString().Replace("global::", "", StringComparison.Ordinal),
        _ => null,
    };

    private static TechnologyDefinition? TechnologyForNamespace(string ns)
    {
        foreach (var technology in Technologies)
        {
            if (technology.Namespaces.Any(candidate => NamespaceWithin(ns, candidate)))
            {
                return technology;
            }
        }
        if (ns.StartsWith("Microsoft.", StringComparison.Ordinal)
            || ns.StartsWith("System.", StringComparison.Ordinal)
            || ns.StartsWith("Amazon.", StringComparison.Ordinal))
        {
            return null;
        }
        return Technologies.FirstOrDefault(technology =>
            technology.Keywords.Any(keyword => ContainsKeyword(ns, keyword))
        );
    }

    private static bool ContainsKeyword(string value, string keyword)
    {
        for (var index = value.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
            index >= 0;
            index = value.IndexOf(keyword, index + 1, StringComparison.OrdinalIgnoreCase))
        {
            var end = index + keyword.Length;
            var startsWord = index == 0 || !char.IsLetter(value[index - 1]) || char.IsUpper(value[index]);
            var endsWord = end == value.Length || !char.IsLower(value[end]);
            if (startsWord && endsWord)
            {
                return true;
            }
        }
        return false;
    }

    private static SimpleNameSyntax? InvokedName(InvocationExpressionSyntax invocation) => invocation.Expression switch
    {
        MemberAccessExpressionSyntax member => member.Name,
        MemberBindingExpressionSyntax binding => binding.Name,
        SimpleNameSyntax simple => simple,
        _ => null,
    };

    private static ExpressionSyntax? InvocationReceiver(InvocationExpressionSyntax invocation) => invocation.Expression switch
    {
        MemberAccessExpressionSyntax member => member.Expression,
        MemberBindingExpressionSyntax => invocation.Ancestors()
            .OfType<ConditionalAccessExpressionSyntax>()
            .FirstOrDefault()
            ?.Expression,
        _ => null,
    };

    private static (ITypeSymbol? Type, string? Qualifier, SyntaxTree? DeclarationTree) ReceiverType(
        ExpressionSyntax receiver,
        SemanticModel model
    )
    {
        var symbol = model.GetSymbolInfo(receiver).Symbol;
        ITypeSymbol? declaredType = symbol switch
        {
            IFieldSymbol field => field.Type,
            IPropertySymbol property => property.Type,
            IParameterSymbol parameter => parameter.Type,
            ILocalSymbol local => local.Type,
            _ => null,
        };
        var declaration = symbol?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
        var typeSyntax = declaration switch
        {
            VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax variable } => variable.Type,
            PropertyDeclarationSyntax property => property.Type,
            ParameterSyntax parameter => parameter.Type,
            _ => null,
        };
        var type = declaredType ?? model.GetTypeInfo(receiver).Type;
        if (type is null || type is { TypeKind: TypeKind.Error, Name.Length: 0 })
        {
            var source = declaration is VariableDeclaratorSyntax { Initializer.Value: { } initializer }
                ? initializer
                : receiver;
            type = AwaitedType(source, model) ?? type;
        }
        var qualifier = typeSyntax is null || typeSyntax.IsVar ? null : Qualifier(typeSyntax);
        return (type, qualifier, declaration?.SyntaxTree);
    }

    private static ITypeSymbol? AwaitedType(ExpressionSyntax expression, SemanticModel model)
    {
        while (expression is ParenthesizedExpressionSyntax parenthesized)
        {
            expression = parenthesized.Expression;
        }
        if (expression is not AwaitExpressionSyntax awaited)
        {
            return null;
        }
        var task = awaited.Expression;
        if (task is InvocationExpressionSyntax
            {
                Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ConfigureAwait" } configure,
            })
        {
            task = configure.Expression;
        }
        return model.GetTypeInfo(task).Type is INamedTypeSymbol { Name: "Task" or "ValueTask", TypeArguments.Length: 1 } named
            ? named.TypeArguments[0]
            : null;
    }

    private static string[] ContainingMethodKeys(SyntaxNode node, string file) =>
        node.Ancestors()
            .Where(item => item is MethodDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax)
            .Select(item => $"{file}:{Line(item)}")
            .ToArray();

    private static string? ContainingMethodId(SyntaxNode node, SemanticModel model)
    {
        var declaration = node.Ancestors()
            .FirstOrDefault(item => item is MethodDeclarationSyntax or LocalFunctionStatementSyntax);
        return declaration is not null && model.GetDeclaredSymbol(declaration) is IMethodSymbol method
            ? MethodId(method.OriginalDefinition)
            : null;
    }

    private static bool IsRegistrationReceiver(InvocationExpressionSyntax invocation, SemanticModel model) =>
        IsRegistrationExpression(InvocationReceiver(invocation), model)
        || invocation.ArgumentList.Arguments.Any(argument => IsRegistrationExpression(argument.Expression, model));

    private static bool IsRegistrationExpression(ExpressionSyntax? receiver, SemanticModel model)
    {
        while (receiver is not null)
        {
            var type = model.GetTypeInfo(receiver).Type;
            if (type is not null && RegistrationReceiverTypes.Contains(type.Name, StringComparer.Ordinal))
            {
                return true;
            }
            if (type is not null && type.TypeKind != TypeKind.Error)
            {
                return false;
            }
            switch (receiver)
            {
                case IdentifierNameSyntax identifier:
                    return RegistrationReceiverNames.Contains(identifier.Identifier.ValueText, StringComparer.OrdinalIgnoreCase);
                case MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Services" }:
                    return true;
                case InvocationExpressionSyntax inner:
                    receiver = InvocationReceiver(inner);
                    break;
                default:
                    return false;
            }
        }
        return false;
    }

    private static string? WiringKind(string methodName)
    {
        if (methodName.StartsWith(new[] { "Add", "TryAdd", "Register", "Replace" }, StringComparer.Ordinal))
        {
            return "registration";
        }
        return methodName is "GetService" or "GetRequiredService" or "GetKeyedService" or "GetRequiredKeyedService"
            or "Resolve" or "ResolveOptional" or "ResolveNamed" or "ResolveKeyed"
            ? "injection"
            : null;
    }

    private static string? QueueDirection(string methodName)
    {
        if (methodName.StartsWith(
                new[] { "Receive", "Subscribe", "Consume", "Poll", "Listen", "StartProcessing", "DeleteMessage", "ChangeMessageVisibility" },
                StringComparer.Ordinal)
            || methodName.Contains(
                new[] { "Listener", "Consumer", "Subscriber", "Subscription", "Receiver", "Processor" },
                StringComparer.Ordinal))
        {
            return "consumes";
        }
        if (methodName.StartsWith(new[] { "Publish", "Send", "Put", "Enqueue", "Produce" }, StringComparer.Ordinal)
            || methodName.Contains(new[] { "Publisher", "Producer", "Sender" }, StringComparer.Ordinal))
        {
            return "publishes";
        }
        return null;
    }

    private static bool IsObservabilityName(string typeName, string methodName) =>
        typeName.Contains(
            new[] { "Logger", "Logging", "Metric", "Telemetry", "Tracer", "Statsd" },
            StringComparer.OrdinalIgnoreCase
        )
        || methodName.StartsWith(
            new[] { "Log", "Histogram", "Gauge", "Increment", "Decrement", "Counter", "Timing" },
            StringComparer.Ordinal
        );

    private IMethodSymbol? ResolveSourceMethod(InvocationExpressionSyntax invocation, MapFileContext context)
    {
        var info = context.Model.GetSymbolInfo(invocation);
        foreach (var candidate in new[] { info.Symbol }.Concat(info.CandidateSymbols).OfType<IMethodSymbol>())
        {
            var symbol = (candidate.ReducedFrom ?? candidate).OriginalDefinition;
            if (_methods.ContainsKey(MethodId(symbol)))
            {
                return symbol;
            }
        }
        if (invocation.Expression is not MemberAccessExpressionSyntax member)
        {
            return null;
        }
        _extensionMethods ??= _methods.Values
            .Where(method => method.Symbol.IsExtensionMethod)
            .GroupBy(method => method.Symbol.Name, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.Select(method => method.Symbol).ToList(),
                StringComparer.Ordinal
            );
        if (!_extensionMethods.TryGetValue(member.Name.Identifier.ValueText, out var candidates))
        {
            return null;
        }
        var count = invocation.ArgumentList.Arguments.Count;
        var matches = candidates
            .Where(method =>
            {
                var parameters = method.Parameters.Skip(1).ToArray();
                var required = parameters.Count(parameter => !parameter.IsOptional && !parameter.IsParams);
                return count >= required
                    && (count <= parameters.Length || parameters.Any(parameter => parameter.IsParams));
            })
            .ToArray();
        var local = matches
            .Where(method => _methods.TryGetValue(MethodId(method), out var node)
                && MapOwner(node.File)?.Key == context.Project.Key)
            .ToArray();
        if (local.Length == 1)
        {
            return local[0];
        }
        return matches.Length == 1 ? matches[0] : null;
    }

    private void InferWrapperTechnologies()
    {
        foreach (var group in _unmatchedReceivers
            .GroupBy(receiver => receiver.TypeName, StringComparer.Ordinal)
            .OrderBy(group => group.Key, StringComparer.Ordinal))
        {
            if (ProvenanceDenylist.Contains(group.Key)
                || !ClientSuffixes.Any(suffix => group.Key.EndsWith(suffix, StringComparison.Ordinal)))
            {
                continue;
            }
            var named = Technologies
                .Where(technology => technology.Keywords.Any(keyword => ContainsKeyword(group.Key, keyword)))
                .ToArray();
            TechnologyDefinition? technology;
            string because;
            if (named.Length > 0)
            {
                if (named.Length > 1)
                {
                    continue;
                }
                technology = named[0];
                because = $"the type name names {technology.Label}";
            }
            else
            {
                HashSet<string>? common = null;
                foreach (var file in group.Select(receiver => receiver.DeclarationFile).Distinct(StringComparer.Ordinal))
                {
                    var external = (_externalUsingsByFile.GetValueOrDefault(file) ?? [])
                        .Where(ns => !PlumbingNamespaces.Any(plumbing => NamespaceWithin(ns, plumbing)));
                    if (common is null)
                    {
                        common = new HashSet<string>(external, StringComparer.Ordinal);
                    }
                    else
                    {
                        common.IntersectWith(external);
                    }
                }
                if (common is null || common.Count == 0)
                {
                    continue;
                }
                var origins = common
                    .Select(ns => TechnologyForNamespace(ns)?.Id)
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                if (origins.Length != 1 || origins[0] is not { } id)
                {
                    continue;
                }
                technology = _mapTechnologies[id];
                var namespaces = string.Join(", ", common.OrderBy(ns => ns, StringComparer.Ordinal));
                because = $"every file that declares {group.Key} imports {namespaces} and no other external package namespace";
            }
            foreach (var receiver in group)
            {
                _mapObservations.Add(new MapObservation(
                    receiver.ProjectKey,
                    technology.Id,
                    QueueDirection(receiver.MethodName),
                    new MapEvidence(
                        receiver.File,
                        receiver.Line,
                        $"{receiver.TypeName}.{receiver.MethodName}",
                        $"Calls {receiver.TypeName}.{receiver.MethodName}; {because}",
                        "call",
                        "medium",
                        "inferred"
                    ),
                    receiver.MethodKeys,
                    receiver.SiteKey
                ));
            }
        }
    }

    private void AttributeRegistrationHelpers()
    {
        var added = new HashSet<string>(StringComparer.Ordinal);
        foreach (var call in _helperCalls)
        {
            var visited = new HashSet<string>(StringComparer.Ordinal);
            var pending = new Stack<(string Method, int Depth)>();
            pending.Push((call.CalleeId, 0));
            while (pending.Count > 0)
            {
                var (method, depth) = pending.Pop();
                if (!visited.Add(method))
                {
                    continue;
                }
                foreach (var observation in _wiringByMethod.GetValueOrDefault(method) ?? [])
                {
                    var technology = _mapTechnologies[observation.TechnologyId];
                    if (observation.ProjectKey == call.ProjectKey
                        || !added.Add($"{call.ProjectKey}\0{call.File}\0{call.Line}\0{technology.Id}\0{observation.Direction}"))
                    {
                        continue;
                    }
                    _mapObservations.Add(new MapObservation(
                        call.ProjectKey,
                        technology.Id,
                        observation.Direction,
                        new MapEvidence(
                            call.File,
                            call.Line,
                            call.CalleeName,
                            $"Wires {technology.Label} through {call.CalleeName} ({observation.Evidence.File}:{observation.Evidence.Line})",
                            "registration",
                            observation.Evidence.Confidence,
                            "inferred"
                        ),
                        call.MethodKeys,
                        null
                    ));
                }
                if (depth < 3)
                {
                    foreach (var next in _helperCallsByMethod.GetValueOrDefault(method) ?? [])
                    {
                        pending.Push((next, depth + 1));
                    }
                }
            }
        }
    }

    private void CollectProjectDeclarations()
    {
        foreach (var project in _mapProjects.Where(item => !item.IsTest))
        {
            foreach (var package in project.Packages)
            {
                var exact = Technologies
                    .Where(technology => technology.Packages.Any(id => id.Equals(package.Id, StringComparison.OrdinalIgnoreCase)))
                    .ToArray();
                var matches = exact.Length > 0
                    || package.Id.StartsWith("AWSSDK.", StringComparison.OrdinalIgnoreCase)
                    || package.Id.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase)
                    || package.Id.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    ? exact
                    : Technologies
                        .Where(technology => technology.Keywords.Any(keyword => ContainsKeyword(package.Id, keyword)))
                        .ToArray();
                foreach (var technology in matches)
                {
                    AddDeclaration(project, technology, new MapEvidence(
                        project.File,
                        package.Line,
                        package.Id,
                        exact.Length > 0
                            ? $"References the {technology.Label} SDK package {package.Id}"
                            : $"References package {package.Id}",
                        "package",
                        exact.Length > 0 ? "medium" : "low",
                        "direct"
                    ));
                }
            }
            foreach (var reference in project.OpenApiReferences)
            {
                if (_generatedClients.TryGetValue(reference.ClassName, out var id))
                {
                    AddDeclaration(project, _mapTechnologies[id], new MapEvidence(
                        project.File,
                        reference.Line,
                        reference.ClassName,
                        $"Generates {reference.ClassName} from {reference.Spec}",
                        "generated-client",
                        "medium",
                        "direct"
                    ));
                }
            }
        }
        foreach (var entry in _configEntries)
        {
            if (entry.Path.Split('.').Any(section =>
                    IgnoredConfigSections.Contains(section.TrimEnd('[', ']'), StringComparer.OrdinalIgnoreCase)))
            {
                continue;
            }
            var host = ParseHost(entry.Value);
            if (host is null || IsLocalHost(host))
            {
                continue;
            }
            var technology = AwsEndpointTechnology(host);
            if (technology is null && IsAwsHost(host))
            {
                continue;
            }
            AddDeclaration(entry.Project, technology ?? HostTechnology(host, null), new MapEvidence(
                entry.File,
                entry.Line,
                entry.Path,
                $"Configuration sets {entry.Path} to {entry.Value}",
                "configuration",
                "medium",
                "direct"
            ));
        }
    }

    private void AddDeclaration(MapProject project, TechnologyDefinition technology, MapEvidence evidence) =>
        _mapObservations.Add(new MapObservation(project.Key, technology.Id, null, evidence, [], null));
}
