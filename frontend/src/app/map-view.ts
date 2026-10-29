import {
  Component,
  ElementRef,
  EventEmitter,
  inject,
  OnDestroy,
  OnInit,
  Output,
  signal,
  ViewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import cytoscape, {
  Core,
  ElementDefinition,
  StylesheetCSS,
  StylesheetStyle,
} from 'cytoscape';
import {
  ArchitectureGraph,
  ArchitectureNode,
  EvidenceKind,
  EvidenceStrength,
  GraphEdgeKind,
  GraphEvidence,
  GraphFlowLink,
  GraphNodeKind,
  GraphSummary,
} from './architecture-graph.types';
import {
  MapEdge,
  servicesUsing,
  sharedTechnologies,
  TECHNOLOGY_KINDS,
  visibleMap,
} from './map-graph';

const EVIDENCE_PREVIEW = 6;
const LIST_PREVIEW = 8;

const KIND_LABELS: Record<GraphNodeKind, string> = {
  service: 'Service',
  library: 'Library',
  entrypoint: 'Entry point',
  database: 'Database',
  queue: 'Queue',
  external: 'External system',
};

const EDGE_TITLES: Record<GraphEdgeKind, string> = {
  handles: 'Entry point',
  references: 'Project reference',
  queries: 'Queries',
  publishes: 'Publishes to',
  consumes: 'Consumes from',
  calls_external: 'Calls',
  uses: 'Uses',
};

const STRENGTH_LABELS: Record<EvidenceStrength, string> = {
  call: 'Called in code',
  wiring: 'Wiring only',
  declaration: 'Declared only',
};

const STRENGTH_NOTES: Record<EvidenceStrength, string> = {
  call: 'Code in this project calls it. Each item below is a call site.',
  wiring:
    'This project registers, injects, or configures it, but Ripple found no call in its own code.',
  declaration:
    'Only a package or API client reference declares it. Ripple found no code that uses it.',
};

const LIFTED_STRENGTH_NOTES: Record<EvidenceStrength, string> = {
  call: 'Code in this service or a library it references calls it. Each item below is a call site.',
  wiring:
    'This service or a library it references registers, injects, or configures it, but Ripple found no call.',
  declaration:
    'Only package or API client references declare it, in this service or a library it references.',
};

const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  call: 'call',
  route: 'route',
  registration: 'registration',
  injection: 'injection',
  configuration: 'config',
  package: 'package',
  'generated-client': 'API client',
  'project-reference': 'reference',
};

const EDGE_COLORS: Record<GraphEdgeKind, string> = {
  handles: '#8db2ff',
  references: '#8a734b',
  queries: '#1f8a5b',
  publishes: '#c45c26',
  consumes: '#7c3aed',
  calls_external: '#2f6fed',
  uses: '#5b6b82',
};

interface EntryPointLink {
  label: string;
  flowId: string | null;
}

@Component({
  selector: 'app-map-view',
  styleUrl: './map-view.scss',
  templateUrl: './map-view.html',
})
export class MapViewComponent implements OnInit, OnDestroy {
  @Output() readonly openFlow = new EventEmitter<string>();
  @Output() readonly graphLoaded = new EventEmitter<GraphSummary>();
  @ViewChild('graphCanvas') private set graphCanvas(
    element: ElementRef<HTMLDivElement> | undefined,
  ) {
    // Angular re-runs this setter whenever a detail panel opens or closes.
    if (element?.nativeElement === this.canvas?.nativeElement) {
      return;
    }
    this.canvas = element;
    this.render();
  }

  private readonly http = inject(HttpClient);
  private canvas?: ElementRef<HTMLDivElement>;
  private cy?: Core;
  private visibleEdges = new Map<string, MapEdge>();
  private flowIndex = new Map<string, GraphFlowLink>();
  private shared = new Set<string>();

  protected readonly graph = signal<ArchitectureGraph | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly showLibraries = signal(true);
  protected readonly showEntrypoints = signal(false);
  protected readonly selectedNode = signal<ArchitectureNode | null>(null);
  protected readonly selectedEdge = signal<MapEdge | null>(null);
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly evidencePreview = EVIDENCE_PREVIEW;
  protected readonly listPreview = LIST_PREVIEW;

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
    this.cy?.destroy();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.http
      .get<ArchitectureGraph>('http://localhost:8000/architecture-graph')
      .subscribe({
        next: (graph) => {
          this.flowIndex = new Map(graph.flows.map((flow) => [flow.id, flow]));
          this.shared = sharedTechnologies(graph);
          this.graph.set(graph);
          this.loading.set(false);
          this.graphLoaded.emit(graph.summary);
          this.render();
        },
        error: (error: HttpErrorResponse) => {
          this.loading.set(false);
          const detail = error.error?.detail;
          this.error.set(
            typeof detail === 'string'
              ? detail
              : 'The architecture Map is unavailable. Rescan this repository to generate it.',
          );
        },
      });
  }

  protected toggleLibraries(): void {
    this.showLibraries.update((value) => !value);
    this.clearSelection();
    this.render();
  }

  protected toggleEntrypoints(): void {
    this.showEntrypoints.update((value) => !value);
    this.clearSelection();
    this.render();
  }

  protected fit(): void {
    this.cy?.fit(undefined, 48);
  }

  protected clearSelection(): void {
    this.selectedNode.set(null);
    this.selectedEdge.set(null);
    this.expanded.set(new Set());
    this.cy?.elements().removeClass('highlighted').removeClass('dimmed').unselect();
  }

  protected selectFlow(flowId: string): void {
    this.openFlow.emit(flowId);
  }

  protected focusNode(nodeId: string): void {
    const element = this.cy?.getElementById(nodeId);
    const node = this.graph()?.nodes.find((item) => item.id === nodeId);
    if (!element?.nonempty() || !node) {
      return;
    }
    this.cy!.elements().unselect().addClass('dimmed').removeClass('highlighted');
    element.closedNeighborhood().removeClass('dimmed').addClass('highlighted');
    element.select();
    this.expanded.set(new Set());
    this.selectedEdge.set(null);
    this.selectedNode.set(node);
  }

  protected focusEdge(edge: MapEdge): void {
    const element = this.cy?.getElementById(edge.id);
    if (!element?.nonempty()) {
      return;
    }
    this.cy!.elements().unselect().addClass('dimmed').removeClass('highlighted');
    element.add(element.connectedNodes()).removeClass('dimmed').addClass('highlighted');
    element.select();
    this.expanded.set(new Set());
    this.selectedNode.set(null);
    this.selectedEdge.set(edge);
  }

  protected isExpanded(section: string): boolean {
    return this.expanded().has(section);
  }

  protected expand(section: string): void {
    this.expanded.update((sections) => new Set([...sections, section]));
  }

  protected preview<T>(items: T[], section: string, size = LIST_PREVIEW): T[] {
    return this.isExpanded(section) ? items : items.slice(0, size);
  }

  protected kindLabel(kind: GraphNodeKind): string {
    return KIND_LABELS[kind];
  }

  protected edgeTitle(edge: MapEdge): string {
    return EDGE_TITLES[edge.kind];
  }

  protected strengthLabel(strength: EvidenceStrength): string {
    return STRENGTH_LABELS[strength];
  }

  protected strengthNote(edge: MapEdge): string {
    if (edge.kind === 'handles') {
      return "Ripple found this route or queue trigger in the project's code.";
    }
    if (edge.kind === 'references') {
      return 'The project file references this library, so its code ships with this project.';
    }
    return (edge.via.length ? LIFTED_STRENGTH_NOTES : STRENGTH_NOTES)[edge.strength];
  }

  protected evidenceLabel(evidence: GraphEvidence): string {
    return EVIDENCE_LABELS[evidence.kind];
  }

  protected nodeLabel(nodeId: string): string {
    return this.graph()?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  }

  protected isTechnology(node: ArchitectureNode): boolean {
    return TECHNOLOGY_KINDS.has(node.kind);
  }

  protected isShared(node: ArchitectureNode): boolean {
    return this.shared.has(node.id);
  }

  protected usedBy(node: ArchitectureNode): string[] {
    const graph = this.graph();
    return graph ? servicesUsing(graph, node.id) : [];
  }

  protected incoming(node: ArchitectureNode, references = false): MapEdge[] {
    return this.connections(node, 'target', references);
  }

  protected outgoing(node: ArchitectureNode, references = false): MapEdge[] {
    return this.connections(node, 'source', references);
  }

  protected entryPoints(node: ArchitectureNode): EntryPointLink[] {
    const graph = this.graph();
    if (!graph) {
      return [];
    }
    const nodes = new Map(graph.nodes.map((item) => [item.id, item]));
    return graph.edges
      .filter((edge) => edge.kind === 'handles' && edge.target === node.id)
      .map((edge) => nodes.get(edge.source))
      .filter((item): item is ArchitectureNode => item?.kind === 'entrypoint')
      .map((item) => ({ label: item.label, flowId: item.flow_ids[0] ?? null }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  protected flows(flowIds: string[]): GraphFlowLink[] {
    return flowIds
      .map((flowId) => this.flowIndex.get(flowId))
      .filter((flow): flow is GraphFlowLink => flow !== undefined)
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  protected serviceLabel(name: string): string {
    return this.graph()?.nodes.find((node) => node.name === name)?.label ?? name;
  }

  private connections(
    node: ArchitectureNode,
    direction: 'source' | 'target',
    references: boolean,
  ): MapEdge[] {
    const other = direction === 'source' ? 'target' : 'source';
    return [...this.visibleEdges.values()]
      .filter(
        (edge) =>
          edge[direction] === node.id &&
          edge.kind !== 'handles' &&
          (edge.kind === 'references') === references,
      )
      .sort((left, right) =>
        this.nodeLabel(left[other]).localeCompare(this.nodeLabel(right[other])),
      );
  }

  private render(): void {
    const graph = this.graph();
    const container = this.canvas?.nativeElement;
    if (!graph || !container) {
      return;
    }
    this.cy?.destroy();
    this.cy = undefined;
    const { nodes, edges } = visibleMap(graph, {
      libraries: this.showLibraries(),
      entrypoints: this.showEntrypoints(),
    });
    this.visibleEdges = new Map(edges.map((edge) => [edge.id, edge]));
    if (!nodes.length) {
      return;
    }
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const degrees = [...degree.values()];
    const degreeMin = Math.min(...degrees);
    const degreeMax = Math.max(...degrees);
    const elements: ElementDefinition[] = [
      ...nodes.map((node) => ({
        group: 'nodes' as const,
        data: {
          id: node.id,
          label: node.label,
          kind: node.kind,
          volume: degree.get(node.id) ?? 0,
          shared: this.shared.has(node.id) ? 1 : 0,
        },
      })),
      ...edges.map((edge) => ({
        group: 'edges' as const,
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          edgeType: edge.kind,
          strength: edge.strength,
          weight: edge.evidence_count,
          color: EDGE_COLORS[edge.kind],
        },
      })),
    ];
    this.cy = cytoscape({
      container,
      elements,
      style: mapStyle(degreeMin, degreeMin === degreeMax ? degreeMin + 1 : degreeMax),
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 900,
        padding: 72,
        nodeRepulsion: () => 9000,
        idealEdgeLength: () => 150,
        nodeOverlap: 28,
        gravity: 0.35,
      },
      minZoom: 0.25,
      maxZoom: 1.3,
    });
    this.cy.one('layoutstop', () => this.cy?.fit(undefined, 72));
    this.cy.on('tap', 'node', (event) => this.focusNode(event.target.id()));
    this.cy.on('tap', 'edge', (event) => {
      const edge = this.visibleEdges.get(event.target.id());
      if (edge) {
        this.focusEdge(edge);
      }
    });
    this.cy.on('tap', (event) => {
      if (event.target === this.cy) {
        this.clearSelection();
      }
    });
  }
}

function mapStyle(
  degreeMin: number,
  degreeMax: number,
): Array<StylesheetStyle | StylesheetCSS> {
  return [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      color: '#f3f6f8',
      'font-family': 'IBM Plex Sans, sans-serif',
      'font-size': 13,
      'font-weight': 600,
      'text-wrap': 'wrap',
      'text-max-width': '120px',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 8,
      'text-outline-width': 3,
      'text-outline-color': '#090b0e',
      'min-zoomed-font-size': 9,
      width: `mapData(volume, ${degreeMin}, ${degreeMax}, 34, 88)`,
      height: `mapData(volume, ${degreeMin}, ${degreeMax}, 34, 88)`,
      shape: 'round-rectangle',
      'background-color': '#176b87',
      'background-opacity': 0.95,
      'border-width': 2,
      'border-color': '#6db4d5',
      'transition-property': 'opacity, border-color, border-width, overlay-opacity',
      'transition-duration': 220,
    },
  },
  {
    selector: 'node[kind = "library"]',
    style: {
      shape: 'cut-rectangle',
      'background-color': '#33465c',
      'border-color': '#8aa4c2',
    },
  },
  {
    selector: 'node[kind = "database"]',
    style: { shape: 'barrel', 'background-color': '#17694f', 'border-color': '#78ddbd' },
  },
  {
    selector: 'node[kind = "queue"]',
    style: { shape: 'round-tag', 'background-color': '#5b3f8a', 'border-color': '#b9a3e3' },
  },
  {
    selector: 'node[kind = "external"]',
    style: { shape: 'hexagon', 'background-color': '#8a734b', 'border-color': '#d2bf95' },
  },
  {
    selector: 'node[kind = "entrypoint"]',
    style: { shape: 'ellipse', 'background-color': '#2f6fed', 'border-color': '#8db2ff' },
  },
  {
    selector: 'node[shared = 1]',
    style: {
      'border-width': 4,
      'border-color': '#f08a5d',
      'overlay-color': '#f08a5d',
      'overlay-opacity': 0.12,
      'overlay-padding': 6,
    },
  },
  {
    selector: 'edge',
    style: {
      width: 'mapData(weight, 1, 14, 1.4, 4.5)',
      opacity: 0.82,
      'line-color': 'data(color)',
      'target-arrow-color': 'data(color)',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.85,
      'curve-style': 'bezier',
      'transition-property': 'opacity, line-color, width',
      'transition-duration': 200,
    },
  },
  {
    selector: 'edge[strength = "wiring"]',
    style: { 'line-style': 'dashed', 'line-dash-pattern': [7, 5] },
  },
  {
    selector: 'edge[strength = "declaration"]',
    style: { 'line-style': 'dotted' },
  },
  {
    selector: 'edge[edgeType = "references"], edge[edgeType = "handles"]',
    style: { width: 1.3, 'line-style': 'solid', opacity: 0.7, 'arrow-scale': 0.7 },
  },
  {
    selector: '.highlighted',
    style: { opacity: 1, 'z-index': 999 },
  },
  {
    selector: 'node.highlighted',
    style: {
      'overlay-color': '#36c49a',
      'overlay-opacity': 0.22,
      'overlay-padding': 8,
    },
  },
  {
    selector: 'edge.highlighted',
    style: { width: 4, opacity: 1 },
  },
  {
    selector: '.dimmed',
    style: { opacity: 0.12 },
  },
  {
    selector: ':selected',
    style: {
      'border-color': '#f0b35a',
      'line-color': '#f0b35a',
      'target-arrow-color': '#f0b35a',
      'border-width': 3,
    },
  },
  ];
}
