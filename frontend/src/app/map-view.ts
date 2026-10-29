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
  @Output() readonly graphLoaded = new EventEmitter<{ nodes: number; edges: number }>();
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
          const visibleIds = new Set(
            graph.nodes
              .filter(
                (node) =>
                  node.kind !== 'entrypoint' && node.kind !== 'unresolved',
              )
              .map((node) => node.id),
          );
          this.graphLoaded.emit({
            nodes: visibleIds.size,
            edges: graph.edges.filter(
              (edge) =>
                visibleIds.has(edge.source) && visibleIds.has(edge.target),
            ).length,
          });
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

  protected clearSelection(): void {
    this.selectedNode.set(null);
    this.selectedEdge.set(null);
    this.cy?.elements().removeClass('highlighted').removeClass('dimmed');
  }

  protected selectFlow(flowId: string): void {
    this.openFlow.emit(flowId);
  }

  protected nodeLabel(nodeId: string): string {
    return this.graph()?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  }

  protected incoming(node: ArchitectureNode): string[] {
    return this.relatedNodes(node.id, 'target');
  }

  protected outgoing(node: ArchitectureNode): string[] {
    return this.relatedNodes(node.id, 'source');
  }

  protected entrypointCount(node: ArchitectureNode): number {
    const graph = this.graph();
    if (!graph || node.kind !== 'service') {
      return 0;
    }
    const entrypoints = new Set(
      graph.nodes.filter((item) => item.kind === 'entrypoint').map((item) => item.id),
    );
    return graph.edges.filter(
      (edge) =>
        edge.kind === 'handles' &&
        edge.target === node.id &&
        entrypoints.has(edge.source),
    ).length;
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
    const degree = new Map(visibleNodes.map((node) => [node.id, 0]));
    for (const edge of visibleEdges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const degrees = [...degree.values()];
    const degreeMin = Math.min(...degrees);
    const degreeMax = Math.max(...degrees);
    const elements: ElementDefinition[] = [
      ...visibleNodes.map((node) => ({
        group: 'nodes' as const,
        data: { ...node, volume: degree.get(node.id) ?? 0 },
      })),
      ...visibleEdges.map((edge) => ({
        group: 'edges' as const,
        data: {
          ...edge,
          edgeType: edge.kind,
          color: EDGE_COLORS[edge.kind] ?? '#5b6b82',
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
    this.cy.on('tap', 'node', (event) => {
      const neighborhood = event.target.closedNeighborhood();
      this.cy!.elements().addClass('dimmed').removeClass('highlighted');
      neighborhood.removeClass('dimmed').addClass('highlighted');
      this.selectedNode.set(
        graph.nodes.find((node) => node.id === event.target.id()) ?? null,
      );
      this.selectedEdge.set(null);
    });
    this.cy.on('tap', 'edge', (event) => {
      this.cy!.elements().addClass('dimmed').removeClass('highlighted');
      event.target
        .add(event.target.connectedNodes())
        .removeClass('dimmed')
        .addClass('highlighted');
      this.selectedEdge.set(
        graph.edges.find((edge) => edge.id === event.target.id()) ?? null,
      );
      this.selectedNode.set(null);
    });
    this.cy.on('tap', (event) => {
      if (event.target === this.cy) {
        this.clearSelection();
      }
    });
  }

  private relatedNodes(
    nodeId: string,
    direction: 'source' | 'target',
  ): string[] {
    const graph = this.graph();
    if (!graph) {
      return [];
    }
    const related = graph.edges
      .filter((edge) => edge[direction] === nodeId)
      .map((edge) =>
        this.nodeLabel(direction === 'source' ? edge.target : edge.source),
      );
    return [...new Set(related)].sort();
  }
}

const EDGE_COLORS: Record<string, string> = {
  handles: '#2f6fed',
  queries: '#1f8a5b',
  publishes: '#c45c26',
  consumes: '#7c3aed',
  calls_external: '#c45c26',
  unresolved_dependency: '#5b6b82',
};

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
      width: `mapData(volume, ${degreeMin}, ${degreeMax}, 38, 82)`,
      height: `mapData(volume, ${degreeMin}, ${degreeMax}, 38, 82)`,
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
    selector: 'node[kind = "database"]',
    style: { shape: 'barrel', 'background-color': '#17694f', 'border-color': '#78ddbd' },
  },
  {
    selector: 'node[kind = "queue"], node[kind = "external"]',
    style: { shape: 'hexagon', 'background-color': '#8a734b', 'border-color': '#d2bf95' },
  },
  {
    selector: 'node[kind = "entrypoint"]',
    style: { shape: 'ellipse', 'background-color': '#2f6fed', 'border-color': '#8db2ff' },
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
      width: 2,
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
    selector: 'edge[edgeType = "unresolved_dependency"]',
    style: { 'line-style': 'dashed' },
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
