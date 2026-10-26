import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App, SnapshotList, timeAgo } from './app';
import { By } from '@angular/platform-browser';
import { ChatPanelComponent } from './chat-panel';
import { RequestFlowsViewComponent } from './request-flows-view';

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
});
