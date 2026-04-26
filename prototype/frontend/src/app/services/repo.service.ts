import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface DiffFile {
  path: string;
  status: string; // git porcelain XY (e.g. " M", "??")
  added: number;
  deleted: number;
}

export interface DiffResponse {
  repo_root: string;
  files: DiffFile[];
  patch: string;
  truncated: boolean;
  fetched_at: number;
}

export interface OpenResponse {
  ok: boolean;
  cmd: string;
  args: string[];
  target: string;
}

@Injectable({ providedIn: 'root' })
export class RepoService {
  private http = inject(HttpClient);

  diff(): Observable<DiffResponse> {
    return this.http.get<DiffResponse>('/api/repo/diff');
  }

  open(command: 'ide' | 'magit', path?: string): Observable<OpenResponse> {
    return this.http.post<OpenResponse>('/api/repo/open', { command, path });
  }
}
