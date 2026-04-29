import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface TaskIssueLink {
  task_id: string;
  repo: string;
  issue_number: number;
  title_snapshot: string | null;
  url_snapshot: string | null;
  linked_at: number;
}

@Injectable({ providedIn: 'root' })
export class IssueLinksService {
  private http = inject(HttpClient);

  list(taskId: string): Observable<{ links: TaskIssueLink[] }> {
    return this.http.get<{ links: TaskIssueLink[] }>(
      `/api/tasks/${taskId}/issue-links`,
    );
  }

  add(taskId: string, ref: string, repo?: string): Observable<{ link: TaskIssueLink }> {
    const body: { ref: string; repo?: string } = { ref };
    if (repo) body.repo = repo;
    return this.http.post<{ link: TaskIssueLink }>(
      `/api/tasks/${taskId}/issue-links`,
      body,
    );
  }

  remove(taskId: string, repo: string, issueNumber: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(
      `/api/tasks/${taskId}/issue-links/${repo}/${issueNumber}`,
    );
  }

  /** Batch fetch links for many task ids — used by the home page to
   *  show a #N chip on each pipeline card. */
  byTasks(ids: string[]): Observable<{ links: Record<string, TaskIssueLink[]> }> {
    return this.http.get<{ links: Record<string, TaskIssueLink[]> }>(
      `/api/tasks/issue-links/by-tasks`,
      { params: { ids: ids.join(',') } },
    );
  }
}
