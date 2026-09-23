import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { RequestFlowsViewComponent } from './request-flows-view';
import { RequestFlowCatalog, RequestFlowSelectionContext } from './request-flow.types';

vi.mock('mermaid', () => ({
  default: {
    render: vi.fn().mockResolvedValue({ svg: '<svg aria-label="sequence"></svg>' }),
  },
}));

const catalog: RequestFlowCatalog = {
  schema_version: '1.0.0',
  generator: { strategy: 'static-evidence-heuristics' },
  limits: { max_depth: 6 },
  warnings: [],
  glossary: {
    flow: 'One evidence-backed path.',
    trigger: 'The entry point.',
    handler: 'The first bound function.',
    database: 'Persistent storage.',
    confidence: 'Strength of scanner evidence.',
    evidence: 'The source relationship.',
  },
  flows: [
    {
      id: 'flow-api',
      service: 'orders',
      trigger: { kind: 'api', label: 'POST /orders' },
      confidence: 'high',
      steps: [
        {
          id: 'step-0',
          kind: 'api-trigger',
          symbol: 'POST /orders',
          label: 'POST /orders',
          file: 'src/routes.ts',
          line: 10,
          confidence: 'high',
          evidence: ['Route registration names the handler'],
        },
        {
          id: 'step-1',
          kind: 'database',
          symbol: 'orders.insert',
          label: 'orders.insert',
          file: 'src/orders.ts',
          line: 30,
          confidence: 'medium',
          evidence: ['Call name matches a boundary heuristic'],
        },
      ],
    },
    {
      id: 'flow-queue',
      service: 'billing',
      trigger: { kind: 'queue', label: 'invoice.created' },
      confidence: 'medium',
      steps: [
        {
          id: 'step-0',
          kind: 'queue-trigger',
          symbol: 'invoice.created',
          label: 'invoice.created',
          file: 'src/billing.ts',
          line: 5,
          confidence: 'high',
          evidence: ['Message type binds this handler'],
        },
      ],
    },
  ],
};

describe('RequestFlowsViewComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RequestFlowsViewComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('loads the catalog, filters it, and emits selected step context', async () => {
    const fixture = TestBed.createComponent(RequestFlowsViewComponent);
    const httpTesting = TestBed.inject(HttpTestingController);
    const contexts: Array<RequestFlowSelectionContext | null> = [];
    fixture.componentInstance.selectionContext.subscribe((context) => contexts.push(context));

    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/request-flows').flush(catalog);
    fixture.detectChanges();
    httpTesting
      .expectOne('http://localhost:8000/request-flows/flow-api/mermaid')
      .flush({ flow_id: 'flow-api', mermaid: 'sequenceDiagram\nA->>B: request' });
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('POST /orders');
    expect(host.textContent).toContain('orders.insert');
    expect(contexts.at(-1)).toEqual({ flowId: 'flow-api' });

    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'invoice.created';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelectorAll('.flow-card')).toHaveLength(1);
    expect(host.querySelector('.flow-card')?.textContent).toContain('invoice.created');

    search.value = '';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('.step')!.click();
    fixture.detectChanges();

    expect(contexts.at(-1)).toEqual({ flowId: 'flow-api', stepId: 'step-0' });
    expect(host.querySelector('.step.selected')).not.toBeNull();
    httpTesting.verify();
  });

  it('shows a useful state when the artifact API is unavailable', () => {
    const fixture = TestBed.createComponent(RequestFlowsViewComponent);
    const httpTesting = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/request-flows').flush(
      { detail: 'Request-flow artifact not found' },
      { status: 404, statusText: 'Not Found' },
    );
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Flows are not ready');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Run the request-flow scan');
    httpTesting.verify();
  });
});
