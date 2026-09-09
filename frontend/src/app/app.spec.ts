import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';
import { GraphViewComponent } from './graph-view';
import { Component, Input } from '@angular/core';
import { GraphData } from './graph-view';

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
    expect(compiled.textContent).toContain('2 services');
    expect(compiled.textContent).toContain('1 dependencies');
    httpTesting.verify();
  });
});
