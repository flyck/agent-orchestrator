import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Agent {
  id: string;
  slug: string;
  name: string;
  icon: string;
  role: string;
  concurrency_class: 'foreground' | 'background';
  file_path: string;
  prompt_hash: string;
  enabled: boolean;
  is_builtin: boolean;
  created_at: number;
  updated_at: number;
}

@Injectable({ providedIn: 'root' })
export class AgentsService {
  private http = inject(HttpClient);

  list(): Observable<{ agents: Agent[] }> {
    return this.http.get<{ agents: Agent[] }>('/api/agents');
  }

  get(id: string): Observable<Agent> {
    return this.http.get<Agent>(`/api/agents/${id}`);
  }

  /** Load the raw .md source split into frontmatter + body. Used by
   *  the inline editor in Settings → Agents. */
  getSource(id: string): Observable<{
    slug: string;
    file_path: string;
    frontmatter: string;
    body: string;
    raw: string;
  }> {
    return this.http.get<{
      slug: string;
      file_path: string;
      frontmatter: string;
      body: string;
      raw: string;
    }>(`/api/agents/${id}/source`);
  }

  /** Persist edits to the agent's .md. The backend recomposes the
   *  --- … --- envelope and writes the file. The pipeline runner
   *  reads agent prompts at module init so a backend restart is
   *  needed for changes to take effect — surfaced as
   *  `requires_restart: true` in the response. */
  saveSource(id: string, fields: { frontmatter: string; body: string }): Observable<{
    ok: true;
    requires_restart: boolean;
    bytes: number;
  }> {
    return this.http.put<{ ok: true; requires_restart: boolean; bytes: number }>(
      `/api/agents/${id}/source`,
      fields,
    );
  }
}
