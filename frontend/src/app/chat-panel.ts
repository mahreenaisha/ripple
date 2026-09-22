import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, inject, Input, OnInit, signal, viewChild } from '@angular/core';
import { RequestFlowSelectionContext } from './request-flow.types';

export type ChatPanelMode = 'architecture' | 'flow';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
  offline?: boolean;
}

interface ChatStatus {
  provider: string;
  model: string | null;
  available: boolean;
  reason?: string;
}

interface ChatResponse {
  response: string;
  mode?: string;
}

@Component({
  selector: 'app-chat-panel',
  styleUrl: './chat-panel.scss',
  templateUrl: './chat-panel.html',
})
export class ChatPanelComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly list = viewChild<ElementRef<HTMLDivElement>>('messageList');
  private currentMode: ChatPanelMode = 'architecture';
  private currentContext: RequestFlowSelectionContext | null = null;
  private contextKey = '';
  private readonly histories: Record<ChatPanelMode, ChatMessage[]> = {
    architecture: [],
    flow: [],
  };

  @Input()
  set mode(value: ChatPanelMode | undefined) {
    const next = value ?? 'architecture';
    if (next === this.currentMode) {
      return;
    }
    this.histories[this.currentMode] = this.messages();
    this.currentMode = next;
    this.messages.set(this.histories[next]);
    this.queueScroll();
  }

  get mode(): ChatPanelMode {
    return this.currentMode;
  }

  @Input()
  set context(value: RequestFlowSelectionContext | null | undefined) {
    const next = value ?? null;
    const nextKey = next
      ? `${next.flowId}\u0000${next.stepId ?? ''}\u0000${next.term ?? ''}`
      : '';
    if (nextKey !== this.contextKey) {
      this.histories.flow = [];
      if (this.currentMode === 'flow') {
        this.messages.set([]);
      }
      this.contextKey = nextKey;
    }
    this.currentContext = next;
  }

  get context(): RequestFlowSelectionContext | null {
    return this.currentContext;
  }

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly draft = signal('');
  protected readonly thinking = signal(false);
  protected readonly providerStatus = signal<ChatStatus | null>(null);
  protected readonly statusLoading = signal(true);

  ngOnInit(): void {
    this.http.get<ChatStatus>('http://localhost:8000/chat/status').subscribe({
      next: (status) => {
        this.providerStatus.set(status);
        this.statusLoading.set(false);
      },
      error: () => {
        this.providerStatus.set({
          provider: 'offline',
          model: null,
          available: false,
          reason: 'Provider status unavailable',
        });
        this.statusLoading.set(false);
      },
    });
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  protected send(): void {
    this.sendMessage(this.draft().trim());
  }

  protected sendQuickPrompt(prompt: string): void {
    this.sendMessage(prompt);
  }

  protected isFlowMode(): boolean {
    return this.currentMode === 'flow';
  }

  protected contextSummary(): string {
    const context = this.currentContext;
    if (!context) {
      return 'No flow selected';
    }
    const parts = [`Flow ${context.flowId}`];
    if (context.stepId) {
      parts.push(`Step ${context.stepId}`);
    }
    if (context.term) {
      parts.push(`Term ${context.term}`);
    }
    return parts.join(' · ');
  }

  private sendMessage(text: string): void {
    if (!text || this.thinking()) {
      return;
    }

    const requestMode = this.currentMode;
    this.appendMessage(requestMode, { role: 'user', text });
    this.draft.set('');
    this.thinking.set(true);
    this.queueScroll();

    const body: {
      message: string;
      context?: {
        type: 'flow';
        flow_id?: string;
        step_id?: string;
        term?: string;
      };
    } = { message: text };
    if (requestMode === 'flow') {
      const selection = this.currentContext;
      body.context = {
        type: 'flow',
        ...(selection?.flowId ? { flow_id: selection.flowId } : {}),
        ...(selection?.stepId ? { step_id: selection.stepId } : {}),
        ...(selection?.term ? { term: selection.term } : {}),
      };
    }

    this.http.post<ChatResponse>('http://localhost:8000/chat', body).subscribe({
      next: (body) => {
        this.thinking.set(false);
        this.appendMessage(requestMode, {
          role: 'assistant',
          text: body.response || '(empty reply)',
          offline: body.mode === 'offline',
        });
        this.queueScroll();
      },
      error: (error: HttpErrorResponse) => {
        this.thinking.set(false);
        this.appendMessage(requestMode, {
          role: 'error',
          text: this.errorDetail(error),
        });
        this.queueScroll();
      },
    });
  }

  private appendMessage(mode: ChatPanelMode, message: ChatMessage): void {
    if (mode === this.currentMode) {
      this.messages.update((history) => [...history, message]);
      return;
    }
    this.histories[mode] = [...this.histories[mode], message];
  }

  private errorDetail(error: HttpErrorResponse): string {
    const detail = error.error?.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    if (typeof error.error === 'string' && error.error.trim()) {
      return error.error;
    }
    return 'Something went wrong. Try again.';
  }

  private queueScroll(): void {
    setTimeout(() => this.scrollToBottom());
  }

  private scrollToBottom(): void {
    const el = this.list()?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
