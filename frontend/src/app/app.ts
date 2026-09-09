import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { GraphData, GraphViewComponent } from './graph-view';
import { SimulationViewComponent } from './simulation-view';
import { SnapshotViewComponent } from './snapshot-view';

export type AppTab = 'map' | 'snapshot' | 'simulate';

@Component({
  imports: [GraphViewComponent, SimulationViewComponent, SnapshotViewComponent],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly graph = signal<GraphData | null>(null);
  protected readonly activeTab = signal<AppTab>('map');
  protected readonly chatOpen = signal(false);

  ngOnInit(): void {
    this.http.get<GraphData>('http://localhost:8000/graph').subscribe((graph) => {
      console.log(graph);
      this.graph.set(graph);
    });
  }

  protected setTab(tab: AppTab): void {
    this.activeTab.set(tab);
  }

  protected toggleChat(): void {
    this.chatOpen.update((open) => !open);
  }
}
