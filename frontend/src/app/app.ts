import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { GraphData, GraphViewComponent } from './graph-view';
import { SimulationViewComponent } from './simulation-view';
import { SnapshotViewComponent } from './snapshot-view';
import { ChatPanelComponent } from './chat-panel';
import { RequestFlowsViewComponent } from './request-flows-view';
import { RequestFlowSelectionContext } from './request-flow.types';

export type AppTab = 'map' | 'flows' | 'snapshot' | 'simulate';

export interface ScannedSnapshot {
  slug: string;
  name: string;
  source?: {
    commit?: string | null;
    branch?: string | null;
    remote?: string | null;
    committedAt?: string | null;
    scannedAt?: string | null;
  } | null;
  counts?: Record<string, number> | null;
  durationMs?: number | null;
  has_knowledge?: boolean;
}

export interface SnapshotList {
  active: string;
  current: ScannedSnapshot | null;
  snapshots: ScannedSnapshot[];
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  const then = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(then)) {
    return 'unknown';
  }
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

@Component({
  imports: [
    GraphViewComponent,
    RequestFlowsViewComponent,
    SimulationViewComponent,
    SnapshotViewComponent,
    ChatPanelComponent,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly graph = signal<GraphData | null>(null);
  protected readonly activeTab = signal<AppTab>('map');
  protected readonly chatOpen = signal(false);
  protected readonly flowSelectionContext = signal<RequestFlowSelectionContext | null>(null);
  protected readonly snapshots = signal<SnapshotList | null>(null);
  protected readonly dataVersion = signal(0);
  protected readonly switching = signal(false);
  protected readonly showAddRepo = signal(false);

  protected readonly freshness = computed(() => {
    const current = this.snapshots()?.current;
    if (!current) {
      return null;
    }
    const commit = current.source?.commit?.slice(0, 7);
    const scannedAt = Date.parse(current.source?.scannedAt ?? '');
    return {
      stale: Number.isNaN(scannedAt) || Date.now() - scannedAt > 24 * 3600000,
      label: commit
        ? `${current.name} @ ${commit} · scanned ${timeAgo(current.source?.scannedAt)}`
        : `${current.name} · scanned ${timeAgo(current.source?.scannedAt)}`,
      detail: [
        current.source?.branch ? `Branch ${current.source.branch}` : null,
        current.source?.committedAt ? `Committed ${current.source.committedAt}` : null,
        current.source?.remote ?? null,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });

  ngOnInit(): void {
    this.loadData();
  }

  protected setTab(tab: AppTab): void {
    if (tab !== 'flows') {
      this.flowSelectionContext.set(null);
    }
    this.activeTab.set(tab);
  }

  protected readonly pendingFlowId = signal<string | null>(null);

  protected openFlow(flowId: string): void {
    this.pendingFlowId.set(flowId);
    this.setTab('flows');
  }

  protected setFlowSelectionContext(context: RequestFlowSelectionContext | null): void {
    this.flowSelectionContext.set(context);
  }

  protected toggleChat(): void {
    this.chatOpen.update((open) => !open);
  }

  protected switchSnapshot(event: Event): void {
    const slug = (event.target as HTMLSelectElement).value;
    if (!slug || slug === this.snapshots()?.active) {
      return;
    }
    this.switching.set(true);
    this.http
      .post<SnapshotList>('http://localhost:8000/snapshots/active', { slug })
      .subscribe({
        next: (list) => {
          this.snapshots.set(list);
          this.pendingFlowId.set(null);
          this.flowSelectionContext.set(null);
          this.graph.set(null);
          this.dataVersion.update((version) => version + 1);
          this.switching.set(false);
          this.loadData();
        },
        error: () => this.switching.set(false),
      });
  }

  private loadData(): void {
    this.http.get<GraphData>('http://localhost:8000/graph').subscribe((graph) => this.graph.set(graph));
    this.http.get<SnapshotList>('http://localhost:8000/snapshots').subscribe({
      next: (list) => this.snapshots.set(list),
      error: () => this.snapshots.set(null),
    });
  }
}
