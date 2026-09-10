import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
}

@Component({
  selector: 'app-chat-panel',
  styleUrl: './chat-panel.scss',
  templateUrl: './chat-panel.html',
})
export class ChatPanelComponent {
  private readonly http = inject(HttpClient);
  private readonly list = viewChild<ElementRef<HTMLDivElement>>('messageList');

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly draft = signal('');
  protected readonly thinking = signal(false);

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
    const text = this.draft().trim();
    if (!text || this.thinking()) {
      return;
    }

    this.messages.update((history) => [...history, { role: 'user', text }]);
    this.draft.set('');
    this.thinking.set(true);
    this.queueScroll();

    this.http.post<{ response: string }>('http://localhost:8000/chat', { message: text }).subscribe({
      next: (body) => {
        this.thinking.set(false);
        this.messages.update((history) => [
          ...history,
          { role: 'assistant', text: body.response || '(empty reply)' },
        ]);
        this.queueScroll();
      },
      error: () => {
        this.thinking.set(false);
        this.messages.update((history) => [
          ...history,
          { role: 'error', text: 'Something went wrong, try again' },
        ]);
        this.queueScroll();
      },
    });
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
