import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type TaskWorkspace =
  | 'review'
  | 'feature'
  | 'bugfix'
  | 'arch_compare'
  | 'background'
  | 'internal';
export type TaskQueue = 'foreground' | 'background';
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'findings_pending';
export type TaskState = 'spec' | 'plan' | 'build' | 'ready' | 'finalize';

export interface Task {
  id: string;
  workspace: TaskWorkspace;
  queue: TaskQueue;
  title: string;
  input_kind: 'diff' | 'path' | 'prompt' | 'spec';
  input_payload: string;
  repo_path: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  status: TaskStatus;
  current_state: TaskState | null;
  current_step: number | null;
  total_steps: number | null;
  step_label: string | null;
  needs_feedback: number;
  feedback_question: string | null;
  last_session_id: string | null;
  state_entered_at: number | null;
  difficulty: number | null;
  difficulty_justification: string | null;
  difficulty_overridden_by_user: number;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskInput {
  workspace: TaskWorkspace;
  queue?: TaskQueue;
  title: string;
  input_kind: Task['input_kind'];
  input_payload: string;
  repo_path?: string | null;
}

export interface FinalizeInput {
  strategy: 'current' | 'new';
  branch?: string;
  message?: string;
}

export interface FinalizeResult {
  ok: boolean;
  branch: string;
  commit: string | null;
  files_committed: string[];
  log: string[];
}

@Injectable({ providedIn: 'root' })
export class TasksService {
  private http = inject(HttpClient);

  list(filters: { workspace?: TaskWorkspace; status?: TaskStatus } = {}): Observable<{ tasks: Task[] }> {
    const params: Record<string, string> = {};
    if (filters.workspace) params['workspace'] = filters.workspace;
    if (filters.status) params['status'] = filters.status;
    return this.http.get<{ tasks: Task[] }>('/api/tasks', { params });
  }

  get(id: string): Observable<Task> {
    return this.http.get<Task>(`/api/tasks/${id}`);
  }

  create(input: CreateTaskInput): Observable<Task> {
    return this.http.post<Task>('/api/tasks', input);
  }

  run(id: string): Observable<{ task_id: string; session_id: string; events_url: string }> {
    return this.http.post<{ task_id: string; session_id: string; events_url: string }>(
      `/api/tasks/${id}/run`,
      {},
    );
  }

  cancel(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/tasks/${id}/cancel`, {});
  }

  forceComplete(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/tasks/${id}/force-complete`, {});
  }

  queueSnapshot(): Observable<{ active: string[]; pending: string[]; max: number }> {
    return this.http.get<{ active: string[]; pending: string[]; max: number }>(
      `/api/tasks/queue/snapshot`,
    );
  }

  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/tasks/${id}`);
  }

  clearFeedback(id: string): Observable<Task> {
    return this.http.post<Task>(`/api/tasks/${id}/clear-feedback`, {});
  }

  transcript(id: string): Observable<{ session_id: string | null; messages: unknown[] }> {
    return this.http.get<{ session_id: string | null; messages: unknown[] }>(
      `/api/tasks/${id}/transcript`,
    );
  }

  diff(id: string): Observable<{
    repo_root: string;
    base: string;
    base_resolved: boolean;
    branch?: string | null;
    files: Array<{ path: string; status: string; added: number; deleted: number }>;
    patch: string;
    truncated: boolean;
    fetched_at: number;
  }> {
    return this.http.get(`/api/tasks/${id}/diff`) as Observable<{
      repo_root: string;
      base: string;
      base_resolved: boolean;
      branch?: string | null;
      files: Array<{ path: string; status: string; added: number; deleted: number }>;
      patch: string;
      truncated: boolean;
      fetched_at: number;
    }>;
  }

  sendMessage(id: string, text: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/tasks/${id}/messages`, { text });
  }

  continueWithFeedback(
    id: string,
    message: string,
  ): Observable<{ task_id: string; session_id: string; events_url: string }> {
    return this.http.post<{ task_id: string; session_id: string; events_url: string }>(
      `/api/tasks/${id}/continue`,
      { message },
    );
  }

  finalize(id: string, input: FinalizeInput): Observable<FinalizeResult> {
    return this.http.post<FinalizeResult>(`/api/tasks/${id}/finalize`, input);
  }
}
