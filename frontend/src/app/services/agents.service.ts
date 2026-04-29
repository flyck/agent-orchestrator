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
}
