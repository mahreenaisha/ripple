import { Component, computed, EventEmitter, inject, Input, Output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FlowKnowledgeFact, RequestFlow } from './request-flow.types';

const API = 'http://localhost:8000';

interface RepoFileCheck {
  path: string;
  lines: number;
  line?: number;
  excerpt?: string;
}

function errorDetail(error: HttpErrorResponse, fallback: string): string {
  return typeof error.error?.detail === 'string' ? error.error.detail : fallback;
}

@Component({
  selector: 'app-knowledge-form',
  styleUrl: './knowledge-form.scss',
  templateUrl: './knowledge-form.html',
})
export class KnowledgeFormComponent {
  @Input({ required: true }) set flow(flow: RequestFlow) {
    this.currentFlow.set(flow);
    this.appliesToTrigger.set(true);
    this.selectedSystems.set(new Set());
  }
  @Output() readonly saved = new EventEmitter<FlowKnowledgeFact>();
  @Output() readonly cancelled = new EventEmitter<void>();

  private readonly http = inject(HttpClient);

  protected readonly currentFlow = signal<RequestFlow | null>(null);
  protected readonly title = signal('');
  protected readonly text = signal('');
  protected readonly kind = signal<'doc' | 'rule'>('doc');
  protected readonly path = signal('');
  protected readonly line = signal('');
  protected readonly appliesToTrigger = signal(true);
  protected readonly selectedSystems = signal<Set<string>>(new Set());
  protected readonly check = signal<RepoFileCheck | null>(null);
  protected readonly checking = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly systems = computed(() => {
    const flow = this.currentFlow();
    if (!flow) {
      return [];
    }
    return [
      ...new Set([
        ...(flow.story?.produces.boundaries ?? []).map((boundary) => boundary.system),
        ...flow.steps
          .filter((step) => ['database', 'external', 'queue'].includes(step.kind))
          .map((step) => step.label),
      ]),
    ].filter(Boolean);
  });

  protected readonly canSave = computed(
    () =>
      !this.saving() &&
      !!this.title().trim() &&
      !!this.text().trim() &&
      !!this.path().trim() &&
      (this.appliesToTrigger() || this.selectedSystems().size > 0),
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected setPath(value: string): void {
    this.path.set(value);
    this.check.set(null);
  }

  protected setLine(value: string): void {
    this.line.set(value);
    this.check.set(null);
  }

  protected toggleSystem(system: string): void {
    const next = new Set(this.selectedSystems());
    if (next.has(system)) {
      next.delete(system);
    } else {
      next.add(system);
    }
    this.selectedSystems.set(next);
  }

  protected checkFile(): void {
    const params: Record<string, string> = { path: this.path().trim() };
    if (this.parsedLine() !== null) {
      params['line'] = String(this.parsedLine());
    }
    this.checking.set(true);
    this.error.set(null);
    this.http.get<RepoFileCheck>(`${API}/repo-file`, { params }).subscribe({
      next: (result) => {
        this.checking.set(false);
        this.check.set(result);
      },
      error: (error: HttpErrorResponse) => {
        this.checking.set(false);
        this.check.set(null);
        this.error.set(errorDetail(error, 'Could not check that file.'));
      },
    });
  }

  protected save(): void {
    const flow = this.currentFlow();
    if (!flow || !this.canSave()) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.http
      .post<FlowKnowledgeFact>(`${API}/knowledge/facts`, {
        title: this.title().trim(),
        text: this.text().trim(),
        kind: this.kind(),
        path: this.path().trim(),
        line: this.parsedLine(),
        triggers: this.appliesToTrigger() ? [flow.trigger.label] : [],
        boundaries: [...this.selectedSystems()],
      })
      .subscribe({
        next: (fact) => {
          this.saving.set(false);
          this.saved.emit(fact);
        },
        error: (error: HttpErrorResponse) => {
          this.saving.set(false);
          this.error.set(errorDetail(error, 'Could not save the fact.'));
        },
      });
  }

  private parsedLine(): number | null {
    const line = Number.parseInt(this.line(), 10);
    return Number.isFinite(line) && line > 0 ? line : null;
  }
}
