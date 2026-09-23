import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { GraphData, GraphViewComponent } from './graph-view';
import { SimulationViewComponent } from './simulation-view';
import { SnapshotViewComponent } from './snapshot-view';
import { ChatPanelComponent } from './chat-panel';
import { RequestFlowsViewComponent } from './request-flows-view';
import { RequestFlowSelectionContext } from './request-flow.types';

export type AppTab = 'map' | 'flows' | 'snapshot' | 'simulate';

@Component({
  imports: [
    GraphViewComponent,
    RequestFlowsViewComponent,
    SimulationViewComponent,
    SnapshotViewComponent,
    ChatPanelComponent,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly graph = signal<GraphData | null>(null);
  protected readonly activeTab = signal<AppTab>('map');
  protected readonly chatOpen = signal(false);
  protected readonly flowSelectionContext = signal<RequestFlowSelectionContext | null>(null);

  ngOnInit(): void {
    this.http.get<GraphData>('http://localhost:8000/graph').subscribe((graph) => {
      console.log(graph);
      this.graph.set(graph);
    });
  }

  protected setTab(tab: AppTab): void {
    if (tab !== 'flows') {
      this.flowSelectionContext.set(null);
    }
    this.activeTab.set(tab);
  }

  protected readonly pendingFlowId = signal<string | null>(null);

  protected openFlow(flowId: string): void {
    this.pendingFlowId.set(flowId);
    this.setTab('flows');
  }

  protected setFlowSelectionContext(context: RequestFlowSelectionContext | null): void {
    this.flowSelectionContext.set(context);
  }

  protected toggleChat(): void {
    this.chatOpen.update((open) => !open);
  }
}
