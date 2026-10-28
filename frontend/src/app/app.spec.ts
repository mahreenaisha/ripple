import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App, SnapshotList, timeAgo } from './app';
import { By } from '@angular/platform-browser';
import { ChatPanelComponent } from './chat-panel';
import { RequestFlowsViewComponent } from './request-flows-view';
import { vi } from 'vitest';

const snapshotList: SnapshotList = {
  active: 'deviceas',
  current: {
    slug: 'deviceas',
    name: 'DeviceAS',
    source: { commit: '5cf83f5ce92796', branch: 'main', scannedAt: new Date(Date.now() - 2 * 3600000).toISOString() },
  },
  snapshots: [
    { slug: 'deviceas', name: 'DeviceAS' },
    { slug: 'tenancyas', name: 'TenancyAS' },
  ],
};

function flushSnapshots(httpTesting: HttpTestingController, list: SnapshotList = snapshotList): void {
  httpTesting.expectOne('http://localhost:8000/snapshots').flush(list);
}

function flushEmptyFlows(httpTesting: HttpTestingController): void {
  httpTesting.expectOne('http://localhost:8000/request-flows').flush({
    schema_version: '1.0.0',
    generator: {},
    limits: {},
    flows: [],
    warnings: [],
    glossary: {},
  });
}

describe('timeAgo', () => {
  it('describes scan age in short human units', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(timeAgo('2026-09-23T09:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-09-23T09:15:00Z', now)).toBe('45m ago');
    expect(timeAgo('2026-09-23T08:00:00Z', now)).toBe('2h ago');
    expect(timeAgo('2026-09-19T10:00:00Z', now)).toBe('4d ago');
    expect(timeAgo(null, now)).toBe('unknown');
  });
});

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('shows request flows as the only product surface', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Request Flow Explorer');
    expect(compiled.textContent).toContain('No matching flows');
    expect(compiled.querySelector('.tabs')).toBeNull();
    expect(compiled.textContent).not.toContain('Architecture map');
    expect(compiled.textContent).not.toContain('Change impact');
    httpTesting.verify();
  });

  it('keeps a partial source-only warning visible for study snapshots', () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    flushSnapshots(httpTesting, {
      ...snapshotList,
      current: {
        ...snapshotList.current!,
        analysis: {
          mode: 'study',
          completeness: 'partial',
          limitations: ['External package symbols are unavailable.'],
        },
      },
    });
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.study-banner')?.textContent)
      .toContain('Study snapshot — partial source-only analysis');
    httpTesting.verify();
  });

  it('shows scan freshness and reloads flows when switching repositories', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.freshness')?.textContent).toContain('DeviceAS @ 5cf83f5 · scanned 2h ago');

    const select = host.querySelector<HTMLSelectElement>('.repo-switch select')!;
    select.value = 'tenancyas';
    select.dispatchEvent(new Event('change'));
    const post = httpTesting.expectOne('http://localhost:8000/snapshots/active');
    expect(post.request.body).toEqual({ slug: 'tenancyas' });
    const tenancy: SnapshotList = {
      ...snapshotList,
      active: 'tenancyas',
      current: { slug: 'tenancyas', name: 'TenancyAS', source: { commit: 'abcdef1234', scannedAt: new Date().toISOString() } },
    };
    post.flush(tenancy);
    fixture.detectChanges();
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    expect(host.querySelector('.freshness')?.textContent).toContain('TenancyAS @ abcdef1');
    httpTesting.verify();
  });

  it('passes the selected flow context to the flow-only guide', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const flowsView = fixture.debugElement.query(
      By.directive(RequestFlowsViewComponent),
    ).componentInstance as RequestFlowsViewComponent;
    flowsView.selectionContext.emit({ flowId: 'flow-orders', stepId: 'step-1' });
    fixture.detectChanges();

    const guideButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Flow guide')!;
    guideButton.click();
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/chat/status').flush({
      provider: 'openrouter',
      model: 'openrouter/free',
      available: true,
    });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.chat-head h2')?.textContent).toContain(
      'Flow guide',
    );
    const chat = fixture.debugElement.query(By.directive(ChatPanelComponent))
      .componentInstance as ChatPanelComponent;
    expect(chat.context).toEqual({ flowId: 'flow-orders', stepId: 'step-1' });
    httpTesting.verify();
  });

  it('preflights, restores, scans, and activates a local repository', () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    (host.querySelector('.add-repo') as HTMLButtonElement).click();
    fixture.detectChanges();
    const pathInput = host.querySelector<HTMLInputElement>(
      '.add-repo-pop input[type="text"]',
    )!;
    pathInput.value = '/home/me/orders';
    pathInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const checkButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'),
    ).find((button) => button.textContent?.trim() === 'Check repository')!;
    checkButton.click();

    const preflight = httpTesting.expectOne('http://localhost:8000/scans/preflight');
    expect(preflight.request.body).toEqual({ repo_path: '/home/me/orders' });
    preflight.flush({
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
      dotnet: { executable: '/usr/bin/dotnet', version: '10.0.403' },
      solutions: ['Orders.sln'],
      nuget_config: 'nuget.config',
    });
    fixture.detectChanges();

    expect(
      host.querySelector<HTMLInputElement>('.mode-choice input[value="study"]')?.checked,
    ).toBe(true);
    expect(host.querySelector<HTMLInputElement>('.restore-choice input')?.disabled).toBe(true);
    const verifiedMode = host.querySelector<HTMLInputElement>(
      '.mode-choice input[value="verified"]',
    )!;
    verifiedMode.checked = true;
    verifiedMode.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(host.querySelector<HTMLInputElement>('.restore-choice input')?.checked).toBe(true);
    const scanButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'),
    ).find((button) => button.textContent?.trim() === 'Scan repository')!;
    scanButton.click();
    const start = httpTesting.expectOne('http://localhost:8000/scans');
    expect(start.request.body).toEqual({
      repo_path: '/home/me/orders',
      name: 'Orders',
      solution: 'Orders.sln',
      restore_packages: true,
      analysis_mode: 'verified',
    });
    start.flush({
      id: 'job-1',
      phase: 'restoring',
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
      restore_packages: true,
      analysis_mode: 'verified',
      logs: [],
      error: null,
      result: null,
    });

    vi.advanceTimersByTime(1000);
    httpTesting.expectOne('http://localhost:8000/scans/job-1').flush({
      id: 'job-1',
      phase: 'complete',
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
      restore_packages: true,
      analysis_mode: 'verified',
      logs: ['Scan complete'],
      error: null,
      result: { snapshot: 'orders', counts: { flows: 4 }, warnings: 0 },
    });
    const orders: SnapshotList = {
      active: 'orders',
      current: { slug: 'orders', name: 'Orders', counts: { flows: 4 } },
      snapshots: [...snapshotList.snapshots, { slug: 'orders', name: 'Orders' }],
    };
    httpTesting.expectOne('http://localhost:8000/snapshots').flush(orders);
    fixture.detectChanges();
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    expect(host.textContent).toContain('4 flows · snapshot orders');
    expect(host.querySelector<HTMLSelectElement>('.repo-switch select')?.value).toBe('orders');
    httpTesting.verify();
    vi.useRealTimers();
  });

  it('surfaces preflight errors and can cancel a running scan', () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    (host.querySelector('.add-repo') as HTMLButtonElement).click();
    fixture.detectChanges();
    const pathInput = host.querySelector<HTMLInputElement>(
      '.add-repo-pop input[type="text"]',
    )!;
    pathInput.value = '/missing';
    pathInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    Array.from(host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'))
      .find((button) => button.textContent?.trim() === 'Check repository')!
      .click();
    httpTesting
      .expectOne('http://localhost:8000/scans/preflight')
      .flush({ detail: 'Repository path is not accessible.' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(host.textContent).toContain('Repository path is not accessible.');

    pathInput.value = '/home/me/orders';
    pathInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    Array.from(host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'))
      .find((button) => button.textContent?.trim() === 'Check repository')!
      .click();
    httpTesting.expectOne('http://localhost:8000/scans/preflight').flush({
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
      dotnet: { executable: '/usr/bin/dotnet', version: '10.0.403' },
      solutions: ['Orders.sln'],
      nuget_config: null,
    });
    fixture.detectChanges();
    Array.from(host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'))
      .find((button) => button.textContent?.trim() === 'Scan repository')!
      .click();
    httpTesting.expectOne('http://localhost:8000/scans').flush({
      id: 'job-2',
      phase: 'scanning',
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
      restore_packages: false,
      analysis_mode: 'study',
      logs: [],
      error: null,
      result: null,
    });
    fixture.detectChanges();

    (host.querySelector('.scan-cancel') as HTMLButtonElement).click();
    const cancel = httpTesting.expectOne('http://localhost:8000/scans/job-2/cancel');
    cancel.flush({
      id: 'job-2',
      phase: 'cancelled',
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
      restore_packages: false,
      analysis_mode: 'study',
      logs: ['Cancellation requested.'],
      error: null,
      result: null,
    });
    fixture.destroy();
    httpTesting.verify();
  });

  it('requires a solution for restore but supports scanning without restore', () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    (host.querySelector('.add-repo') as HTMLButtonElement).click();
    fixture.detectChanges();
    const pathInput = host.querySelector<HTMLInputElement>(
      '.add-repo-pop input[type="text"]',
    )!;
    pathInput.value = '/home/me/monorepo';
    pathInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    Array.from(host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'))
      .find((button) => button.textContent?.trim() === 'Check repository')!
      .click();
    httpTesting.expectOne('http://localhost:8000/scans/preflight').flush({
      repo_path: '/home/me/monorepo',
      name: 'Monorepo',
      slug: 'monorepo',
      dotnet: { executable: '/usr/bin/dotnet', version: '10.0.403' },
      solutions: ['Api.sln', 'Worker.sln'],
      nuget_config: null,
    });
    fixture.detectChanges();

    const verifiedMode = host.querySelector<HTMLInputElement>(
      '.mode-choice input[value="verified"]',
    )!;
    verifiedMode.checked = true;
    verifiedMode.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const scanButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'),
    ).find((button) => button.textContent?.trim() === 'Scan repository')!;
    expect(scanButton.disabled).toBe(true);
    const restore = host.querySelector<HTMLInputElement>('.restore-choice input')!;
    restore.checked = false;
    restore.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(scanButton.disabled).toBe(false);
    scanButton.click();

    const request = httpTesting.expectOne('http://localhost:8000/scans');
    expect(request.request.body).toEqual({
      repo_path: '/home/me/monorepo',
      name: 'Monorepo',
      solution: null,
      restore_packages: false,
      analysis_mode: 'verified',
    });
    request.flush({
      id: 'job-3',
      phase: 'validating',
      repo_path: '/home/me/monorepo',
      name: 'Monorepo',
      slug: 'monorepo',
      restore_packages: false,
      analysis_mode: 'verified',
      logs: [],
      error: null,
      result: null,
    });
    fixture.destroy();
    httpTesting.verify();
  });
});
