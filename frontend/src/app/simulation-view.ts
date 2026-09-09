import { AfterViewInit, Component, ElementRef, inject, Input, OnDestroy, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import cytoscape, { Core, StylesheetJson } from 'cytoscape';
import { GraphData } from './graph-view';

interface SimulationWave {
  hop: number;
  nodes: string[];
}

interface SimulationResult {
  failed_node: string;
  waves: SimulationWave[];
}

const HOP_DELAY_MS = 500;

@Component({
  selector: 'app-simulation-view',
  styleUrl: './simulation-view.scss',
  templateUrl: './simulation-view.html',
})
export class SimulationViewComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) graph!: GraphData;

  @ViewChild('cyContainer') private readonly cyContainer!: ElementRef<HTMLDivElement>;

  private readonly http = inject(HttpClient);
  private cy?: Core;
  private timers: ReturnType<typeof setTimeout>[] = [];

  protected readonly failedNode = signal<string | null>(null);
  protected readonly running = signal(false);
  protected readonly currentHop = signal(0);
  protected readonly maxHop = signal(0);
  protected readonly affectedCount = signal(0);

  ngAfterViewInit(): void {
    if (!this.graph?.nodes?.length) {
      return;
    }

    const callsByNode = new Map<string, number>();
    for (const node of this.graph.nodes) {
      callsByNode.set(node.id, 0);
    }
    for (const edge of this.graph.edges) {
      const calls = callsByNode.get(edge.target);
      if (calls !== undefined) {
        callsByNode.set(edge.target, calls + edge.call_count);
      }
    }

    const nodeElements = this.graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.id,
        totalIncomingCalls: callsByNode.get(node.id) ?? 0,
      },
    }));

    const callCounts = nodeElements.map((node) => node.data.totalIncomingCalls);
    const minCalls = Math.min(...callCounts);
    const maxCalls = Math.max(...callCounts);
    const callRangeMin = minCalls === maxCalls ? 0 : minCalls;
    const callRangeMax = minCalls === maxCalls ? minCalls + 1 : maxCalls;

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
      style: this.buildStyle(callRangeMin, callRangeMax),
    });

    this.cy.on('tap', 'node', (evt) => {
      this.simulateFailure(String(evt.target.id()));
    });
  }

  protected reset(): void {
    this.clearTimers();
    this.clearSimulationState();
    this.failedNode.set(null);
    this.running.set(false);
    this.currentHop.set(0);
    this.maxHop.set(0);
    this.affectedCount.set(0);
  }

  ngOnDestroy(): void {
    this.clearTimers();
    this.cy?.destroy();
  }

  private simulateFailure(nodeId: string): void {
    this.clearTimers();
    this.clearSimulationState();
    this.failedNode.set(nodeId);
    this.running.set(true);
    this.currentHop.set(0);
    this.maxHop.set(0);
    this.affectedCount.set(0);

    this.cy?.elements().addClass('faded');

    this.http
      .post<SimulationResult>(`http://localhost:8000/simulate/failure/${encodeURIComponent(nodeId)}`, {})
      .subscribe({
        next: (result) => this.playWaves(result.waves ?? []),
        error: () => {
          this.running.set(false);
          this.cy?.elements().removeClass('faded');
        },
      });
  }

  private playWaves(waves: SimulationWave[]): void {
    const sorted = [...waves].sort((a, b) => a.hop - b.hop);

    if (sorted.length === 0) {
      this.running.set(false);
      this.cy?.elements().removeClass('faded');
      return;
    }

    this.maxHop.set(sorted[sorted.length - 1].hop);

    sorted.forEach((wave, index) => {
      const timer = setTimeout(() => {
        this.applyWave(wave);
        this.currentHop.set(wave.hop);

        if (index === sorted.length - 1) {
          this.running.set(false);
        }
      }, index * HOP_DELAY_MS);
      this.timers.push(timer);
    });
  }

  private applyWave(wave: SimulationWave): void {
    if (!this.cy) {
      return;
    }

    for (const id of wave.nodes) {
      const node = this.cy.getElementById(id);
      if (node.empty() || node.data('hop') !== undefined) {
        continue;
      }

      node.data('hop', wave.hop);
      node.data('label', wave.hop === 0 ? `${id}\nfailed` : `${id}\nhop ${wave.hop}`);
      node.removeClass('faded');
    }

    // Reveal the dependency edges the failure travelled along.
    this.cy.edges().forEach((edge) => {
      if (edge.source().data('hop') !== undefined && edge.target().data('hop') !== undefined) {
        edge.removeClass('faded').addClass('blast');
      }
    });

    this.affectedCount.set(this.cy.nodes().filter((node) => node.data('hop') >= 1).length);
  }

  private clearSimulationState(): void {
    this.cy?.elements().removeClass('faded blast');
    this.cy?.nodes().forEach((node) => {
      node.removeData('hop');
      node.data('label', node.id());
    });
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  private buildStyle(callRangeMin: number, callRangeMax: number): StylesheetJson {
    return [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          shape: 'ellipse',
          'background-color': '#3c4c66',
          'background-opacity': 0.95,
          'border-width': 2,
          'border-color': 'rgba(255, 255, 255, 0.18)',
          color: '#e6ebf5',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 6,
          'text-wrap': 'wrap',
          'text-outline-width': 3,
          'text-outline-color': '#0e1421',
          'font-size': 11,
          'font-weight': 600,
          'min-zoomed-font-size': 7,
          width: `mapData(totalIncomingCalls, ${callRangeMin}, ${callRangeMax}, 30, 90)`,
          height: `mapData(totalIncomingCalls, ${callRangeMin}, ${callRangeMax}, 30, 90)`,
          'transition-property': 'opacity, background-color, border-color, border-width',
          'transition-duration': 250,
        },
      },
      {
        selector: 'node[hop = 0]',
        style: {
          'background-color': '#ef4444',
          'border-width': 4,
          'border-color': '#fecaca',
          'z-index': 999,
        },
      },
      {
        selector: 'node[hop = 1]',
        style: {
          'background-color': '#fb923c',
          'border-width': 3,
          'border-color': '#fed7aa',
          'z-index': 998,
        },
      },
      {
        selector: 'node[hop = 2]',
        style: {
          'background-color': '#facc15',
          'border-width': 3,
          'border-color': '#fef08a',
          color: '#e6ebf5',
          'z-index': 997,
        },
      },
      {
        selector: 'node[hop >= 3]',
        style: {
          'background-color': '#fde68a',
          'border-width': 3,
          'border-color': '#fef3c7',
          'z-index': 996,
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1.6,
          opacity: 0.7,
          'line-color': '#41506d',
          'target-arrow-color': '#41506d',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.9,
          'curve-style': 'bezier',
          'transition-property': 'opacity, line-color, width',
          'transition-duration': 250,
        },
      },
      {
        selector: 'edge.blast',
        style: {
          width: 2.6,
          opacity: 1,
          'line-color': '#f87171',
          'target-arrow-color': '#f87171',
        },
      },
      {
        selector: '.faded',
        style: {
          opacity: 0.18,
        },
      },
    ];
  }
}
