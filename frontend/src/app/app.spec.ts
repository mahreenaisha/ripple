import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';
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

  it('should place the Flows tab between Map and Snapshot and open it', async () => {
    const fixture = TestBed.createComponent(App);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/graph').flush({ nodes: [], edges: [] });
    await fixture.whenStable();
    fixture.detectChanges();

    const tabLabels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.tab'),
    ).map((tab) => tab.textContent?.trim());
    expect(tabLabels).toEqual(['Map', 'Flows', 'Snapshot', 'Simulate']);

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
