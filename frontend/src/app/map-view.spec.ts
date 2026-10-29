import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MapViewComponent } from './map-view';

describe('MapViewComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MapViewComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('shows an actionable rescan state when the graph is unavailable', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    const httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:8000/architecture-graph').flush(
      { detail: 'Rescan this repository to create its Map.' },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Rescan this repository to create its Map.',
    );
    httpTesting.verify();
  });
});
