import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { KnowledgeFormComponent } from './knowledge-form';
import { RequestFlow } from './request-flow.types';

const flow: RequestFlow = {
  id: 'flow-api',
  service: 'orders',
  trigger: { kind: 'api', label: 'POST /orders' },
  confidence: 'high',
  steps: [
    {
      id: 'step-1',
      kind: 'database',
      symbol: 'orders.insert',
      label: 'OpenSearch',
      file: 'src/orders.ts',
      line: 30,
      confidence: 'high',
      evidence: [],
    },
  ],
};

function type(host: HTMLElement, selector: string, value: string): void {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('KnowledgeFormComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [KnowledgeFormComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('checks the cited file and saves a fact scoped to the flow and chosen systems', () => {
    const fixture = TestBed.createComponent(KnowledgeFormComponent);
    fixture.componentRef.setInput('flow', flow);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const http = TestBed.inject(HttpTestingController);
    const saved: unknown[] = [];
    fixture.componentInstance.saved.subscribe((fact) => saved.push(fact));

    type(host, 'input[name=title]', 'Ids carry the tenant');
    type(host, 'textarea[name=text]', 'Every id starts with the tenant id.');
    type(host, 'input[name=path]', 'docs/design.md');
    type(host, 'input[name=line]', '12');
    fixture.detectChanges();

    host.querySelector<HTMLButtonElement>('button.check')!.click();
    http
      .expectOne((request) => request.url.endsWith('/repo-file') && request.params.get('line') === '12')
      .flush({ path: 'docs/design.md', lines: 40, line: 12, excerpt: 'Ids are tenant-prefixed.' });
    fixture.detectChanges();
    expect(host.querySelector('.found')?.textContent).toContain('12: Ids are tenant-prefixed.');

    const systemBox = [...host.querySelectorAll<HTMLLabelElement>('.applies label')]
      .find((label) => label.textContent?.includes('OpenSearch'))!
      .querySelector('input')!;
    systemBox.click();
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('button.primary')!.click();

    const request = http.expectOne((req) => req.url.endsWith('/knowledge/facts'));
    expect(request.request.body).toEqual({
      title: 'Ids carry the tenant',
      text: 'Every id starts with the tenant id.',
      kind: 'doc',
      path: 'docs/design.md',
      line: 12,
      triggers: ['POST /orders'],
      boundaries: ['OpenSearch'],
    });
    request.flush({ id: 'ids-carry-the-tenant' });
    expect(saved).toEqual([{ id: 'ids-carry-the-tenant' }]);
  });

  it('shows the backend reason when the file is not in the repo', () => {
    const fixture = TestBed.createComponent(KnowledgeFormComponent);
    fixture.componentRef.setInput('flow', flow);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    type(host, 'input[name=path]', 'nope.md');
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('button.check')!.click();
    TestBed.inject(HttpTestingController)
      .expectOne((request) => request.url.endsWith('/repo-file'))
      .flush({ detail: 'No file at nope.md in the repo' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(host.querySelector('.error')?.textContent).toContain('No file at nope.md in the repo');
  });
});
