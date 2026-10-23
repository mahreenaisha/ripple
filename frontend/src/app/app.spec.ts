import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from './api.service';
import { App } from './app';
import { FolderExplanation, RepositoryInventory, RepositoryRecord } from './models';

const repository: RepositoryRecord = {
  id: 'deviceas',
  name: 'DeviceAS',
  path: '/repos/deviceas',
  added_at: '2026-01-01T00:00:00Z',
};

const inventory: RepositoryInventory = {
  repository,
  commit: '1234567890abcdef',
  dirty: false,
  branch: 'main',
  generated_at: '2026-01-01T00:00:00Z',
  entries: [
    {
      name: 'server',
      path: 'server',
      kind: 'folder',
      file_count: 12,
      directory_count: 3,
      languages: [{ language: 'C#', files: 10 }],
      manifests: ['server/Server.csproj'],
      state_hash: 'state',
    },
    {
      name: 'README.md',
      path: 'README.md',
      kind: 'file',
      file_count: 1,
      directory_count: 0,
      languages: [{ language: 'Markdown', files: 1 }],
      manifests: [],
      state_hash: 'readme',
    },
  ],
};

const explanation: FolderExplanation = {
  repository_id: 'deviceas',
  folder: 'server',
  mode: 'full',
  facts: {
    folder: 'server',
    file_count: 12,
    directory_count: 3,
    languages: [{ language: 'C#', files: 10 }],
    manifests: ['server/Server.csproj'],
    entry_points: ['server/Program.cs'],
    state_hash: 'state',
    evidence_hash: 'evidence',
  },
  explanation: {
    summary: 'Defines the DeviceAS web API source.',
    responsibilities: ['Declares API controllers.'],
    evidence: [{ evidence_id: 'E1', reason: 'The controller declaration is present.' }],
    uncertainties: ['Runtime behavior was not analyzed.'],
  },
  evidence: [
    {
      id: 'E1',
      file: 'server/Controllers/DevicesController.cs',
      start_line: 1,
      end_line: 10,
      category: 'api',
      scope: 'file',
      content: '[ApiController]',
    },
  ],
  model: 'qwen2.5-coder:7b',
  prompt_version: 'folder-v1',
  commit: '1234567890abcdef',
  generated_at: '2026-01-01T00:00:00Z',
  cached: false,
  verified_citations: true,
  review_state: 'unreviewed',
  error: null,
};

class FakeApi {
  previewCalls = 0;
  listRepositories = () => of([repository]);
  inventory = () => of(inventory);
  readme = () =>
    of({
      found: true,
      path: 'README.md',
      word_count: 12,
      reading_minutes: 1,
      state_hash: 'readme-state',
      sections: [
        {
          id: 'deviceas',
          heading: 'DeviceAS',
          level: 1,
          start_line: 1,
          end_line: 4,
          content: 'Device service repository overview.',
        },
      ],
    });
  modelStatus = () => of({ available: true, model: 'qwen2.5-coder:7b', detail: 'ready' });
  registerRepository = () => of(repository);
  setReviewed = () => of({ review_state: 'reviewed' });
  explanation = (_repo: string, _folder: string, mode: 'preview' | 'full') => {
    if (mode === 'preview') this.previewCalls += 1;
    return of({ ...explanation, mode });
  };
}

describe('App', () => {
  let fixture: ComponentFixture<App>;
  let api: FakeApi;

  beforeEach(async () => {
    localStorage.clear();
    api = new FakeApi();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(App);
    fixture.detectChanges();
  });

  it('starts with the README journey before showing folders', () => {
    let text = fixture.nativeElement.textContent;
    expect(text).toContain('DeviceAS');
    expect(text).toContain('Read the repository overview');
    expect(text).toContain('Device service repository overview.');

    fixture.componentInstance.skipToFolderStructure();
    fixture.detectChanges();
    text = fixture.nativeElement.textContent;
    expect(text).toContain('server');
    expect(text).toContain('README.md');
    expect(text).toContain('12 files');
  });

  it('shows deterministic facts immediately and lazily loads hover interpretation', async () => {
    fixture.componentInstance.skipToFolderStructure();
    fixture.detectChanges();
    const card: HTMLButtonElement = fixture.nativeElement.querySelector('.folder-card');
    card.dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Observed');
    expect(api.previewCalls).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 275));
    fixture.detectChanges();
    expect(api.previewCalls).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Defines the DeviceAS web API source.');
  });

  it('opens the evidence-oriented details panel when a folder is selected', () => {
    fixture.componentInstance.skipToFolderStructure();
    fixture.detectChanges();
    const card: HTMLButtonElement = fixture.nativeElement.querySelector('.folder-card');
    card.click();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Observed facts');
    expect(text).toContain('AI interpretation');
    expect(text).toContain('Source evidence');
    expect(text).toContain('Uncertainties');
    expect(text).toContain('Citations verified');
  });

  it('validates that a repository path is required', () => {
    const component = fixture.componentInstance;
    component.addRepositoryForm.controls.path.setValue('');
    component.registerRepository();
    expect(component.addRepositoryForm.controls.path.touched).toBe(true);
  });

  it('marks the README reviewed and advances to folder structure', () => {
    fixture.componentInstance.completeReadmeStep();
    fixture.detectChanges();
    expect(fixture.componentInstance.readmeReviewed()).toBe(true);
    expect(fixture.componentInstance.activeJourneyStep()).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('Project root');
  });
});

