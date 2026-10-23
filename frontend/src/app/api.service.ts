import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  FolderExplanation,
  ModelStatus,
  ReadmeDocument,
  RepositoryInventory,
  RepositoryRecord,
} from './models';

export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '/api',
});

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  listRepositories(): Observable<RepositoryRecord[]> {
    return this.http.get<RepositoryRecord[]>(`${this.baseUrl}/repositories`);
  }

  registerRepository(path: string, name?: string): Observable<RepositoryRecord> {
    return this.http.post<RepositoryRecord>(`${this.baseUrl}/repositories`, { path, name: name || null });
  }

  inventory(repositoryId: string): Observable<RepositoryInventory> {
    return this.http.get<RepositoryInventory>(`${this.baseUrl}/repositories/${repositoryId}/inventory`);
  }

  readme(repositoryId: string): Observable<ReadmeDocument> {
    return this.http.get<ReadmeDocument>(`${this.baseUrl}/repositories/${repositoryId}/readme`);
  }

  explanation(
    repositoryId: string,
    folder: string,
    mode: 'preview' | 'full',
  ): Observable<FolderExplanation> {
    const params = new HttpParams().set('folder', folder).set('mode', mode);
    return this.http.get<FolderExplanation>(
      `${this.baseUrl}/repositories/${repositoryId}/explanation`,
      { params },
    );
  }

  setReviewed(repositoryId: string, folder: string, reviewed: boolean): Observable<{ review_state: string }> {
    const params = new HttpParams().set('folder', folder);
    return this.http.post<{ review_state: string }>(
      `${this.baseUrl}/repositories/${repositoryId}/review`,
      { reviewed },
      { params },
    );
  }

  modelStatus(): Observable<ModelStatus> {
    return this.http.get<ModelStatus>(`${this.baseUrl}/model/status`);
  }
}

