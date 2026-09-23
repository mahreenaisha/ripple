import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  Input,
  OnDestroy,
  OnInit,
  Output,
  signal,
  computed,
  ViewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import mermaid from 'mermaid';
import {
  FlowKnowledgeFact,
  FlowStoryFanOutMember,
  RequestFlow,
  RequestFlowCatalog,
  RequestFlowMermaid,
  RequestFlowSelectionContext,
  RequestFlowStep,
} from './request-flow.types';

type FilterValue = 'all' | string;

let flowRenderSequence = 0;

@Component({
  selector: 'app-request-flows-view',
  styleUrl: './request-flows-view.scss',
  templateUrl: './request-flows-view.html',
})
export class RequestFlowsViewComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() initialFlowId: string | null = null;
  @Output() readonly selectionContext = new EventEmitter<RequestFlowSelectionContext | null>();
  @ViewChild('diagram') private readonly diagram?: ElementRef<HTMLDivElement>;

  private readonly http = inject(HttpClient);
  private mermaidRequest?: Subscription;
  private viewReady = false;

  protected readonly catalog = signal<RequestFlowCatalog | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly triggerFilter = signal<FilterValue>('all');
  protected readonly confidenceFilter = signal<FilterValue>('all');
  protected readonly selectedFlowId = signal<string | null>(null);
  protected readonly selectedStepId = signal<string | null>(null);
  protected readonly diagramLoading = signal(false);
  protected readonly diagramError = signal<string | null>(null);
  protected readonly mermaidCode = signal('');

  protected readonly triggerKinds = computed(() =>
    [...new Set((this.catalog()?.flows ?? []).map((flow) => flow.trigger.kind))].sort(),
  );
  protected readonly confidenceLevels = computed(() =>
    [...new Set((this.catalog()?.flows ?? []).map((flow) => flow.confidence))].sort(
      (a, b) => this.confidenceRank(a) - this.confidenceRank(b),
    ),
  );
  protected readonly filteredFlows = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return (this.catalog()?.flows ?? []).filter((flow) => {
      if (this.triggerFilter() !== 'all' && flow.trigger.kind !== this.triggerFilter()) {
        return false;
      }
      if (this.confidenceFilter() !== 'all' && flow.confidence !== this.confidenceFilter()) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        flow.service,
        flow.trigger.label,
        flow.trigger.kind,
        flow.confidence,
        flow.story?.category ?? '',
        flow.story?.summary ?? '',
        ...flow.steps.flatMap((step) => [step.label, step.symbol, step.kind, step.file]),
      ].some((value) => value.toLocaleLowerCase().includes(query));
    });
  });
  protected readonly backgroundFlows = computed(() =>
    this.filteredFlows().filter((flow) => this.isBackground(flow)),
  );
  protected readonly groupedFlows = computed(() => {
    const groups = new Map<string, RequestFlow[]>();
    for (const flow of this.filteredFlows()) {
      if (this.isBackground(flow)) {
        continue;
      }
      const group = groups.get(flow.service) ?? [];
      group.push(flow);
      groups.set(flow.service, group);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([service, flows]) => ({ service, flows }));
  });
  protected readonly selectedFlow = computed(
    () =>
      this.catalog()?.flows.find((flow) => flow.id === this.selectedFlowId()) ??
      null,
  );

  ngOnInit(): void {
    this.loadCatalog();
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    void this.renderMermaid();
  }

  ngOnDestroy(): void {
    this.mermaidRequest?.unsubscribe();
    this.selectionContext.emit(null);
  }

  protected loadCatalog(): void {
    this.loading.set(true);
    this.error.set(null);
    this.http.get<RequestFlowCatalog>('http://localhost:8000/request-flows').subscribe({
      next: (catalog) => {
        const safeCatalog = { ...catalog, flows: catalog.flows ?? [] };
        this.catalog.set(safeCatalog);
        this.loading.set(false);
        const first =
          safeCatalog.flows.find((flow) => flow.id === this.initialFlowId) ??
          safeCatalog.flows.find((flow) => this.isBackground(flow)) ??
          safeCatalog.flows[0];
        if (first) {
          this.selectFlow(first);
        }
      },
      error: () => {
        this.catalog.set(null);
        this.loading.set(false);
        this.error.set(
          'Request flows are unavailable. Run the request-flow scan and make sure the API is running.',
        );
      },
    });
  }

  protected updateQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected setTriggerFilter(kind: FilterValue): void {
    this.triggerFilter.set(kind);
  }

  protected setConfidenceFilter(confidence: FilterValue): void {
    this.confidenceFilter.set(confidence);
  }

  protected clearFilters(): void {
    this.query.set('');
    this.triggerFilter.set('all');
    this.confidenceFilter.set('all');
  }

  protected selectFlow(flow: RequestFlow): void {
    if (this.selectedFlowId() === flow.id) {
      return;
    }
    this.selectedStepId.set(null);
    this.selectedFlowId.set(flow.id);
    this.selectionContext.emit({ flowId: flow.id });
    this.loadMermaid(flow.id);
  }

  protected selectStep(step: RequestFlowStep): void {
    const flow = this.selectedFlow();
    if (!flow) {
      return;
    }
    this.selectedStepId.set(step.id);
    this.selectionContext.emit({ flowId: flow.id, stepId: step.id });
  }

  protected selectTerm(term: string): void {
    const flow = this.selectedFlow();
    if (!flow) {
      return;
    }
    const context: RequestFlowSelectionContext = {
      flowId: flow.id,
      term,
    };
    const stepId = this.selectedStepId();
    if (stepId) {
      context.stepId = stepId;
    }
    this.selectionContext.emit(context);
  }

  protected isBackground(flow: RequestFlow): boolean {
    return flow.story?.category === 'background-job';
  }

  protected flowSummary(flow: RequestFlow): string {
    return flow.story?.summary || flow.story?.purpose?.text || this.beginnerSummary(flow);
  }

  protected categoryLabel(flow: RequestFlow): string {
    return (
      {
        'user-request': 'User request',
        'cli-tool': 'Command-line tool',
        'background-job': 'Background job',
        'device-event': 'Device event',
        'platform-event': 'Platform event',
      }[flow.story?.category ?? ''] ?? flow.trigger.kind
    );
  }

  protected storyChecks(flow: RequestFlow): FlowStoryFanOutMember[] {
    const members = (flow.story?.fanOut ?? []).flatMap((group) => group.members);
    return this.isBackground(flow) || members.some((member) => member.touches.length)
      ? members
      : [];
  }

  protected touchList(member: FlowStoryFanOutMember): string {
    return member.touches.map((touch) => touch.system).join(', ');
  }

  protected accessLabel(access: string): string {
    return (
      { write: 'writes to', read: 'reads from', send: 'sends to', check: 'checks' }[access] ?? access
    );
  }

  protected factSource(fact: FlowKnowledgeFact): string {
    const source = fact.source;
    if (source.type === 'person') {
      return [source.name, source.role].filter(Boolean).join(', ');
    }
    if (source.path) {
      return source.line ? `${source.path}:${source.line}` : source.path;
    }
    return source.url ?? source.type;
  }

  protected factKindLabel(fact: FlowKnowledgeFact): string {
    return { tribal: 'Team knowledge', doc: 'Design doc', rule: 'Rule' }[fact.kind] ?? fact.kind;
  }

  protected beginnerSummary(flow: RequestFlow): string {
    const trigger = this.plainTrigger(flow);
    const service = this.shortService(flow.service);
    const layers = this.namedLayers(flow);
    const ending = this.plainEnding(flow);

    if (!layers.length && !ending) {
      return `${trigger} hits ${service}. The scanner found the entry point, but not the later steps yet.`;
    }
    if (!layers.length) {
      return `${trigger} hits ${service}, then ${ending}.`;
    }
    return `${trigger} hits ${service}. Then it goes ${layers.join(' → ')}${ending ? `, and finally ${ending}` : ''}.`;
  }

  private plainTrigger(flow: RequestFlow): string {
    const label = flow.trigger.label;
    if (flow.trigger.kind === 'queue') {
      return `A background message named "${label}"`;
    }
    if (flow.trigger.kind === 'cli') {
      return `A command-line tool named "${label}"`;
    }
    const match = label.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
    if (!match) {
      return `A request named "${label}"`;
    }
    const verb = {
      GET: 'Someone asks for',
      POST: 'Someone creates/sends',
      PUT: 'Someone replaces',
      PATCH: 'Someone updates',
      DELETE: 'Someone deletes',
    }[match[1].toUpperCase()] || 'Someone calls';
    return `${verb} ${this.shortRoute(match[2])}`;
  }

  private shortRoute(route: string): string {
    const cleaned = route
      .replace(/\/odata\/v\{[^}]+\}/gi, '')
      .replace(/\/api\/v\{[^}]+\}/gi, '')
      .replace(/\/tenancy\/\{[^}]+\}/gi, '')
      .replace(/\(\{[^}]+\}\)/g, '')
      .replace(/\/\{[^}]+\}/g, '')
      .replace(/\/+/g, '/')
      .replace(/^\/|\/$/g, '');
    return cleaned || route;
  }

  private shortService(service: string): string {
    return service.includes('.') ? service.split('.').slice(-1)[0] : service;
  }

  private namedLayers(flow: RequestFlow): string[] {
    const layers: string[] = [];
    for (const step of flow.steps) {
      const name = step.symbol.split('.').pop() || step.symbol;
      if (step.kind === 'handler') {
        layers.push(`controller (${name})`);
      } else if (/Adapter/.test(step.symbol)) {
        layers.push(`adapter (${name})`);
      } else if (/Provider/.test(step.symbol) && !['database', 'external', 'queue'].includes(step.kind)) {
        layers.push(`business logic (${name})`);
      }
    }
    return [...new Set(layers)].slice(0, 3);
  }

  private plainEnding(flow: RequestFlow): string {
    const boundary = [...flow.steps].reverse().find((step) =>
      ['database', 'external', 'queue'].includes(step.kind),
    );
    if (!boundary) {
      return '';
    }
    if (boundary.kind === 'database') {
      return `talks to storage (${boundary.label})`;
    }
    if (boundary.kind === 'queue') {
      return `publishes a message (${boundary.label})`;
    }
    return `calls an outside system (${boundary.label})`;
  }

  protected boundaries(flow: RequestFlow): RequestFlowStep[] {
    return flow.steps.filter((step) =>
      ['database', 'external', 'queue'].includes(step.kind),
    );
  }

  protected glossaryEntries(flow: RequestFlow): Array<[string, string]> {
    const glossary = this.catalog()?.glossary ?? {};
    const relevant = new Set([
      'flow',
      'trigger',
      'confidence',
      'evidence',
      flow.trigger.kind,
      ...flow.steps.map((step) => step.kind.replace(/-trigger$/, '')),
    ]);
    return Object.entries(glossary).filter(([term]) => relevant.has(term));
  }

  protected warningText(warning: RequestFlowCatalog['warnings'][number]): string {
    return typeof warning === 'string' ? warning : warning.message || warning.code || 'Scanner warning';
  }

  protected limitationEntries(): Array<[string, unknown]> {
    return Object.entries(this.catalog()?.limits ?? {});
  }

  protected confidenceLabel(value: string): string {
    return `${value.charAt(0).toUpperCase()}${value.slice(1)} confidence`;
  }

  private confidenceRank(value: string): number {
    return value === 'high' ? 0 : value === 'medium' ? 1 : 2;
  }

  private loadMermaid(flowId: string): void {
    this.mermaidRequest?.unsubscribe();
    this.mermaidCode.set('');
    this.diagramError.set(null);
    this.diagramLoading.set(true);
    if (this.diagram?.nativeElement) {
      this.diagram.nativeElement.innerHTML = '';
    }
    this.mermaidRequest = this.http
      .get<RequestFlowMermaid>(
        `http://localhost:8000/request-flows/${encodeURIComponent(flowId)}/mermaid`,
      )
      .subscribe({
        next: (body) => {
          if (this.selectedFlowId() !== flowId) {
            return;
          }
          this.mermaidCode.set(body.mermaid ?? '');
          this.diagramLoading.set(false);
          void this.renderMermaid();
        },
        error: () => {
          if (this.selectedFlowId() === flowId) {
            this.diagramLoading.set(false);
            this.diagramError.set('The sequence diagram could not be loaded for this flow.');
          }
        },
      });
  }

  private async renderMermaid(): Promise<void> {
    const code = this.mermaidCode();
    const host = this.diagram?.nativeElement;
    const flowId = this.selectedFlowId();
    if (!this.viewReady || !host || !code) {
      return;
    }
    try {
      const { svg } = await mermaid.render(`ripple-flow-${++flowRenderSequence}`, code);
      if (this.selectedFlowId() !== flowId || this.mermaidCode() !== code) {
        return;
      }
      host.innerHTML = svg;
      this.diagramError.set(null);
    } catch {
      host.innerHTML = '';
      this.diagramError.set('The sequence diagram could not be rendered.');
    }
  }
}
