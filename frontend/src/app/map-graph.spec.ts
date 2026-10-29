import {
  ArchitectureEdge,
  ArchitectureGraph,
  ArchitectureNode,
  EvidenceStrength,
  GraphEdgeKind,
  GraphNodeKind,
} from './architecture-graph.types';
import { liftLibraryEdges, servicesUsing, sharedTechnologies, visibleMap } from './map-graph';

function node(id: string, kind: GraphNodeKind, label: string): ArchitectureNode {
  return {
    id,
    kind,
    label,
    name: `Shop.${label}`,
    service: null,
    description: null,
    confidence: 'high',
    resolution: 'direct',
    flow_ids: [],
    source: null,
  };
}

function edge(
  source: string,
  kind: GraphEdgeKind,
  target: string,
  strength: EvidenceStrength = 'call',
  extra: Partial<ArchitectureEdge> = {},
): ArchitectureEdge {
  return {
    id: `edge:${source}:${kind}:${target}`,
    source,
    target,
    kind,
    strength,
    confidence: 'high',
    resolution: 'direct',
    evidence_count: 1,
    flow_ids: [],
    evidence: [
      {
        file: `${source}.cs`,
        line: 1,
        symbol: `${source}->${target}`,
        reason: 'fixture',
        kind: strength === 'call' ? 'call' : 'registration',
        confidence: 'high',
        resolution: 'direct',
      },
    ],
    ...extra,
  };
}

const graph: ArchitectureGraph = {
  schema_version: '2.0.0',
  analysis: { mode: 'study', completeness: 'partial' },
  summary: { services: 2, libraries: 2, technologies: 2, call_sites: 4, evidence_items: 9 },
  nodes: [
    node('api', 'service', 'Api'),
    node('worker', 'service', 'Worker'),
    node('data', 'library', 'Data'),
    node('core', 'library', 'Core'),
    node('dynamo', 'database', 'Amazon DynamoDB'),
    node('sqs', 'queue', 'Amazon SQS'),
    node('get-orders', 'entrypoint', 'GET /orders'),
    node('core-job', 'entrypoint', 'queue orders'),
  ],
  edges: [
    edge('get-orders', 'handles', 'api'),
    edge('core-job', 'handles', 'core'),
    edge('api', 'references', 'data', 'declaration'),
    edge('worker', 'references', 'core', 'declaration'),
    edge('core', 'references', 'data', 'declaration'),
    edge('data', 'queries', 'dynamo', 'call', { evidence_count: 3, flow_ids: ['flow-b'] }),
    edge('api', 'queries', 'dynamo', 'wiring', { flow_ids: ['flow-a'] }),
    edge('api', 'publishes', 'sqs'),
    edge('worker', 'consumes', 'sqs', 'wiring'),
  ],
  flows: [],
  warnings: [],
};

describe('visibleMap', () => {
  it('shows projects, libraries, and technologies with entry points hidden by default', () => {
    const map = visibleMap(graph, { libraries: true, entrypoints: false });

    expect(map.nodes.map((item) => item.id)).toEqual([
      'api',
      'worker',
      'data',
      'core',
      'dynamo',
      'sqs',
    ]);
    expect(map.edges.filter((item) => item.kind === 'references')).toHaveLength(3);
    expect(map.edges.every((item) => item.via.length === 0)).toBe(true);
  });

  it('hides entry points whose only connection is a hidden library', () => {
    const map = visibleMap(graph, { libraries: false, entrypoints: true });

    expect(map.nodes.map((item) => item.id)).toEqual([
      'api',
      'worker',
      'dynamo',
      'sqs',
      'get-orders',
    ]);
  });
});

describe('liftLibraryEdges', () => {
  it('moves library dependencies onto every service that references them', () => {
    const edges = liftLibraryEdges(graph);
    const apiDynamo = edges.find((item) => item.source === 'api' && item.target === 'dynamo')!;
    const workerDynamo = edges.find((item) => item.source === 'worker' && item.target === 'dynamo')!;

    expect(edges.some((item) => item.kind === 'references')).toBe(false);
    expect(apiDynamo).toMatchObject({
      id: 'edge:api:queries:dynamo',
      strength: 'call',
      evidence_count: 4,
      flow_ids: ['flow-a', 'flow-b'],
      via: ['Data'],
    });
    expect(apiDynamo.evidence.map((item) => item.kind)).toEqual(['call', 'registration']);
    expect(workerDynamo).toMatchObject({
      id: 'via:worker:edge:data:queries:dynamo',
      strength: 'call',
      evidence_count: 3,
      via: ['Data'],
    });
  });
});

describe('servicesUsing', () => {
  it('counts only services with their own evidence', () => {
    expect(servicesUsing(graph, 'dynamo')).toEqual(['Api']);
    expect(servicesUsing(graph, 'sqs')).toEqual(['Api', 'Worker']);
    expect([...sharedTechnologies(graph)]).toEqual(['sqs']);
  });
});
