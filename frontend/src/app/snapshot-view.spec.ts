import { vi } from 'vitest';
import { buildSnapshotNodes, normalizeSystem } from './snapshot-view';
import { GraphData } from './graph-view';
import { RequestFlow } from './request-flow.types';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), registerLayoutLoaders: vi.fn(), render: vi.fn() },
}));
vi.mock('@mermaid-js/layout-elk', () => ({ default: [] }));

const graph: GraphData = {
  nodes: [
    { id: 'Waters.DeviceAS.Server', type: 'service', entry_points_count: 3 },
    { id: 'OpenSearch', type: 'database' },
    { id: 'tenancyas-service', type: 'external_api' },
  ],
  edges: [
    { source: 'Waters.DeviceAS.Server', target: 'OpenSearch', call_count: 1, avg_latency_ms: 0, error_rate: 0, type: 'queries' },
  ],
};

function flow(id: string, category: string, label: string, extra: Partial<RequestFlow> = {}): RequestFlow {
  return {
    id,
    service: 'Waters.DeviceAS.Server',
    trigger: { kind: category === 'user-request' ? 'api' : 'queue', label },
    confidence: 'high',
    steps: [],
    story: {
      category,
      fanOut: [],
      produces: { metrics: [], boundaries: [] },
      timing: [],
      summary: `${label} summary`,
    },
    ...extra,
  };
}

describe('buildSnapshotNodes', () => {
  it('layers entry points, links outside senders and finds flows touching data stores', () => {
    const heartbeat = flow('flow-hb', 'background-job', 'TenancyDevicesHeartbeat');
    heartbeat.story!.triggeredBy = { kind: 'message', label: 'Sent by TenancyAS', outsideRepo: true, ownerHint: 'TenancyAS' };
    heartbeat.story!.produces.boundaries = [{ kind: 'database', system: 'OpenSearch', access: 'check' }];
    const flows = [
      heartbeat,
      flow('flow-a', 'user-request', 'GET /a'),
      flow('flow-b', 'user-request', 'GET /b'),
    ];

    const { nodes, edges } = buildSnapshotNodes(graph, flows);
    const byId = new Map(nodes.map((node) => [node.id, node]));

    const job = byId.get('entry:Waters.DeviceAS.Server:job:TenancyDevicesHeartbeat')!;
    expect(job.kind).toBe('background');
    expect(job.description).toBe('TenancyDevicesHeartbeat summary');
    expect(byId.get('entry:Waters.DeviceAS.Server:user-request')!.label).toBe('HTTP routes · 2');
    expect(byId.get('Waters.DeviceAS.Server')!.flowIds).toHaveLength(3);
    expect(byId.get('OpenSearch')!.flowIds).toEqual(['flow-hb']);
    expect(byId.get('tenancyas-service')!.flowIds).toEqual(['flow-hb']);
    expect(edges).toContainEqual({ source: 'tenancyas-service', target: job.id, kind: 'sends' });
    expect(edges).toContainEqual({ source: job.id, target: 'Waters.DeviceAS.Server', kind: 'enters' });
  });

  it('normalizes system names across scanner and graph spellings', () => {
    expect(normalizeSystem('AWS SQS')).toBe(normalizeSystem('SQS'));
    expect(normalizeSystem('tenancyas-service')).toBe(normalizeSystem('TenancyAS'));
  });
});
