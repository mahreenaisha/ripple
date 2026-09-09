import { AfterViewInit, Component, ElementRef, inject, OnInit, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';

type Direction = 'TD' | 'LR';

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
    background: '#0e1421',
    primaryColor: '#1c2637',
    primaryTextColor: '#e6ebf5',
    primaryBorderColor: '#3c4c66',
    lineColor: '#64748b',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '14px',
  },
});

let renderSeq = 0;

@Component({
  selector: 'app-snapshot-view',
  styleUrl: './snapshot-view.scss',
  templateUrl: './snapshot-view.html',
})
export class SnapshotViewComponent implements OnInit, AfterViewInit {
  @ViewChild('diagram') private readonly diagram?: ElementRef<HTMLDivElement>;

  private readonly http = inject(HttpClient);
  private viewReady = false;

  protected readonly mermaidCode = signal('');
  protected readonly direction = signal<Direction>('TD');
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);

  ngOnInit(): void {
    this.http.get<{ mermaid: string }>('http://localhost:8000/graph/mermaid').subscribe({
      next: (body) => {
        this.mermaidCode.set(body.mermaid ?? '');
        this.loading.set(false);
        void this.renderIfReady();
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load the Mermaid snapshot.');
      },
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    void this.renderIfReady();
  }

  protected setDirection(direction: Direction): void {
    if (this.direction() === direction) {
      return;
    }
    this.direction.set(direction);
    void this.renderIfReady();
  }

  protected async copyMermaid(): Promise<void> {
    const code = this.displayedCode();
    if (!code) {
      return;
    }

    await navigator.clipboard.writeText(code);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1600);
  }

  /** The backend always emits `graph TD`; swap the header so the view can be re-flowed. */
  private displayedCode(): string {
    return this.mermaidCode().replace(
      /^(\s*)(graph|flowchart)\s+(TB|TD|LR|RL|BT)/,
      `$1$2 ${this.direction()}`,
    );
  }

  private async renderIfReady(): Promise<void> {
    const code = this.displayedCode();
    const host = this.diagram?.nativeElement;
    if (!this.viewReady || !code || !host) {
      return;
    }

    try {
      host.innerHTML = await this.renderSvg(code);
      this.error.set(null);
    } catch {
      try {
        // Fall back to the built-in layout engine if ELK is unavailable.
        host.innerHTML = await this.renderSvg(`%%{init: {"layout": "dagre"}}%%\n${code}`);
        this.error.set(null);
      } catch {
        host.innerHTML = '';
        this.error.set('Could not render the Mermaid diagram.');
      }
    }
  }

  private async renderSvg(code: string): Promise<string> {
    const { svg } = await mermaid.render(`ripple-snapshot-${++renderSeq}`, code);
    return svg;
  }
}
