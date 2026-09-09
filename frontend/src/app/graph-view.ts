import { AfterViewInit, Component, ElementRef, Input, OnDestroy, ViewChild } from '@angular/core';
import cytoscape, { Core } from 'cytoscape';

export interface GraphNode {
  id: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  call_count: number;
  avg_latency_ms: number;
  error_rate: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

@Component({
  selector: 'app-graph-view',
  styleUrl: './graph-view.scss',
  templateUrl: './graph-view.html',
})
export class GraphViewComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) graph!: GraphData;

  @ViewChild('cyContainer') private readonly cyContainer!: ElementRef<HTMLDivElement>;

  private cy?: Core;

  ngAfterViewInit(): void {
    if (!this.graph?.nodes?.length) {
      return;
    }

    const statsByNode = new Map<
      string,
      { inDegree: number; totalIncomingCalls: number; errorRateSum: number }
    >();

    for (const node of this.graph.nodes) {
      statsByNode.set(node.id, { inDegree: 0, totalIncomingCalls: 0, errorRateSum: 0 });
    }

    for (const edge of this.graph.edges) {
      const stats = statsByNode.get(edge.target);
      if (!stats) {
        continue;
      }
      stats.inDegree += 1;
      stats.totalIncomingCalls += edge.call_count;
      stats.errorRateSum += edge.error_rate;
    }

    const nodeElements = this.graph.nodes.map((node) => {
      const stats = statsByNode.get(node.id)!;
      const avgErrorRate = stats.inDegree === 0 ? 0 : stats.errorRateSum / stats.inDegree;
      return {
        data: {
          id: node.id,
          inDegree: stats.inDegree,
          totalIncomingCalls: stats.totalIncomingCalls,
          avgErrorRate,
        },
      };
    });

    const callCounts = nodeElements.map((node) => node.data.totalIncomingCalls);
    const errorRates = nodeElements.map((node) => node.data.avgErrorRate);
    const minCalls = Math.min(...callCounts);
    const maxCalls = Math.max(...callCounts);
    const maxErrorRate = Math.max(...errorRates);
    const callRangeMin = minCalls === maxCalls ? 0 : minCalls;
    const callRangeMax = minCalls === maxCalls ? minCalls + 1 : maxCalls;
    const errorRangeMax = maxErrorRate === 0 ? 1 : maxErrorRate;

    const elements = [
      ...nodeElements,
      ...this.graph.edges.map((edge, index) => ({
        data: {
          id: `${edge.source}->${edge.target}-${index}`,
          source: edge.source,
          target: edge.target,
        },
      })),
    ];

    this.cy = cytoscape({
      container: this.cyContainer.nativeElement,
      elements,
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 900,
        padding: 60,
        idealEdgeLength: 130,
        nodeOverlap: 24,
        gravity: 0.5,
      },
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(id)',
            shape: 'ellipse',
            'background-color': `mapData(avgErrorRate, 0, ${errorRangeMax}, #4ade80, #ef4444)`,
            'background-opacity': 0.92,
            'border-width': 2,
            'border-color': 'rgba(255, 255, 255, 0.22)',
            color: '#e6ebf5',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'text-outline-width': 3,
            'text-outline-color': '#0e1421',
            'font-size': 11,
            'font-weight': 600,
            'min-zoomed-font-size': 7,
            width: `mapData(totalIncomingCalls, ${callRangeMin}, ${callRangeMax}, 30, 90)`,
            height: `mapData(totalIncomingCalls, ${callRangeMin}, ${callRangeMax}, 30, 90)`,
            'transition-property': 'opacity, border-color, border-width',
            'transition-duration': 200,
          },
        },
        {
          selector: 'node[inDegree >= 4]',
          style: {
            'border-width': 4,
            'border-color': '#f97316',
            'border-style': 'solid',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.6,
            opacity: 0.75,
            'line-color': '#41506d',
            'target-arrow-color': '#41506d',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.9,
            'curve-style': 'bezier',
            'transition-property': 'opacity, line-color, width',
            'transition-duration': 200,
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
            'overlay-color': '#818cf8',
            'overlay-opacity': 0.2,
            'overlay-padding': 7,
          },
        },
        {
          selector: 'edge.highlighted',
          style: {
            width: 3,
            'line-color': '#818cf8',
            'target-arrow-color': '#818cf8',
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
    });

    this.cy.on('tap', (evt) => {
      if (evt.target === this.cy) {
        this.cy!.elements().removeClass('highlighted').removeClass('dimmed');
      }
    });
  }

  ngOnDestroy(): void {
    this.cy?.destroy();
  }
}
