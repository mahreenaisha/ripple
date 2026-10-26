import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ChatPanelComponent } from './chat-panel';
import { RequestFlowsViewComponent } from './request-flows-view';
import { RequestFlowSelectionContext } from './request-flow.types';

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
  imports: [RequestFlowsViewComponent, ChatPanelComponent],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);

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
    this.loadSnapshots();
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
          this.flowSelectionContext.set(null);
          this.dataVersion.update((version) => version + 1);
          this.switching.set(false);
        },
        error: () => this.switching.set(false),
      });
  }

  private loadSnapshots(): void {
    this.http.get<SnapshotList>('http://localhost:8000/snapshots').subscribe({
      next: (list) => this.snapshots.set(list),
      error: () => this.snapshots.set(null),
    });
  }
}
