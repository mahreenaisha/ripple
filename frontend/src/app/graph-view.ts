import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import cytoscape, { Core } from 'cytoscape';

export type NodeKind = 'service' | 'database' | 'external_api' | string;
export type EdgeKind = 'calls' | 'queries' | 'imports' | 'publishes' | 'subscribes' | string;

export interface GraphNode {
  id: string;
  type?: NodeKind;
  language?: string | null;
  entry_points_count?: number;
  databases?: string[];
  dependencies_on?: string[];
  dependents?: string[];
  confidence?: string;
  spof_candidate?: boolean;
  spof_source?: string | null;
  status?: string | null;
  owner?: string | null;
  gotchas?: string[];
  last_modified?: string | null;
  lines_of_code?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  call_count: number;
  avg_latency_ms: number;
  error_rate: number;
  type?: EdgeKind;
  confidence?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata?: Record<string, unknown>;
  source?: string;
}

interface EntryPoint {
  type: string;
  endpoint: string;
  file: string;
  line: number;
  description?: string;
}

const EDGE_COLORS: Record<string, string> = {
  calls: '#faf0e6',
  queries: '#b9b4c7',
  imports: '#5c5470',
  publishes: '#faf0e6',
  subscribes: '#b9b4c7',
};

@Component({
  selector: 'app-graph-view',
  styleUrl: './graph-view.scss',
  templateUrl: './graph-view.html',
})
export class GraphViewComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) graph!: GraphData;

  @ViewChild('cyContainer') private readonly cyContainer!: ElementRef<HTMLDivElement>;

  private readonly http = inject(HttpClient);
  private cy?: Core;

  protected readonly selected = signal<GraphNode | null>(null);
  protected readonly entryPoints = signal<EntryPoint[]>([]);
  protected readonly loadingEntries = signal(false);

  ngAfterViewInit(): void {
    if (!this.graph?.nodes?.length) {
      return;
    }

    const nodeById = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, number>();
    for (const node of this.graph.nodes) {
      incoming.set(node.id, 0);
    }
    for (const edge of this.graph.edges) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + edge.call_count);
    }

    const volumes = [...incoming.values()];
    const minCalls = Math.min(...volumes);
    const maxCalls = Math.max(...volumes);
    const callRangeMin = minCalls === maxCalls ? 0 : minCalls;
    const callRangeMax = minCalls === maxCalls ? minCalls + 1 : maxCalls;

    const elements = [
      ...this.graph.nodes.map((node) => {
        const kind = node.type || 'service';
        const short =
          node.id.includes('.') ? node.id.split('.').pop()! : node.id;
        return {
          data: {
            id: node.id,
            label: short,
            fullId: node.id,
            kind,
            spof: node.spof_candidate ? 1 : 0,
            entries: node.entry_points_count || 0,
            volume: incoming.get(node.id) ?? 0,
          },
        };
      }),
      ...this.graph.edges.map((edge, index) => ({
        data: {
          id: `${edge.source}->${edge.target}-${index}`,
          source: edge.source,
          target: edge.target,
          edgeType: edge.type || 'calls',
          weight: edge.call_count || 1,
          confidence: edge.confidence || 'medium',
          color: EDGE_COLORS[edge.type || 'calls'] || '#5c5470',
        },
      })),
    ];

    this.cy = cytoscape({
      container: this.cyContainer.nativeElement,
      elements,
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 1100,
        padding: 72,
        idealEdgeLength: 150,
        nodeOverlap: 28,
        gravity: 0.35,
        nestingFactor: 1.2,
      },
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-opacity': 0.95,
            'border-width': 2,
            color: '#faf0e6',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 8,
            'text-outline-width': 3,
            'text-outline-color': '#352f44',
            'font-size': 13,
            'font-weight': 600,
            'font-family': 'IBM Plex Sans, sans-serif',
            'min-zoomed-font-size': 9,
            width: `mapData(volume, ${callRangeMin}, ${callRangeMax}, 34, 88)`,
            height: `mapData(volume, ${callRangeMin}, ${callRangeMax}, 34, 88)`,
            'transition-property': 'opacity, border-color, border-width, overlay-opacity',
            'transition-duration': 220,
          },
        },
        {
          selector: 'node[kind = "service"]',
          style: {
            shape: 'round-rectangle',
            'background-color': '#5c5470',
            'border-color': '#faf0e6',
          },
        },
        {
          selector: 'node[kind = "database"]',
          style: {
            shape: 'barrel',
            'background-color': '#352f44',
            'border-color': '#b9b4c7',
          },
        },
        {
          selector: 'node[kind = "external_api"]',
          style: {
            shape: 'hexagon',
            'background-color': '#5c5470',
            'border-color': '#b9b4c7',
          },
        },
        {
          selector: 'node[spof = 1]',
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
          selector: 'edge[edgeType = "imports"]',
          style: {
            'line-style': 'dashed',
          },
        },
        {
          selector: '.highlighted',
          style: {
            opacity: 1,
            'z-index': 999,
          },
        },
        {
          selector: 'node.highlighted',
          style: {
            'overlay-color': '#faf0e6',
            'overlay-opacity': 0.22,
            'overlay-padding': 8,
          },
        },
        {
          selector: 'edge.highlighted',
          style: {
            width: 4,
            opacity: 1,
          },
        },
        {
          selector: '.dimmed',
          style: {
            opacity: 0.12,
          },
        },
      ],
    });

    this.cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      const neighborhood = node.closedNeighborhood();
      this.cy!.elements().addClass('dimmed').removeClass('highlighted');
      neighborhood.removeClass('dimmed').addClass('highlighted');

      const full = nodeById.get(node.id());
      this.selected.set(full ?? { id: node.id() });
      this.loadEntryPoints(node.id());
    });

    this.cy.on('tap', (evt) => {
      if (evt.target === this.cy) {
        this.cy!.elements().removeClass('highlighted').removeClass('dimmed');
        this.selected.set(null);
        this.entryPoints.set([]);
      }
    });
  }

  protected clearSelection(): void {
    this.selected.set(null);
    this.entryPoints.set([]);
    this.cy?.elements().removeClass('highlighted').removeClass('dimmed');
  }

  protected apiEntries(): EntryPoint[] {
    return this.entryPoints().filter((entry) => entry.type === 'API').slice(0, 12);
  }

  protected cliEntries(): EntryPoint[] {
    return this.entryPoints().filter((entry) => entry.type === 'CLI').slice(0, 8);
  }

  private loadEntryPoints(serviceId: string): void {
    this.loadingEntries.set(true);
    this.entryPoints.set([]);
    this.http
      .get<{ entries?: EntryPoint[] }>(
        `http://localhost:8000/entry-points/${encodeURIComponent(serviceId)}`,
      )
      .subscribe({
        next: (body) => {
          this.entryPoints.set(body.entries ?? []);
          this.loadingEntries.set(false);
        },
        error: () => {
          this.entryPoints.set([]);
          this.loadingEntries.set(false);
        },
      });
  }

  ngOnDestroy(): void {
    this.cy?.destroy();
  }
}
