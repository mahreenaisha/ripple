import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  OnDestroy,
  Output,
  signal,
  ViewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';
import { GraphData, GraphNode } from './graph-view';
import { RequestFlow, RequestFlowCatalog } from './request-flow.types';

mermaid.registerLayoutLoaders(elkLayouts);
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  layout: 'elk',
  elk: {
    mergeEdges: true,
    nodePlacementStrategy: 'BRANDES_KOEPF',
  },
  flowchart: {
    curve: 'linear',
    nodeSpacing: 40,
    rankSpacing: 90,
    padding: 14,
    useMaxWidth: true,
  },
  themeVariables: {
    background: '#352f44',
    primaryColor: '#5c5470',
    primaryTextColor: '#faf0e6',
    primaryBorderColor: '#b9b4c7',
    lineColor: '#b9b4c7',
    fontFamily: 'IBM Plex Sans, sans-serif',
    fontSize: '15px',
  },
});

export interface TeamDiagram {
  title: string;
  path: string;
  line?: number;
  format: 'mermaid' | 'plantuml' | string;
  code: string;
}

export interface TeamDiagrams {
  diagrams: TeamDiagram[];
  docs: Array<{ title: string; path: string; lines: number }>;
}

interface SnapshotNode {
  id: string;
  label: string;
  layer: LayerId;
  kind: string;
  description: string;
  flowIds: string[];
}

type LayerId = 'entry' | 'core' | 'data' | 'external';

const LAYERS: Array<{ id: LayerId; label: string }> = [
  { id: 'entry', label: 'Entry points' },
  { id: 'core', label: 'Services' },
  { id: 'data', label: 'Data stores' },
  { id: 'external', label: 'External systems' },
];

const CATEGORY_LABELS: Record<string, string> = {
  'user-request': 'HTTP routes',
  'cli-tool': 'Command-line tools',
  'device-event': 'Device events',
  'platform-event': 'Platform events',
  'background-job': 'Background jobs',
};

let renderSeq = 0;

export function normalizeSystem(name: string): string {
  return name
    .toLowerCase()
    .replace(/^aws\s+/, '')
    .replace(/-service$/, '')
    .replace(/[^a-z0-9]/g, '');
}

function shortName(id: string): string {
  return id.includes('.') ? id.split('.').pop()! : id;
}

function flowTouches(flow: RequestFlow, nodeId: string): boolean {
  const target = normalizeSystem(nodeId);
  if (!target) {
    return false;
  }
  const boundaries = flow.story?.produces.boundaries ?? [];
  if (boundaries.some((boundary) => normalizeSystem(boundary.system) === target)) {
    return true;
  }
  if (flow.story?.triggeredBy?.ownerHint && normalizeSystem(flow.story.triggeredBy.ownerHint) === target) {
    return true;
  }
  return flow.steps.some(
    (step) =>
      ['database', 'external', 'queue'].includes(step.kind) &&
      normalizeSystem(step.label).includes(target),
  );
}

export function buildSnapshotNodes(graph: GraphData, flows: RequestFlow[]): {
  nodes: SnapshotNode[];
  edges: Array<{ source: string; target: string; kind: string }>;
} {
  const nodes: SnapshotNode[] = [];
  const edges: Array<{ source: string; target: string; kind: string }> = [];
  const graphIds = new Set(graph.nodes.map((node) => node.id));

  const multipleServices = new Set(flows.map((flow) => flow.service)).size > 1;
  const entryGroups = new Map<string, RequestFlow[]>();
  for (const flow of flows) {
    const category = flow.story?.category ?? flow.trigger.kind;
    const key =
      category === 'background-job'
        ? `entry:${flow.service}:job:${flow.trigger.label}`
        : `entry:${flow.service}:${category}`;
    entryGroups.set(key, [...(entryGroups.get(key) ?? []), flow]);
  }

  for (const [id, group] of entryGroups) {
    const first = group[0];
    const category = first.story?.category ?? first.trigger.kind;
    const background = category === 'background-job';
    const groupLabel = `${CATEGORY_LABELS[category] ?? category} · ${group.length}`;
    const label = background
      ? `${first.trigger.label} (job)`
      : multipleServices
        ? `${shortName(first.service)}: ${groupLabel}`
        : groupLabel;
    nodes.push({
      id,
      label,
      layer: 'entry',
      kind: background ? 'background' : 'entry',
      description: background
        ? first.story?.summary ?? 'Background job'
        : `${group.length} ${CATEGORY_LABELS[category] ?? category} into ${shortName(first.service)}`,
      flowIds: group.map((flow) => flow.id),
    });
    if (graphIds.has(first.service)) {
      edges.push({ source: id, target: first.service, kind: 'enters' });
    }
    const owners = new Set(
      group.map((flow) => flow.story?.triggeredBy?.ownerHint).filter((owner): owner is string => !!owner),
    );
    for (const owner of owners) {
      const sender = graph.nodes.find((node) => normalizeSystem(node.id) === normalizeSystem(owner));
      if (sender) {
        edges.push({ source: sender.id, target: id, kind: 'sends' });
      }
    }
  }

  const layerFor = (node: GraphNode): LayerId =>
    node.type === 'database' ? 'data' : node.type === 'service' || !node.type ? 'core' : 'external';
  for (const node of graph.nodes) {
    const layer = layerFor(node);
    const flowIds = flows
      .filter((flow) => (layer === 'core' ? flow.service === node.id : flowTouches(flow, node.id)))
      .map((flow) => flow.id);
    nodes.push({
      id: node.id,
      label: shortName(node.id),
      layer,
      kind: node.type || 'service',
      description:
        layer === 'core'
          ? `${node.entry_points_count ?? 0} entry points found in this service`
          : `${flowIds.length} flows touch ${node.id}`,
      flowIds,
    });
  }
  for (const edge of graph.edges) {
    edges.push({ source: edge.source, target: edge.target, kind: edge.type || 'calls' });
  }
  return { nodes, edges };
}

@Component({
  selector: 'app-snapshot-view',
  styleUrl: './snapshot-view.scss',
  templateUrl: './snapshot-view.html',
})
export class SnapshotViewComponent implements AfterViewInit, OnDestroy {
  @Output() readonly openFlow = new EventEmitter<string>();
  @ViewChild('canvas') private readonly canvas?: ElementRef<HTMLDivElement>;
  @ViewChild('teamDiagram') private set teamDiagramHost(ref: ElementRef<HTMLDivElement> | undefined) {
    const diagram = this.openDiagram();
    if (ref && diagram) {
      void this.renderTeamDiagram(ref.nativeElement, diagram);
    }
  }

  private readonly http = inject(HttpClient);
  private cy?: Core;
  private resizeObserver?: ResizeObserver;
  private nodesById = new Map<string, SnapshotNode>();
  private flowsById = new Map<string, RequestFlow>();

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly selected = signal<SnapshotNode | null>(null);
  protected readonly collapsed = signal<Set<LayerId>>(new Set());
  protected readonly team = signal<TeamDiagrams>({ diagrams: [], docs: [] });
  protected readonly openDiagram = signal<TeamDiagram | null>(null);
  protected readonly diagramError = signal<string | null>(null);
  protected readonly mermaidCode = signal('');
  protected readonly copied = signal(false);
  protected readonly layers = LAYERS;

  ngAfterViewInit(): void {
    forkJoin({
      graph: this.http.get<GraphData>('http://localhost:8000/graph'),
      flows: this.http.get<RequestFlowCatalog>('http://localhost:8000/request-flows'),
    }).subscribe({
      next: ({ graph, flows }) => {
        this.loading.set(false);
        this.render(graph, flows.flows ?? []);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load the graph and flows. Make sure the API is running.');
      },
    });
    this.http.get<TeamDiagrams>('http://localhost:8000/team-diagrams').subscribe({
      next: (team) => this.team.set({ diagrams: team.diagrams ?? [], docs: team.docs ?? [] }),
      error: () => this.team.set({ diagrams: [], docs: [] }),
    });
    this.http.get<{ mermaid: string }>('http://localhost:8000/graph/mermaid').subscribe({
      next: (body) => this.mermaidCode.set(body.mermaid ?? ''),
      error: () => this.mermaidCode.set(''),
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.cy?.destroy();
  }

  protected selectedFlows(): RequestFlow[] {
    return (this.selected()?.flowIds ?? [])
      .map((id) => this.flowsById.get(id))
      .filter((flow): flow is RequestFlow => !!flow)
      .slice(0, 40);
  }

  protected toggleLayer(layer: LayerId): void {
    const next = new Set(this.collapsed());
    if (next.has(layer)) {
      next.delete(layer);
    } else {
      next.add(layer);
    }
    this.collapsed.set(next);
    this.applyCollapsed();
  }

  protected isCollapsed(layer: LayerId): boolean {
    return this.collapsed().has(layer);
  }

  protected clearSelection(): void {
    this.selected.set(null);
    this.cy?.elements().removeClass('dimmed highlighted');
  }

  protected showDiagram(diagram: TeamDiagram): void {
    this.diagramError.set(null);
    this.openDiagram.set(diagram);
  }

  private async renderTeamDiagram(host: HTMLDivElement, diagram: TeamDiagram): Promise<void> {
    try {
      const { svg } = await mermaid.render(`ripple-team-${++renderSeq}`, diagram.code);
      if (this.openDiagram() === diagram) {
        host.innerHTML = svg;
      }
    } catch {
      host.innerHTML = '';
      this.diagramError.set('This diagram uses Mermaid syntax Ripple cannot render. The source is shown instead.');
    }
  }

  protected closeDiagram(): void {
    this.openDiagram.set(null);
  }

  protected async copyMermaid(): Promise<void> {
    if (!this.mermaidCode()) {
      return;
    }
    await navigator.clipboard.writeText(this.mermaidCode());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1600);
  }

  private render(graph: GraphData, flows: RequestFlow[]): void {
    const host = this.canvas?.nativeElement;
    if (!host) {
      return;
    }
    this.flowsById = new Map(flows.map((flow) => [flow.id, flow]));
    const { nodes, edges } = buildSnapshotNodes(graph, flows);
    this.nodesById = new Map(nodes.map((node) => [node.id, node]));

    const elements: ElementDefinition[] = LAYERS.map((layer) => ({
      data: { id: `layer:${layer.id}`, label: layer.label, layer: layer.id, group: 1 },
    }));
    LAYERS.forEach((layer, column) => {
      const members = nodes.filter((node) => node.layer === layer.id);
      members.forEach((node, row) => {
        elements.push({
          data: { id: node.id, label: node.label, parent: `layer:${layer.id}`, kind: node.kind },
          position: { x: column * 300, y: (row - (members.length - 1) / 2) * 64 },
        });
      });
    });
    const known = new Set(nodes.map((node) => node.id));
    edges
      .filter((edge) => known.has(edge.source) && known.has(edge.target))
      .forEach((edge, index) => {
        elements.push({
          data: { id: `edge-${index}`, source: edge.source, target: edge.target, kind: edge.kind },
        });
      });

    this.cy = cytoscape({
      container: host,
      elements,
      layout: { name: 'preset', padding: 40 },
      wheelSensitivity: 0.3,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            shape: 'round-rectangle',
            width: 'label',
            height: 26,
            padding: '8px',
            'background-color': '#5c5470',
            'border-width': 1.5,
            'border-color': '#faf0e6',
            color: '#faf0e6',
            'font-size': 13,
            'font-family': 'IBM Plex Sans, sans-serif',
            'text-valign': 'center',
            'text-halign': 'center',
          },
        },
        { selector: 'node[kind = "entry"]', style: { 'background-color': '#5c5470', 'border-color': '#faf0e6' } },
        { selector: 'node[kind = "background"]', style: { 'background-color': '#352f44', 'border-color': '#b9b4c7' } },
        { selector: 'node[kind = "database"]', style: { shape: 'barrel', 'background-color': '#352f44', 'border-color': '#faf0e6' } },
        { selector: 'node[kind = "external_api"]', style: { 'background-color': '#5c5470', 'border-color': '#b9b4c7' } },
        {
          selector: 'node[group = 1]',
          style: {
            shape: 'round-rectangle',
            'background-color': '#352f44',
            'background-opacity': 0.6,
            'border-color': '#5c5470',
            'border-width': 1,
            color: '#b9b4c7',
            'font-size': 13,
            'font-weight': 700,
            'text-valign': 'top',
            'text-halign': 'center',
            'text-margin-y': -6,
            padding: '18px',
          },
        },
        {
          selector: 'node[group = 1].collapsed',
          style: {
            width: 160,
            height: 40,
            'text-valign': 'center',
            'text-margin-y': 0,
            color: '#faf0e6',
            'border-style': 'dashed',
          },
        },
        { selector: '.hidden', style: { display: 'none' } },
        {
          selector: 'edge',
          style: {
            width: 1.4,
            'curve-style': 'bezier',
            'line-color': '#b9b4c7',
            'target-arrow-color': '#b9b4c7',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.8,
            opacity: 0.75,
          },
        },
        { selector: 'edge[kind = "sends"]', style: { 'line-style': 'dashed', 'line-color': '#faf0e6', 'target-arrow-color': '#faf0e6' } },
        { selector: 'edge[kind = "enters"]', style: { 'line-color': '#b9b4c7', 'target-arrow-color': '#b9b4c7' } },
        { selector: '.dimmed', style: { opacity: 0.15 } },
        { selector: 'node.highlighted', style: { 'border-width': 3, 'border-color': '#faf0e6' } },
        { selector: 'edge.highlighted', style: { width: 3, opacity: 1, 'line-color': '#faf0e6', 'target-arrow-color': '#faf0e6' } },
      ],
    });

    this.cy.on('tap', 'node', (event) => {
      const node = event.target;
      const layer = node.data('layer') as LayerId | undefined;
      if (node.data('group') === 1 && layer) {
        this.toggleLayer(layer);
        return;
      }
      const neighborhood = node.closedNeighborhood();
      this.cy!.elements().addClass('dimmed').removeClass('highlighted');
      neighborhood.removeClass('dimmed').addClass('highlighted');
      node.ancestors().removeClass('dimmed');
      neighborhood.ancestors().removeClass('dimmed');
      this.selected.set(this.nodesById.get(node.id()) ?? null);
    });
    this.cy.on('tap', (event) => {
      if (event.target === this.cy) {
        this.clearSelection();
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.refit());
      this.resizeObserver.observe(host);
    }
  }

  private refit(): void {
    this.cy?.resize();
    this.cy?.fit(undefined, 40);
  }

  private applyCollapsed(): void {
    if (!this.cy) {
      return;
    }
    for (const layer of LAYERS) {
      const parent = this.cy.getElementById(`layer:${layer.id}`);
      const collapsed = this.collapsed().has(layer.id);
      const children = parent.children();
      children.toggleClass('hidden', collapsed);
      parent.toggleClass('collapsed', collapsed);
      parent.data('label', collapsed ? `${layer.label} (${children.length}) ▸` : layer.label);
    }
    this.cy.fit(undefined, 40);
  }
}
