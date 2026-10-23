import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  EXPLORER_API_BASE_URL,
  ExplorerApiService,
} from './explorer-api.service';

describe('ExplorerApiService', () => {
  let service: ExplorerApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EXPLORER_API_BASE_URL, useValue: '/configured-api' },
      ],
    });
    service = TestBed.inject(ExplorerApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('uses the configured API base URL', () => {
    service.listRepositories().subscribe();
    http.expectOne('/configured-api/repositories').flush([]);
  });

  it('keeps repository selection in each request', () => {
    service.explanation('repo-123', 'server/controllers', 'preview').subscribe();
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/configured-api/repositories/repo-123/explanation' &&
        candidate.params.get('folder') === 'server/controllers' &&
        candidate.params.get('mode') === 'preview',
    );
    request.flush({});
  });

  it('loads the deterministic root README through the configured API', () => {
    service.readme('repo-123').subscribe();
    http.expectOne('/configured-api/repositories/repo-123/readme').flush({
      found: false,
      sections: [],
    });
  });
});

