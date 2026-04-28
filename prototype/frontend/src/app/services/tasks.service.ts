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
/** Pipeline states. `code` and `review` split the old `build` state; we
 *  keep `build` for tasks that pre-date the split (frontend renders it as
 *  `code` for display purposes). */
export type TaskState =
  | 'spec'
  | 'plan'
  | 'code'
  | 'review'
  | 'build'
  | 'ready'
  | 'finalize';

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
  /** Bumped by the orchestrator each time the reviewer agent sends back to coder. */
  review_cycles: number;
  /** Bumped each time the user clicks Send back with feedback. */
  user_sendbacks: number;
  /** Optional post-hoc tag set in the Ready state. */
  user_rating: 'bad' | null;
  user_rating_comment: string | null;
  /** Multi-phase pipeline this task walks. null = legacy hard-coded
   *  lifecycle. Populated for review-workspace tasks. */
  pipeline_id: string | null;
  /** Phase id the runner paused on, awaiting user approval. null when
   *  not at a gate. Drives the gate banner in the detail panel. */
  awaiting_gate_id: string | null;
  /** Live context-window usage — input-token count from the most recent
   *  assistant message. Drives the on-card "ctx" chip on the home pipeline. */
  latest_input_tokens: number | null;
  latest_tokens_ts: number | null;
  /** JSON-encoded `Record<stage, count>`. Bumped on each state transition.
   *  Stored as a string in SQLite; parse client-side. */
  stage_entries_json: string;
  /** Timestamp the user clicked "Abandon" on this task. null = active or
   *  completed normally. Distinct from delete — the row stays. */
  abandoned_at: number | null;
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

  /** Mark a task as abandoned: cancels any active run, stamps the row,
   *  and emits an `abandon` activity event. The row stays — distinct
   *  from DELETE which removes it entirely. */
  abandon(id: string): Observable<Task> {
    return this.http.post<Task>(`/api/tasks/${id}/abandon`, {});
  }

  /** Manual mark-as-done. Cancels any active run and moves the task to
   *  current_state='finalize' / status='done'. Distinct from finalize()
   *  which runs git ops — this just transitions the row, for when the
   *  user dealt with the work outside the orchestrator. */
  finish(id: string): Observable<Task> {
    return this.http.post<Task>(`/api/tasks/${id}/finish`, {});
  }

  /** Approve a paused pipeline gate so the runner advances to the next
   *  phase. Called by the "approve direction" button. */
  approveGate(id: string): Observable<{ task_id: string }> {
    return this.http.post<{ task_id: string }>(`/api/tasks/${id}/gate/approve`, {});
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

  /** Replace the task's spec markdown. Backend appends a new
   *  spec_revisions row; the agent does NOT auto-pick this up. */
  updateSpec(id: string, spec: string): Observable<Task> {
    return this.http.put<Task>(`/api/tasks/${id}/spec`, { spec });
  }

  /** Newest-first list of past spec revisions. */
  listRevisions(id: string): Observable<{ revisions: SpecRevision[] }> {
    return this.http.get<{ revisions: SpecRevision[] }>(`/api/tasks/${id}/revisions`);
  }

  /** Set or clear the post-hoc rating. `rating=null` clears it. */
  setRating(
    id: string,
    rating: 'bad' | null,
    comment: string | null,
  ): Observable<Task> {
    return this.http.post<Task>(`/api/tasks/${id}/rating`, { rating, comment });
  }

  /** Read the planner agent's execution-context notes from
   *  `.agent-notes/<task_id>.md` in the worktree. exists=false when
   *  the planner hasn't produced one yet. */
  getNotes(id: string): Observable<{ exists: boolean; content: string | null; path?: string }> {
    return this.http.get<{ exists: boolean; content: string | null; path?: string }>(
      `/api/tasks/${id}/notes`,
    );
  }

  /** Read the task's radar-chart scoring (per-axis rows). */
  getScoring(id: string): Observable<{ scoring: TaskScoringRow[] }> {
    return this.http.get<{ scoring: TaskScoringRow[] }>(`/api/tasks/${id}/scoring`);
  }

  /** Reviewer-agent verdicts (newest cycle first). Empty when the
   *  reviewer hasn't run yet. */
  getReviews(id: string): Observable<{ reviews: TaskReviewRow[] }> {
    return this.http.get<{ reviews: TaskReviewRow[] }>(`/api/tasks/${id}/reviews`);
  }

  /** Alternative-solution candidates the reviewer suggested for this
   *  task. Each carries its own complexity-radar scoring + verdict. */
  getAlternatives(id: string): Observable<{ alternatives: TaskAlternativeRow[] }> {
    return this.http.get<{ alternatives: TaskAlternativeRow[] }>(
      `/api/tasks/${id}/alternatives`,
    );
  }
}

export interface TaskScoringRow {
  task_id: string;
  dimension: string;
  score: number;
  rationale: string | null;
  set_by: string;
  updated_at: number;
}

export interface ReviewFinding {
  severity: 'info' | 'low' | 'medium' | 'high';
  confidence: 'high' | 'medium' | 'low';
  location: string;
  title: string;
  detail: string;
}

export interface TaskReviewRow {
  id: number;
  task_id: string;
  cycle: number;
  decision: 'accept' | 'send_back';
  notes: string | null;
  raw_text: string | null;
  /** Reviewer's confidence in its decision. null for older rows. */
  confidence: 'high' | 'medium' | 'low' | null;
  /** JSON-encoded ReviewFinding[]. Parse client-side. */
  findings_json: string | null;
  created_at: number;
}

export type AlternativeVerdict = 'better' | 'equal' | 'worse';

export interface TaskAlternativeRow {
  id: number;
  task_id: string;
  label: string;
  description: string;
  /** JSON-encoded `Record<dimension, 1..10>`. Parse client-side. */
  scores_json: string;
  /** JSON-encoded `Record<dimension, sentence>`, optional. */
  rationales_json: string | null;
  verdict: AlternativeVerdict;
  rationale: string | null;
  set_by: string;
  created_at: number;
}

export interface SpecRevision {
  id: number;
  task_id: string;
  version: number;
  spec_md: string;
  created_at: number;
}
