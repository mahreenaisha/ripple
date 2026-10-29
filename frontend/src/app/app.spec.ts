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
    source: {
      commit: '5cf83f5ce92796',
      branch: 'main',
      scannedAt: new Date(Date.now() - 2 * 3600000).toISOString(),
    },
  },
  snapshots: [
    { slug: 'deviceas', name: 'DeviceAS' },
    { slug: 'tenancyas', name: 'TenancyAS' },
  ],
};

function flushSnapshots(
  httpTesting: HttpTestingController,
  list: SnapshotList = snapshotList,
): void {
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

  it('opens request flows by default and offers the evidence-backed Map', () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Request Flow Explorer');
    expect(host.textContent).toContain('No matching flows');
    expect(host.querySelector('.tabs')).not.toBeNull();
    expect(host.querySelector('.tab.active')?.textContent?.trim()).toBe('Flows');
    expect(host.textContent).toContain('Map');
    expect(host.textContent).not.toContain('Change impact');
    httpTesting.verify();
  });

  it('loads the architecture graph only when the Map tab is opened', () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();
    httpTesting.expectNone('http://localhost:8000/architecture-graph');

    const mapTab = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.tab'),
    ).find((button) => button.textContent?.trim() === 'Map')!;
    mapTab.click();
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/architecture-graph').flush({
      schema_version: '1.0.0',
      analysis: { mode: 'study', completeness: 'partial' },
      nodes: [],
      edges: [],
      warnings: [],
    });
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.tab.active')?.textContent?.trim()).toBe('Map');
    expect(host.textContent).toContain('Services, databases, and external systems');
    expect(host.textContent).toContain('Read the map');
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

  it('switches repositories and reloads request flows', () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    flushSnapshots(httpTesting);
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.freshness')?.textContent)
      .toContain('DeviceAS @ 5cf83f5 · scanned 2h ago');
    const select = host.querySelector<HTMLSelectElement>('.repo-switch select')!;
    select.value = 'tenancyas';
    select.dispatchEvent(new Event('change'));
    const post = httpTesting.expectOne('http://localhost:8000/snapshots/active');
    expect(post.request.body).toEqual({ slug: 'tenancyas' });
    post.flush({
      ...snapshotList,
      active: 'tenancyas',
      current: {
        slug: 'tenancyas',
        name: 'TenancyAS',
        source: { commit: 'abcdef1234', scannedAt: new Date().toISOString() },
      },
    });
    fixture.detectChanges();
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    expect(host.querySelector('.freshness')?.textContent).toContain('TenancyAS @ abcdef1');
    httpTesting.verify();
  });

  it('passes the selected flow context to the flow guide', () => {
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

    const chat = fixture.debugElement.query(By.directive(ChatPanelComponent))
      .componentInstance as ChatPanelComponent;
    expect(chat.context).toEqual({ flowId: 'flow-orders', stepId: 'step-1' });
    httpTesting.verify();
  });

  it('checks and scans a repository without build or restore options', () => {
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
    Array.from(host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'))
      .find((button) => button.textContent?.trim() === 'Check repository')!
      .click();
    const preflight = httpTesting.expectOne('http://localhost:8000/scans/preflight');
    expect(preflight.request.body).toEqual({ repo_path: '/home/me/orders' });
    preflight.flush({
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
      dotnet: { executable: '/usr/bin/dotnet', version: '10.0.403' },
    });
    fixture.detectChanges();
    expect(host.textContent).toContain('Source-only · no build or restore');
    expect(host.textContent).not.toContain('Verified project analysis');
    expect(host.textContent).not.toContain('Restore packages first');

    Array.from(host.querySelectorAll<HTMLButtonElement>('.add-repo-pop button'))
      .find((button) => button.textContent?.trim() === 'Scan repository')!
      .click();
    const start = httpTesting.expectOne('http://localhost:8000/scans');
    expect(start.request.body).toEqual({
      repo_path: '/home/me/orders',
      name: 'Orders',
    });
    start.flush({
      id: 'job-1',
      phase: 'scanning',
      repo_path: '/home/me/orders',
      name: 'Orders',
      slug: 'orders',
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
      logs: ['Scan complete'],
      error: null,
      result: {
        snapshot: 'orders',
        counts: { flows: 4 },
        warnings: 1,
        analysis: {
          mode: 'study',
          completeness: 'partial',
          limitations: [],
        },
      },
    });
    httpTesting.expectOne('http://localhost:8000/snapshots').flush({
      active: 'orders',
      current: {
        slug: 'orders',
        name: 'Orders',
        counts: { flows: 4 },
        analysis: {
          mode: 'study',
          completeness: 'partial',
          limitations: [],
        },
      },
      snapshots: [...snapshotList.snapshots, { slug: 'orders', name: 'Orders' }],
    });
    fixture.detectChanges();
    flushEmptyFlows(httpTesting);
    fixture.detectChanges();

    expect(host.textContent).toContain('4 flows · snapshot orders');
    httpTesting.verify();
    vi.useRealTimers();
  });
});
