import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export const SuggestionStatus = {
  Shown: 'shown',
  Pinned: 'pinned',
  Dismissed: 'dismissed',
} as const;
export type SuggestionStatus =
  (typeof SuggestionStatus)[keyof typeof SuggestionStatus];

export const SuggestionSource = {
  Integration: 'integration',
  History: 'history',
  Backlog: 'backlog',
} as const;
export type SuggestionSource =
  (typeof SuggestionSource)[keyof typeof SuggestionSource];

export interface Suggestion {
  id: string;
  task_id: string | null;
  source: SuggestionSource;
  source_ref: string;
  title: string;
  body_md: string | null;
  status: SuggestionStatus;
  created_at: number;
  updated_at: number;
}

@Injectable({ providedIn: 'root' })
export class SuggestionsService {
  private http = inject(HttpClient);

  listForTask(taskId: string): Observable<{ suggestions: Suggestion[] }> {
    return this.http.get<{ suggestions: Suggestion[] }>(
      `/api/tasks/${taskId}/suggestions`,
    );
  }

  setStatus(
    taskId: string,
    suggestionId: string,
    status: 'pinned' | 'dismissed',
  ): Observable<{ suggestion: Suggestion }> {
    return this.http.put<{ suggestion: Suggestion }>(
      `/api/tasks/${taskId}/suggestions/${suggestionId}`,
      { status },
    );
  }

  pinned(limit = 20): Observable<{ suggestions: Suggestion[] }> {
    return this.http.get<{ suggestions: Suggestion[] }>(
      `/api/suggestions/pinned`,
      { params: { limit: String(limit) } },
    );
  }

  /** Re-run the GitHub-issue source for the task and return the fresh
   *  list. Used by the "refresh from github" button on the per-task
   *  suggestions panel — picks up state changes the user has made on
   *  github.com without waiting for the next task completion. */
  refresh(taskId: string): Observable<{ suggestions: Suggestion[] }> {
    return this.http.post<{ suggestions: Suggestion[] }>(
      `/api/tasks/${taskId}/suggestions/refresh`,
      {},
    );
  }
}
