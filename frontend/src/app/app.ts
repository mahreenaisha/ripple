import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import { ApiService } from './api.service';
import {
  EvidenceItem,
  FolderExplanation,
  ModelStatus,
  ReadmeDocument,
  RepositoryInventory,
  RepositoryRecord,
  RootEntry,
} from './models';

@Component({
  imports: [ReactiveFormsModule],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly api = inject(ApiService);
  private hoverTimer?: ReturnType<typeof setTimeout>;

  readonly repositories = signal<RepositoryRecord[]>([]);
  readonly selectedRepositoryId = signal('');
  readonly inventory = signal<RepositoryInventory | null>(null);
  readonly selectedEntry = signal<RootEntry | null>(null);
  readonly details = signal<FolderExplanation | null>(null);
  readonly previews = signal<Record<string, FolderExplanation>>({});
  readonly hoveredPath = signal<string | null>(null);
  readonly loadingInventory = signal(false);
  readonly loadingDetails = signal(false);
  readonly loadingPreview = signal<string | null>(null);
  readonly registering = signal(false);
  readonly error = signal('');
  readonly modelStatus = signal<ModelStatus | null>(null);
  readonly activeJourneyStep = signal<1 | 2>(1);
  readonly readme = signal<ReadmeDocument | null>(null);
  readonly loadingReadme = signal(false);
  readonly readmeReviewed = signal(false);
  readonly exploredFolders = signal<string[]>([]);

  readonly folders = computed(() => this.inventory()?.entries.filter((entry) => entry.kind === 'folder') ?? []);
  readonly rootFiles = computed(() => this.inventory()?.entries.filter((entry) => entry.kind === 'file') ?? []);
  readonly selectedRepository = computed(
    () => this.repositories().find((repo) => repo.id === this.selectedRepositoryId()) ?? null,
  );
  readonly journeyProgress = computed(() => {
    const reviewed = this.readmeReviewed() ? 1 : 0;
    const explored = this.exploredFolders().length ? 1 : 0;
    return reviewed + explored;
  });

  readonly addRepositoryForm = new FormGroup({
    path: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl('', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.refreshRepositories();
    this.api.modelStatus().subscribe({
      next: (status) => this.modelStatus.set(status),
      error: () =>
        this.modelStatus.set({
          available: false,
          model: 'qwen2.5-coder:7b',
          detail: 'Could not reach the local model service',
        }),
    });
  }

  refreshRepositories(selectId?: string): void {
    this.api.listRepositories().subscribe({
      next: (repositories) => {
        this.repositories.set(repositories);
        const nextId = selectId || this.selectedRepositoryId() || repositories[0]?.id || '';
        if (nextId) this.selectRepository(nextId);
      },
      error: (error) => this.showError(error),
    });
  }

  registerRepository(): void {
    if (this.addRepositoryForm.invalid) {
      this.addRepositoryForm.markAllAsTouched();
      return;
    }
    this.registering.set(true);
    const { path, name } = this.addRepositoryForm.getRawValue();
    this.api
      .registerRepository(path.trim(), name.trim())
      .pipe(finalize(() => this.registering.set(false)))
      .subscribe({
        next: (repository) => {
          this.addRepositoryForm.reset();
          this.refreshRepositories(repository.id);
        },
        error: (error) => this.showError(error),
      });
  }

  selectRepository(repositoryId: string): void {
    if (!repositoryId) return;
    this.selectedRepositoryId.set(repositoryId);
    this.inventory.set(null);
    this.details.set(null);
    this.selectedEntry.set(null);
    this.previews.set({});
    this.readme.set(null);
    this.readmeReviewed.set(false);
    this.exploredFolders.set([]);
    this.activeJourneyStep.set(1);
    this.error.set('');
    this.loadingInventory.set(true);
    this.api
      .inventory(repositoryId)
      .pipe(finalize(() => this.loadingInventory.set(false)))
      .subscribe({
        next: (inventory) => {
          this.inventory.set(inventory);
          this.loadReadme(repositoryId);
        },
        error: (error) => this.showError(error),
      });
  }

  goToJourneyStep(step: 1 | 2): void {
    this.activeJourneyStep.set(step);
  }

  completeReadmeStep(): void {
    this.readmeReviewed.set(true);
    this.activeJourneyStep.set(2);
    this.persistJourneyProgress();
  }

  skipToFolderStructure(): void {
    this.activeJourneyStep.set(2);
  }

  scrollToReadmeSection(sectionId: string): void {
    document.getElementById(`readme-${sectionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  beginPreview(entry: RootEntry): void {
    this.hoveredPath.set(entry.path);
    if (this.previews()[entry.path] || this.loadingPreview() === entry.path) return;
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => this.loadPreview(entry), 250);
  }

  endPreview(entry: RootEntry): void {
    clearTimeout(this.hoverTimer);
    if (this.hoveredPath() === entry.path) this.hoveredPath.set(null);
  }

  openFolder(entry: RootEntry): void {
    this.selectedEntry.set(entry);
    this.details.set(null);
    this.loadingDetails.set(true);
    this.error.set('');
    if (!this.exploredFolders().includes(entry.path)) {
      this.exploredFolders.update((folders) => [...folders, entry.path]);
      this.persistJourneyProgress();
    }
    this.api
      .explanation(this.selectedRepositoryId(), entry.path, 'full')
      .pipe(finalize(() => this.loadingDetails.set(false)))
      .subscribe({
        next: (result) => this.details.set(result),
        error: (error) => this.showError(error),
      });
  }

  toggleReviewed(): void {
    const current = this.details();
    if (!current) return;
    const reviewed = current.review_state !== 'reviewed';
    this.api.setReviewed(current.repository_id, current.folder, reviewed).subscribe({
      next: () => this.details.set({ ...current, review_state: reviewed ? 'reviewed' : 'unreviewed' }),
      error: (error) => this.showError(error),
    });
  }

  evidenceFor(id: string): EvidenceItem | undefined {
    return this.details()?.evidence.find((item) => item.id === id);
  }

  sourceHref(evidence: EvidenceItem): string {
    const repository = this.selectedRepository();
    if (!repository) return '#';
    const path = `${repository.path}/${evidence.file}`.replaceAll('\\', '/');
    return `vscode://file/${path}:${evidence.start_line}`;
  }

  shortCommit(): string {
    return this.inventory()?.commit.slice(0, 8) || 'unknown';
  }

  private loadPreview(entry: RootEntry): void {
    this.loadingPreview.set(entry.path);
    this.api
      .explanation(this.selectedRepositoryId(), entry.path, 'preview')
      .pipe(finalize(() => this.loadingPreview.set(null)))
      .subscribe({
        next: (preview) => this.previews.update((items) => ({ ...items, [entry.path]: preview })),
        error: (error) => this.showError(error),
      });
  }

  private loadReadme(repositoryId: string): void {
    this.loadingReadme.set(true);
    this.api
      .readme(repositoryId)
      .pipe(finalize(() => this.loadingReadme.set(false)))
      .subscribe({
        next: (readme) => {
          this.readme.set(readme);
          this.restoreJourneyProgress();
        },
        error: (error) => this.showError(error),
      });
  }

  private persistJourneyProgress(): void {
    const key = this.journeyStorageKey();
    if (!key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          readmeReviewed: this.readmeReviewed(),
          exploredFolders: this.exploredFolders(),
        }),
      );
    } catch {
      // Progress persistence is optional; repository exploration still works without storage.
    }
  }

  private restoreJourneyProgress(): void {
    const key = this.journeyStorageKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const progress = JSON.parse(raw) as { readmeReviewed?: boolean; exploredFolders?: string[] };
      this.readmeReviewed.set(Boolean(progress.readmeReviewed));
      this.exploredFolders.set(Array.isArray(progress.exploredFolders) ? progress.exploredFolders : []);
      if (progress.readmeReviewed) this.activeJourneyStep.set(2);
    } catch {
      // Ignore invalid or unavailable local progress.
    }
  }

  private journeyStorageKey(): string | null {
    const inventory = this.inventory();
    const readme = this.readme();
    if (!inventory || !readme) return null;
    const sourceState = [
      inventory.commit,
      readme.state_hash,
      ...inventory.entries.map((entry) => `${entry.path}:${entry.state_hash}`),
    ].join('|');
    let hash = 2166136261;
    for (let index = 0; index < sourceState.length; index += 1) {
      hash ^= sourceState.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `ripple:journey:${inventory.repository.id}:${(hash >>> 0).toString(16)}`;
  }

  private showError(error: unknown): void {
    if (error instanceof HttpErrorResponse) {
      this.error.set(error.error?.detail || error.message);
    } else {
      this.error.set(error instanceof Error ? error.message : 'Something went wrong');
    }
  }
}
