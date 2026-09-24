import { AfterViewInit, Component, ElementRef, inject, Input, OnDestroy, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import cytoscape, { Core, StylesheetJson } from 'cytoscape';
import { GraphData } from './graph-view';

interface ImpactWave {
  hop: number;
  nodes: string[];
}

interface ImpactResult {
  waves: ImpactWave[];
}

const LEVEL_DELAY_MS = 500;

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

  protected readonly selectedNode = signal<string | null>(null);
  protected readonly running = signal(false);
  protected readonly currentLevel = signal(0);
  protected readonly maxLevel = signal(0);
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
      this.traceImpact(String(evt.target.id()));
    });
  }

  protected reset(): void {
    this.clearTimers();
    this.clearImpactState();
    this.selectedNode.set(null);
    this.running.set(false);
    this.currentLevel.set(0);
    this.maxLevel.set(0);
    this.affectedCount.set(0);
  }

  ngOnDestroy(): void {
    this.clearTimers();
    this.cy?.destroy();
  }

  private traceImpact(nodeId: string): void {
    this.clearTimers();
    this.clearImpactState();
    this.selectedNode.set(nodeId);
    this.running.set(true);
    this.currentLevel.set(0);
    this.maxLevel.set(0);
    this.affectedCount.set(0);

    this.cy?.elements().addClass('faded');

    this.http
      .post<ImpactResult>(`http://localhost:8000/simulate/failure/${encodeURIComponent(nodeId)}`, {})
      .subscribe({
        next: (result) => this.revealLevels(result.waves ?? []),
        error: () => {
          this.running.set(false);
          this.cy?.elements().removeClass('faded');
        },
      });
  }

  private revealLevels(waves: ImpactWave[]): void {
    const sorted = [...waves].sort((a, b) => a.hop - b.hop);

    if (sorted.length === 0) {
      this.running.set(false);
      this.cy?.elements().removeClass('faded');
      return;
    }

    this.maxLevel.set(sorted[sorted.length - 1].hop);

    sorted.forEach((wave, index) => {
      const timer = setTimeout(() => {
        this.revealLevel(wave);
        this.currentLevel.set(wave.hop);

        if (index === sorted.length - 1) {
          this.running.set(false);
        }
      }, index * LEVEL_DELAY_MS);
      this.timers.push(timer);
    });
  }

  private revealLevel(wave: ImpactWave): void {
    if (!this.cy) {
      return;
    }

    for (const id of wave.nodes) {
      const node = this.cy.getElementById(id);
      if (node.empty() || node.data('impactLevel') !== undefined) {
        continue;
      }

      node.data('impactLevel', wave.hop);
      node.data(
        'label',
        wave.hop === 0 ? `${id}\nselected` : wave.hop === 1 ? `${id}\ndirect` : `${id}\nlevel ${wave.hop}`,
      );
      node.removeClass('faded');
    }

    // Reveal dependency paths connecting the selected service to its dependents.
    this.cy.edges().forEach((edge) => {
      if (
        edge.source().data('impactLevel') !== undefined &&
        edge.target().data('impactLevel') !== undefined
      ) {
        edge.removeClass('faded').addClass('impact');
      }
    });

    this.affectedCount.set(
      this.cy.nodes().filter((node) => node.data('impactLevel') >= 1).length,
    );
  }

  private clearImpactState(): void {
    this.cy?.elements().removeClass('faded impact');
    this.cy?.nodes().forEach((node) => {
      node.removeData('impactLevel');
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
          color: '#f3f6f8',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 6,
          'text-wrap': 'wrap',
          'text-outline-width': 3,
          'text-outline-color': '#090b0e',
          'font-size': 13,
          'font-weight': 600,
          'font-family': 'IBM Plex Sans, sans-serif',
          'min-zoomed-font-size': 9,
          width: `mapData(totalIncomingCalls, ${callRangeMin}, ${callRangeMax}, 30, 90)`,
          height: `mapData(totalIncomingCalls, ${callRangeMin}, ${callRangeMax}, 30, 90)`,
          'transition-property': 'opacity, background-color, border-color, border-width',
          'transition-duration': 250,
        },
      },
      {
        selector: 'node[impactLevel = 0]',
        style: {
          'background-color': '#17694f',
          'border-width': 4,
          'border-color': '#78ddbd',
          'z-index': 999,
        },
      },
      {
        selector: 'node[impactLevel = 1]',
        style: {
          'background-color': '#235a70',
          'border-width': 3,
          'border-color': '#6db4d5',
          'z-index': 998,
        },
      },
      {
        selector: 'node[impactLevel = 2]',
        style: {
          'background-color': '#38566c',
          'border-width': 3,
          'border-color': '#8eabc0',
          color: '#f3f6f8',
          'z-index': 997,
        },
      },
      {
        selector: 'node[impactLevel >= 3]',
        style: {
          'background-color': '#465b6c',
          'border-width': 3,
          'border-color': '#b2bdc7',
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
        selector: 'edge.impact',
        style: {
          width: 2.6,
          opacity: 1,
          'line-color': '#36c49a',
          'target-arrow-color': '#36c49a',
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
