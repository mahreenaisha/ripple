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
  ArchitectureEdge,
  ArchitectureGraph,
  ArchitectureNode,
} from './architecture-graph.types';

@Component({
  selector: 'app-map-view',
  styleUrl: './map-view.scss',
  templateUrl: './map-view.html',
})
export class MapViewComponent implements OnInit, OnDestroy {
  @Output() readonly openFlow = new EventEmitter<string>();
  @ViewChild('graphCanvas') private set graphCanvas(
    element: ElementRef<HTMLDivElement> | undefined,
  ) {
    this.canvas = element;
    this.render();
  }

  private readonly http = inject(HttpClient);
  private canvas?: ElementRef<HTMLDivElement>;
  private cy?: Core;

  protected readonly graph = signal<ArchitectureGraph | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly showEntrypoints = signal(false);
  protected readonly showUnresolved = signal(false);
  protected readonly selectedNode = signal<ArchitectureNode | null>(null);
  protected readonly selectedEdge = signal<ArchitectureEdge | null>(null);

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
          this.graph.set(graph);
          this.loading.set(false);
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

  protected toggleEntrypoints(): void {
    this.showEntrypoints.update((value) => !value);
    this.render();
  }

  protected toggleUnresolved(): void {
    this.showUnresolved.update((value) => !value);
    this.render();
  }

  protected fit(): void {
    this.cy?.fit(undefined, 48);
  }

  protected selectFlow(flowId: string): void {
    this.openFlow.emit(flowId);
  }

  protected nodeLabel(nodeId: string): string {
    return this.graph()?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  }

  private render(): void {
    const graph = this.graph();
    const container = this.canvas?.nativeElement;
    if (!graph || !container) {
      return;
    }
    this.cy?.destroy();
    const visibleNodes = graph.nodes.filter(
      (node) =>
        (this.showEntrypoints() || node.kind !== 'entrypoint') &&
        (this.showUnresolved() || node.kind !== 'unresolved'),
    );
    if (!visibleNodes.length) {
      this.cy?.destroy();
      this.cy = undefined;
      return;
    }
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = graph.edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );
    const elements: ElementDefinition[] = [
      ...visibleNodes.map((node) => ({
        group: 'nodes' as const,
        data: { ...node },
      })),
      ...visibleEdges.map((edge) => ({
        group: 'edges' as const,
        data: { ...edge, label: edge.kind.replaceAll('_', ' ') },
      })),
    ];
    this.cy = cytoscape({
      container,
      elements,
      style: MAP_STYLE,
      layout: {
        name: 'cose',
        animate: false,
        padding: 48,
        nodeRepulsion: () => 9000,
        idealEdgeLength: () => 130,
      },
      minZoom: 0.25,
      maxZoom: 2.2,
    });
    this.cy.on('tap', 'node', (event) => {
      this.selectedNode.set(
        graph.nodes.find((node) => node.id === event.target.id()) ?? null,
      );
      this.selectedEdge.set(null);
    });
    this.cy.on('tap', 'edge', (event) => {
      this.selectedEdge.set(
        graph.edges.find((edge) => edge.id === event.target.id()) ?? null,
      );
      this.selectedNode.set(null);
    });
    this.cy.on('tap', (event) => {
      if (event.target === this.cy) {
        this.selectedNode.set(null);
        this.selectedEdge.set(null);
      }
    });
  }
}

const MAP_STYLE: Array<StylesheetStyle | StylesheetCSS> = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      color: '#f3f6f8',
      'font-family': 'IBM Plex Sans, Segoe UI, sans-serif',
      'font-size': 11,
      'text-wrap': 'wrap',
      'text-max-width': '120px',
      'text-valign': 'center',
      'text-halign': 'center',
      width: 120,
      height: 48,
      shape: 'round-rectangle',
      'background-color': '#2f75b5',
      'border-width': 1.5,
      'border-color': '#78b8ee',
    },
  },
  {
    selector: 'node[kind = "database"]',
    style: { shape: 'barrel', 'background-color': '#278766', 'border-color': '#78ddbd' },
  },
  {
    selector: 'node[kind = "queue"], node[kind = "external"]',
    style: { shape: 'hexagon', 'background-color': '#785a9e', 'border-color': '#b9a4ff' },
  },
  {
    selector: 'node[kind = "entrypoint"]',
    style: { shape: 'ellipse', width: 54, height: 54, 'font-size': 9 },
  },
  {
    selector: 'node[kind = "unresolved"]',
    style: {
      'background-color': '#465461',
      'border-color': '#84919d',
      'border-style': 'dashed',
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1.8,
      'line-color': '#84919d',
      'target-arrow-color': '#84919d',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      label: 'data(label)',
      color: '#b2bdc7',
      'font-size': 8,
      'text-background-color': '#11171d',
      'text-background-opacity': 0.85,
      'text-background-padding': '3px',
    },
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
