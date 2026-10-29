internal sealed partial class RepositoryAnalyzer
{
    private sealed class MapNode(
        string key,
        string kind,
        string label,
        string name,
        string? service,
        string? description,
        GraphSource? source
    )
    {
        public string Key { get; } = key;
        public string Id { get; } = GraphId(kind, key);
        public string Kind { get; } = kind;
        public string Label { get; } = label;
        public string Name { get; } = name;
        public string? Service { get; } = service;
        public string? Description { get; } = description;
        public GraphSource? Source { get; set; } = source;
        public string Confidence { get; set; } = "high";
        public string Resolution { get; set; } = "direct";
        public HashSet<string> FlowIds { get; } = new(StringComparer.Ordinal);
    }

    private sealed class MapEdge(MapNode source, MapNode target, string kind)
    {
        public string Id { get; } = GraphId("edge", $"{source.Key}\0{kind}\0{target.Key}");
        public MapNode Source { get; } = source;
        public MapNode Target { get; } = target;
        public string Kind { get; } = kind;
        public List<MapEvidence> Evidence { get; } = [];
        public HashSet<string> EvidenceKeys { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Methods { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Sites { get; } = new(StringComparer.Ordinal);
        public HashSet<string> CallFiles { get; } = new(StringComparer.Ordinal);
        public HashSet<string> FlowIds { get; } = new(StringComparer.Ordinal);
    }

    private ArchitectureGraph BuildArchitectureGraph(IReadOnlyList<Flow> flows)
    {
        var warnings = new List<AnalyzerWarning>(_mapWarnings);
        var projects = _mapProjects.Where(project => !project.IsTest).ToArray();
        var labels = ProjectLabels(projects);
        var referenced = projects
            .SelectMany(project => project.References)
            .Select(reference => reference.TargetFile)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var nodes = new Dictionary<string, MapNode>(StringComparer.Ordinal);
        var edges = new Dictionary<string, MapEdge>(StringComparer.Ordinal);

        foreach (var project in projects.OrderBy(item => item.File, StringComparer.Ordinal))
        {
            var name = project.Service?.Name ?? project.Name;
            var description = project.Service is not null
                ? project.Service.Kind == "api-service" ? "ASP.NET web project" : "Runnable .NET application"
                : referenced.Contains(project.File) ? "Class library referenced by other projects" : "Class library";
            nodes[project.Key] = new MapNode(
                project.Key,
                project.Kind,
                labels[project.Key],
                name,
                project.Service?.Name,
                description,
                new GraphSource(project.Service?.EntryFile ?? project.File, 1, name)
            );
        }

        var observations = RetargetEntityFramework(_mapObservations);
        var searchLabel = observations.Any(item =>
                item.TechnologyId == "search"
                && $"{item.Evidence.Symbol} {item.Evidence.Reason}".Contains("OpenSearch", StringComparison.OrdinalIgnoreCase))
            ? "OpenSearch"
            : "Elasticsearch";
        foreach (var group in observations
            .GroupBy(item => (item.ProjectKey, item.TechnologyId))
            .OrderBy(group => group.Key.ProjectKey, StringComparer.Ordinal)
            .ThenBy(group => group.Key.TechnologyId, StringComparer.Ordinal))
        {
            if (!nodes.TryGetValue(group.Key.ProjectKey, out var projectNode))
            {
                continue;
            }
            var technology = _mapTechnologies[group.Key.TechnologyId];
            var technologyKey = $"technology:{technology.Id}";
            if (!nodes.TryGetValue(technologyKey, out var technologyNode))
            {
                var label = technology.Id == "search" ? searchLabel : technology.Label;
                technologyNode = new MapNode(technologyKey, technology.Kind, label, label, null, technology.Description, null);
                nodes[technologyKey] = technologyNode;
            }
            var directions = group
                .Select(item => item.Direction)
                .OfType<string>()
                .ToHashSet(StringComparer.Ordinal);
            foreach (var observation in group)
            {
                var kind = technology.Kind switch
                {
                    "database" => "queries",
                    "queue" => observation.Direction
                        ?? (directions.Contains("publishes") ? "publishes"
                            : directions.Contains("consumes") ? "consumes"
                            : "uses"),
                    _ => "calls_external",
                };
                var edge = MapEdgeFor(edges, projectNode, technologyNode, kind);
                AddEdgeEvidence(edge, observation.Evidence);
                edge.Methods.UnionWith(observation.MethodKeys);
                if (observation.SiteKey is not null)
                {
                    edge.Sites.Add(observation.SiteKey);
                }
                if (observation.Evidence.Kind == "call")
                {
                    edge.CallFiles.Add(observation.Evidence.File);
                }
            }
        }

        foreach (var project in projects)
        {
            foreach (var reference in project.References)
            {
                var target = projects.FirstOrDefault(item =>
                    item.File.Equals(reference.TargetFile, StringComparison.OrdinalIgnoreCase)
                );
                if (target is null || target.Key == project.Key)
                {
                    continue;
                }
                AddEdgeEvidence(
                    MapEdgeFor(edges, nodes[project.Key], nodes[target.Key], "references"),
                    new MapEvidence(
                        project.File,
                        reference.Line,
                        target.Name,
                        $"{project.Name} references project {target.Name}",
                        "project-reference",
                        "high",
                        "direct"
                    )
                );
            }
        }

        foreach (var flow in flows.OrderBy(item => item.Id, StringComparer.Ordinal))
        {
            var trigger = flow.Steps[0];
            var owner = MapOwner(trigger.File) is { IsTest: false } candidate
                ? candidate
                : projects.FirstOrDefault(item => item.Service?.Name == flow.Service);
            if (owner is null || !nodes.TryGetValue(owner.Key, out var ownerNode))
            {
                continue;
            }
            ownerNode.FlowIds.Add(flow.Id);
            var entryKey = $"entrypoint:{owner.Key}\0{flow.Trigger.Kind}\0{flow.Trigger.Label}";
            if (!nodes.TryGetValue(entryKey, out var entry))
            {
                entry = new MapNode(
                    entryKey,
                    "entrypoint",
                    flow.Trigger.Label,
                    flow.Trigger.Label,
                    flow.Service,
                    flow.Trigger.Kind == "queue" ? "Queue message handled by this project" : "HTTP route handled by this project",
                    new GraphSource(trigger.File, trigger.Line, trigger.Symbol)
                )
                {
                    Confidence = trigger.Confidence,
                };
                nodes[entryKey] = entry;
            }
            entry.FlowIds.Add(flow.Id);
            var handles = MapEdgeFor(edges, entry, ownerNode, "handles");
            AddEdgeEvidence(handles, new MapEvidence(
                trigger.File,
                trigger.Line,
                trigger.Symbol,
                "Roslyn linked this trigger to its source handler",
                "route",
                trigger.Confidence,
                "direct"
            ));
            handles.FlowIds.Add(flow.Id);
        }

        var byMethod = IndexEdges(edges.Values, edge => edge.Methods);
        var bySite = IndexEdges(edges.Values, edge => edge.Sites);
        var byFile = IndexEdges(edges.Values, edge => edge.CallFiles);
        foreach (var flow in flows.OrderBy(item => item.Id, StringComparer.Ordinal))
        {
            var linked = new HashSet<MapEdge>();
            foreach (var step in flow.Steps.Concat(flow.Branches?.SelectMany(branch => branch) ?? []))
            {
                var key = $"{step.File}:{step.Line}";
                if (step.Kind is "handler" or "call")
                {
                    linked.UnionWith(byMethod.GetValueOrDefault(key) ?? []);
                }
                else
                {
                    linked.UnionWith(bySite.GetValueOrDefault(key) ?? []);
                    if (_boundaryImplementations.TryGetValue(key, out var implementation))
                    {
                        linked.UnionWith(byFile.GetValueOrDefault(implementation) ?? []);
                    }
                }
                if (MapOwner(step.File) is { IsTest: false } touched
                    && nodes.TryGetValue(touched.Key, out var touchedNode))
                {
                    touchedNode.FlowIds.Add(flow.Id);
                }
            }
            foreach (var edge in linked)
            {
                edge.FlowIds.Add(flow.Id);
                edge.Target.FlowIds.Add(flow.Id);
            }
        }

        var graphEdges = edges.Values
            .Select(edge => (Edge: edge, Graph: ToGraphEdge(edge)))
            .ToArray();
        foreach (var node in nodes.Values.Where(node => node.Kind is "database" or "queue" or "external"))
        {
            var best = graphEdges
                .Where(item => item.Edge.Target == node)
                .Select(item => item.Graph)
                .OrderByDescending(edge => ConfidenceRank(edge.Confidence))
                .ThenBy(edge => StrengthOrder(edge.Strength))
                .ThenBy(edge => edge.Resolution == "direct" ? 0 : 1)
                .ThenBy(edge => edge.Id, StringComparer.Ordinal)
                .FirstOrDefault();
            if (best is null)
            {
                continue;
            }
            node.Confidence = best.Confidence;
            node.Resolution = best.Resolution;
            var evidence = best.Evidence
                .OrderBy(item => EvidenceStrength(item.Kind) == best.Strength ? 0 : 1)
                .ThenByDescending(item => ConfidenceRank(item.Confidence))
                .ThenBy(item => item.Resolution == "direct" ? 0 : 1)
                .First();
            node.Source = new GraphSource(evidence.File, evidence.Line, evidence.Symbol);
        }

        var orderedNodes = nodes.Values
            .OrderBy(node => NodeOrder(node.Kind))
            .ThenBy(node => node.Label, StringComparer.Ordinal)
            .ThenBy(node => node.Id, StringComparer.Ordinal)
            .Take(MaxMapNodes)
            .ToArray();
        var included = orderedNodes.Select(node => node.Id).ToHashSet(StringComparer.Ordinal);
        var orderedEdges = graphEdges
            .Select(item => item.Graph)
            .Where(edge => included.Contains(edge.Source) && included.Contains(edge.Target))
            .OrderBy(edge => edge.Source, StringComparer.Ordinal)
            .ThenBy(edge => edge.Kind, StringComparer.Ordinal)
            .ThenBy(edge => edge.Target, StringComparer.Ordinal)
            .Take(MaxMapEdges)
            .ToArray();
        if (nodes.Count > orderedNodes.Length || graphEdges.Length > orderedEdges.Length)
        {
            warnings.Add(new AnalyzerWarning(
                "graph-cap-reached",
                $"Architecture graph was limited to {MaxMapNodes} nodes and {MaxMapEdges} edges.",
                null,
                null
            ));
        }

        var linkedFlows = orderedNodes
            .SelectMany(node => node.FlowIds)
            .Concat(orderedEdges.SelectMany(edge => edge.FlowIds))
            .ToHashSet(StringComparer.Ordinal);
        var dependencyEdges = graphEdges
            .Where(item => item.Graph.Kind is not ("handles" or "references"))
            .Where(item => included.Contains(item.Graph.Source) && included.Contains(item.Graph.Target))
            .ToArray();
        var summary = new GraphSummary(
            orderedNodes.Count(node => node.Kind == "service"),
            orderedNodes.Count(node => node.Kind == "library"),
            orderedNodes.Count(node => node.Kind is "database" or "queue" or "external"),
            dependencyEdges
                .SelectMany(item => item.Edge.Evidence)
                .Where(evidence => evidence.Kind == "call")
                .Select(evidence => $"{evidence.File}:{evidence.Line}")
                .Distinct(StringComparer.Ordinal)
                .Count(),
            dependencyEdges.Sum(item => item.Graph.EvidenceCount)
        );

        return new ArchitectureGraph(
            "2.0.0",
            summary,
            orderedNodes.Select(node => new GraphNode(
                node.Id,
                node.Kind,
                node.Label,
                node.Name,
                node.Service,
                node.Description,
                node.Confidence,
                node.Resolution,
                node.Source,
                node.FlowIds.OrderBy(id => id, StringComparer.Ordinal).ToArray()
            )).ToArray(),
            orderedEdges,
            flows
                .Where(flow => linkedFlows.Contains(flow.Id))
                .OrderBy(flow => flow.Id, StringComparer.Ordinal)
                .Select(flow => new GraphFlowLink(flow.Id, flow.Trigger.Label, flow.Service))
                .ToArray(),
            warnings
                .OrderBy(item => item.File, StringComparer.Ordinal)
                .ThenBy(item => item.Line)
                .ThenBy(item => item.Code, StringComparer.Ordinal)
                .ToArray()
        );
    }

    private static MapEdge MapEdgeFor(
        Dictionary<string, MapEdge> edges,
        MapNode source,
        MapNode target,
        string kind
    )
    {
        var key = $"{source.Key}\0{kind}\0{target.Key}";
        if (!edges.TryGetValue(key, out var edge))
        {
            edge = new MapEdge(source, target, kind);
            edges[key] = edge;
        }
        return edge;
    }

    private static void AddEdgeEvidence(MapEdge edge, MapEvidence evidence)
    {
        if (edge.EvidenceKeys.Add($"{evidence.File}\0{evidence.Line}\0{evidence.Symbol}\0{evidence.Kind}"))
        {
            edge.Evidence.Add(evidence);
        }
    }

    private static Dictionary<string, List<MapEdge>> IndexEdges(
        IEnumerable<MapEdge> edges,
        Func<MapEdge, IEnumerable<string>> keys
    )
    {
        var index = new Dictionary<string, List<MapEdge>>(StringComparer.Ordinal);
        foreach (var edge in edges)
        {
            foreach (var key in keys(edge))
            {
                if (!index.TryGetValue(key, out var list))
                {
                    index[key] = list = [];
                }
                list.Add(edge);
            }
        }
        return index;
    }

    private static GraphEdge ToGraphEdge(MapEdge edge)
    {
        var evidence = edge.Evidence
            .OrderBy(item => EvidenceOrder(item.Kind))
            .ThenBy(item => item.File, StringComparer.Ordinal)
            .ThenBy(item => item.Line)
            .ThenBy(item => item.Symbol, StringComparer.Ordinal)
            .ToArray();
        var strength = evidence.Select(item => EvidenceStrength(item.Kind)).OrderBy(StrengthOrder).First();
        var strongest = evidence.Where(item => EvidenceStrength(item.Kind) == strength).ToArray();
        return new GraphEdge(
            edge.Id,
            edge.Source.Id,
            edge.Target.Id,
            edge.Kind,
            strength,
            strongest.Select(item => item.Confidence).OrderByDescending(ConfidenceRank).First(),
            strongest.Any(item => item.Resolution == "direct") ? "direct" : "inferred",
            evidence.Length,
            evidence
                .Take(MaxEvidencePerEdge)
                .Select(item => new GraphEvidence(
                    item.File,
                    item.Line,
                    item.Symbol,
                    item.Reason,
                    item.Kind,
                    item.Confidence,
                    item.Resolution
                ))
                .ToArray(),
            edge.FlowIds.OrderBy(id => id, StringComparer.Ordinal).ToArray()
        );
    }

    private static string EvidenceStrength(string kind) => kind switch
    {
        "call" or "route" => "call",
        "registration" or "injection" or "configuration" => "wiring",
        _ => "declaration",
    };

    private static int StrengthOrder(string strength) => strength switch
    {
        "call" => 0,
        "wiring" => 1,
        _ => 2,
    };

    private static int EvidenceOrder(string kind) => kind switch
    {
        "call" => 0,
        "route" => 1,
        "registration" => 2,
        "injection" => 3,
        "configuration" => 4,
        "generated-client" => 5,
        "package" => 6,
        _ => 7,
    };

    private static int NodeOrder(string kind) => kind switch
    {
        "service" => 0,
        "library" => 1,
        "database" or "queue" or "external" => 2,
        _ => 3,
    };

    private static int ConfidenceRank(string confidence) => confidence switch
    {
        "high" => 3,
        "medium" => 2,
        _ => 1,
    };

    private static Dictionary<string, string> ProjectLabels(IReadOnlyList<MapProject> projects)
    {
        var names = projects.ToDictionary(
            project => project.Key,
            project => project.Service?.Name ?? project.Name,
            StringComparer.Ordinal
        );
        var segments = names.Values.Select(name => name.Split('.')).ToArray();
        var prefix = 0;
        if (segments.Length >= 2)
        {
            while (segments.All(parts => parts.Length > prefix + 1)
                && segments.All(parts => parts[prefix] == segments[0][prefix]))
            {
                prefix++;
            }
        }
        return names.ToDictionary(
            item => item.Key,
            item => prefix == 0 ? item.Value : string.Join('.', item.Value.Split('.').Skip(prefix)),
            StringComparer.Ordinal
        );
    }

    private static List<MapObservation> RetargetEntityFramework(List<MapObservation> observations)
    {
        var providers = observations
            .Select(item => item.TechnologyId)
            .Where(id => id is "sqlserver" or "postgresql" or "mysql" or "sqlite")
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return providers.Length == 1
            ? observations
                .Select(item => item.TechnologyId == "efcore" ? item with { TechnologyId = providers[0] } : item)
                .ToList()
            : observations;
    }
}
