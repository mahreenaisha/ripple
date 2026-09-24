import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App, SnapshotList, timeAgo } from './app';
import { GraphViewComponent } from './graph-view';
import { Component, Input } from '@angular/core';
import { GraphData } from './graph-view';
import { By } from '@angular/platform-browser';
import { ChatPanelComponent } from './chat-panel';
import { RequestFlowsViewComponent } from './request-flows-view';

@Component({
  selector: 'app-graph-view',
  template: '',
})
class GraphViewStubComponent {
  @Input() graph!: GraphData;
}

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
    })
      .overrideComponent(App, {
        remove: { imports: [GraphViewComponent] },
        add: { imports: [GraphViewStubComponent] },
      })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should show graph counts from the API', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();

    flushSnapshots(httpTesting);
    const req = httpTesting.expectOne('http://localhost:8000/graph');
    expect(req.request.method).toBe('GET');
    req.flush({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b', call_count: 1, avg_latency_ms: 2, error_rate: 0 }],
    });

    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('2 nodes');
    expect(compiled.textContent).toContain('1 dependencies');
    httpTesting.verify();
  });

  it('shows the scanned commit and reloads data when switching repos', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/graph').flush({ nodes: [{ id: 'a' }], edges: [] });
    flushSnapshots(httpTesting);
    await fixture.whenStable();
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
    httpTesting.expectOne('http://localhost:8000/graph').flush({ nodes: [{ id: 'x' }, { id: 'y' }], edges: [] });
    flushSnapshots(httpTesting, tenancy);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.querySelector('.freshness')?.textContent).toContain('TenancyAS @ abcdef1');
    expect(host.textContent).toContain('2 nodes');
    httpTesting.verify();
  });

  it('should place the Flows tab between Map and Snapshot and open it', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/graph').flush({ nodes: [], edges: [] });
    flushSnapshots(httpTesting);
    await fixture.whenStable();
    fixture.detectChanges();

    const tabLabels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.tab'),
    ).map((tab) => tab.textContent?.trim());
    expect(tabLabels).toEqual(['Map', 'Flows', 'Snapshot', 'Impact']);

    const flowsTab = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.tab'),
    ).find((tab) => tab.textContent?.trim() === 'Flows')!;
    flowsTab.click();
    fixture.detectChanges();

    httpTesting.expectOne('http://localhost:8000/request-flows').flush({
      schema_version: '1.0.0',
      generator: {},
      limits: {},
      flows: [],
      warnings: [],
      glossary: {},
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No request flows found');
    httpTesting.verify();
  });

  it('passes flow mode and selection to the Flow guide sidebar', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/graph').flush({ nodes: [], edges: [] });
    flushSnapshots(httpTesting);
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    );
    buttons.find((button) => button.textContent?.trim() === 'Flows')!.click();
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/request-flows').flush({
      schema_version: '1.0.0',
      generator: {},
      limits: {},
      flows: [],
      warnings: [],
      glossary: {},
    });
    fixture.detectChanges();

    const flowsView = fixture.debugElement.query(
      By.directive(RequestFlowsViewComponent),
    ).componentInstance as RequestFlowsViewComponent;
    flowsView.selectionContext.emit({ flowId: 'flow-orders', stepId: 'step-1' });
    fixture.detectChanges();

    buttons.find((button) => button.textContent?.trim() === 'Chat')!.click();
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
    expect(chat.mode).toBe('flow');
    expect(chat.context).toEqual({ flowId: 'flow-orders', stepId: 'step-1' });

    buttons.find((button) => button.textContent?.trim() === 'Map')!.click();
    fixture.detectChanges();
    expect(chat.mode).toBe('architecture');
    expect(chat.context).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.chat-head h2')?.textContent).toContain(
      'Assistant',
    );
    httpTesting.verify();
  });
});
