import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Settings {
  max_parallel_tasks: number;
  max_agents_per_task: number;
  daily_token_budget_usd: number | null;
  max_parallel_background_agents: number;
  max_background_runs_per_day: number | null;
  background_token_budget_usd_per_day: number | null;
  manual_coding_nudge_after_n_tasks: number;
  completed_since_last_nudge: number;
  engine: string;
  worktree_root: string;
  worktree_max_age_days: number;
  skills_directory: string;
  repo_context_enabled: boolean;
  readme_token_budget: number;
  backlog_token_budget: number;
  ide_open_command: string;
  magit_open_command: string;
  pr_review_poll_interval_minutes: number;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private http = inject(HttpClient);

  get(): Observable<Settings> {
    return this.http.get<Settings>('/api/settings');
  }

  update(patch: Partial<Settings>): Observable<Settings> {
    return this.http.put<Settings>('/api/settings', patch);
  }
}
