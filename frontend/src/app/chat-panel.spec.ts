import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ChatPanelComponent } from './chat-panel';

describe('ChatPanelComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('keeps architecture chat requests backward compatible', () => {
    const fixture = TestBed.createComponent(ChatPanelComponent);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/chat/status').flush({
      provider: 'openrouter',
      model: 'openrouter/free',
      available: true,
    });

    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Explain the architecture';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.composer button') as HTMLButtonElement).click();

    const request = httpTesting.expectOne('http://localhost:8000/chat');
    expect(request.request.body).toEqual({ message: 'Explain the architecture' });
    request.flush({ response: 'Architecture answer', mode: 'llm' });
    httpTesting.verify();
  });

  it('sends quick prompts immediately with the current flow context', () => {
    const fixture = TestBed.createComponent(ChatPanelComponent);
    fixture.componentInstance.mode = 'flow';
    fixture.componentInstance.context = {
      flowId: 'flow-orders',
      stepId: 'step-1',
      term: 'handler',
    };
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/chat/status').flush({
      provider: 'ollama',
      model: 'llama3.1',
      available: true,
    });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ollama · llama3.1');

    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.quick-prompts button',
      ),
    ).map((button) => button.textContent?.trim());
    expect(labels).toEqual([
      'Explain this like I’m new',
      'What can fail here?',
      'Why does this step exist?',
      'Define handler',
    ]);

    const defineButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.quick-prompts button',
      ),
    ).find((button) => button.textContent?.trim() === 'Define handler')!;
    defineButton.click();

    const request = httpTesting.expectOne('http://localhost:8000/chat');
    expect(request.request.body).toEqual({
      message: 'Define handler',
      context: {
        type: 'flow',
        flow_id: 'flow-orders',
        step_id: 'step-1',
        term: 'handler',
      },
    });
    request.flush({ response: 'A handler accepts the request.', mode: 'llm' });
    httpTesting.verify();
  });

  it('shows provider and offline evidence status without disabling chat', () => {
    const fixture = TestBed.createComponent(ChatPanelComponent);
    fixture.componentInstance.mode = 'flow';
    fixture.componentInstance.context = { flowId: 'flow-orders' };
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/chat/status').flush({
      provider: 'openrouter',
      model: 'openrouter/free',
      available: false,
      reason: 'API key is not configured',
    });
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Offline guide');
    expect(host.textContent).toContain('Evidence-based answers without an LLM');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Explain this flow';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (host.querySelector('.composer button') as HTMLButtonElement).click();

    const request = httpTesting.expectOne('http://localhost:8000/chat');
    expect(request.request.body).toEqual({
      message: 'Explain this flow',
      context: { type: 'flow', flow_id: 'flow-orders' },
    });
    request.flush({ response: 'Evidence-backed flow explanation.', mode: 'offline' });
    fixture.detectChanges();

    expect(host.querySelector('.row.offline')).not.toBeNull();
    expect(host.textContent).toContain('Offline evidence guide');
    httpTesting.verify();
  });
});
