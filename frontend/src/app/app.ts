import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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

export interface ScanPreflight {
  repo_path: string;
  name: string;
  slug: string;
  dotnet: { executable: string; version: string };
  solutions: string[];
  nuget_config: string | null;
}

export type ScanPhase =
  | 'validating'
  | 'restoring'
  | 'scanning'
  | 'publishing'
  | 'cancelling'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface ScanJob {
  id: string;
  phase: ScanPhase;
  repo_path: string;
  name: string;
  slug: string;
  restore_packages: boolean;
  logs: string[];
  error: string | null;
  result: { snapshot: string; counts: Record<string, number>; warnings: number } | null;
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
export class App implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);

  protected readonly chatOpen = signal(false);
  protected readonly flowSelectionContext = signal<RequestFlowSelectionContext | null>(null);
  protected readonly snapshots = signal<SnapshotList | null>(null);
  protected readonly dataVersion = signal(0);
  protected readonly switching = signal(false);
  protected readonly showAddRepo = signal(false);
  protected readonly repoPath = signal('');
  protected readonly scanName = signal('');
  protected readonly restorePackages = signal(true);
  protected readonly selectedSolution = signal('');
  protected readonly scanPreflight = signal<ScanPreflight | null>(null);
  protected readonly scanJob = signal<ScanJob | null>(null);
  protected readonly scanChecking = signal(false);
  protected readonly scanError = signal<string | null>(null);
  protected readonly scanRunning = computed(() => {
    const phase = this.scanJob()?.phase;
    return phase === 'validating' ||
      phase === 'restoring' ||
      phase === 'scanning' ||
      phase === 'publishing' ||
      phase === 'cancelling';
  });
  private scanPoll: ReturnType<typeof setTimeout> | null = null;

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

  ngOnDestroy(): void {
    if (this.scanPoll) {
      clearTimeout(this.scanPoll);
    }
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

  protected onRepoPathInput(event: Event): void {
    this.repoPath.set((event.target as HTMLInputElement).value);
    this.scanPreflight.set(null);
    this.scanError.set(null);
  }

  protected onScanNameInput(event: Event): void {
    this.scanName.set((event.target as HTMLInputElement).value);
  }

  protected onSolutionChange(event: Event): void {
    this.selectedSolution.set((event.target as HTMLSelectElement).value);
  }

  protected onRestoreChange(event: Event): void {
    this.restorePackages.set((event.target as HTMLInputElement).checked);
  }

  protected preflightRepository(): void {
    const repoPath = this.repoPath().trim();
    if (!repoPath || this.scanChecking() || this.scanRunning()) {
      return;
    }
    this.scanChecking.set(true);
    this.scanError.set(null);
    this.scanPreflight.set(null);
    this.http
      .post<ScanPreflight>('http://localhost:8000/scans/preflight', {
        repo_path: repoPath,
      })
      .subscribe({
        next: (preflight) => {
          this.scanPreflight.set(preflight);
          this.repoPath.set(preflight.repo_path);
          if (!this.scanName().trim()) {
            this.scanName.set(preflight.name);
          }
          this.selectedSolution.set(
            preflight.solutions.length === 1 ? preflight.solutions[0] : '',
          );
          this.scanChecking.set(false);
        },
        error: (error: HttpErrorResponse) => {
          this.scanError.set(this.errorDetail(error));
          this.scanChecking.set(false);
        },
      });
  }

  protected startRepositoryScan(): void {
    const preflight = this.scanPreflight();
    if (!preflight || this.scanRunning()) {
      return;
    }
    this.scanError.set(null);
    this.http
      .post<ScanJob>('http://localhost:8000/scans', {
        repo_path: preflight.repo_path,
        name: this.scanName().trim() || preflight.name,
        solution: this.selectedSolution() || null,
        restore_packages: this.restorePackages(),
      })
      .subscribe({
        next: (job) => {
          this.scanJob.set(job);
          this.scheduleScanPoll(job.id);
        },
        error: (error: HttpErrorResponse) => {
          this.scanError.set(this.errorDetail(error));
        },
      });
  }

  protected cancelRepositoryScan(): void {
    const job = this.scanJob();
    if (!job || !this.scanRunning()) {
      return;
    }
    this.http
      .post<ScanJob>(`http://localhost:8000/scans/${job.id}/cancel`, {})
      .subscribe({
        next: (status) => this.scanJob.set(status),
        error: (error: HttpErrorResponse) => this.scanError.set(this.errorDetail(error)),
      });
  }

  protected closeScanner(): void {
    if (!this.scanRunning()) {
      this.showAddRepo.set(false);
    }
  }

  private scheduleScanPoll(jobId: string): void {
    if (this.scanPoll) {
      clearTimeout(this.scanPoll);
    }
    this.scanPoll = setTimeout(() => {
      this.http.get<ScanJob>(`http://localhost:8000/scans/${jobId}`).subscribe({
        next: (job) => {
          this.scanJob.set(job);
          if (job.phase === 'complete') {
            this.loadSnapshots(true);
          } else if (job.phase === 'failed' || job.phase === 'cancelled') {
            this.scanError.set(job.error);
          } else {
            this.scheduleScanPoll(jobId);
          }
        },
        error: (error: HttpErrorResponse) => {
          this.scanError.set(this.errorDetail(error));
        },
      });
    }, 1000);
  }

  private loadSnapshots(reloadFlows = false): void {
    this.http.get<SnapshotList>('http://localhost:8000/snapshots').subscribe({
      next: (list) => {
        this.snapshots.set(list);
        if (reloadFlows) {
          this.flowSelectionContext.set(null);
          this.dataVersion.update((version) => version + 1);
        }
      },
      error: () => this.snapshots.set(null),
    });
  }

  private errorDetail(error: HttpErrorResponse): string {
    const detail = error.error?.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    return 'Ripple could not complete that repository scan.';
  }
}
