import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/** Mirror of the backend enums (db/tasks.ts). Const-asserted objects so
 *  the TS values at call sites are the same shape on both sides — no
 *  drift between frontend and backend literals. */
export const TaskWorkspace = {
  Review: 'review',
  Feature: 'feature',
  Bugfix: 'bugfix',
  ArchCompare: 'arch_compare',
  Background: 'background',
  Internal: 'internal',
} as const;
export type TaskWorkspace = (typeof TaskWorkspace)[keyof typeof TaskWorkspace];

export const TaskQueue = {
  Foreground: 'foreground',
  Background: 'background',
} as const;
export type TaskQueue = (typeof TaskQueue)[keyof typeof TaskQueue];

export const TaskStatus = {
  Queued: 'queued',
  Running: 'running',
  Synthesizing: 'synthesizing',
  Done: 'done',
  Failed: 'failed',
  Canceled: 'canceled',
  FindingsPending: 'findings_pending',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.Done,
  TaskStatus.Failed,
  TaskStatus.Canceled,
]);

export const TaskInputKind = {
  Diff: 'diff',
  Path: 'path',
  Prompt: 'prompt',
  Spec: 'spec',
} as const;
export type TaskInputKind = (typeof TaskInputKind)[keyof typeof TaskInputKind];

export const TaskRating = { Bad: 'bad' } as const;
export type TaskRating = (typeof TaskRating)[keyof typeof TaskRating];

/** High-level task category — drives pipeline selection on the
 *  backend. Mirrors db/tasks.ts:TaskType. */
export const TaskType = { Coding: 'coding', Review: 'review' } as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export function taskTypeFor(workspace: TaskWorkspace): TaskType {
  return workspace === TaskWorkspace.Review ? TaskType.Review : TaskType.Coding;
}

export const Confidence = { High: 'high', Medium: 'medium', Low: 'low' } as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

export const Severity = {
  Info: 'info',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const ReviewDecisionAction = {
  Accept: 'accept',
  SendBack: 'send_back',
} as const;
export type ReviewDecisionAction =
  (typeof ReviewDecisionAction)[keyof typeof ReviewDecisionAction];

export const AlternativeVerdict = {
  Better: 'better',
  Equal: 'equal',
  Worse: 'worse',
} as const;
export type AlternativeVerdict =
  (typeof AlternativeVerdict)[keyof typeof AlternativeVerdict];
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
  input_kind: TaskInputKind;
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
  user_rating: TaskRating | null;
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
  /** Agent-compiled Conventional Commits message generated when the task
   *  reaches Ready. null until generation completes. */
  proposed_commit_message: string | null;
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

  /** Read the agent-compiled (or user-edited) Conventional Commits
   *  message. null when the compiler hasn't run yet — finalize will
   *  fall back to the title. */
  getCommitMessage(id: string): Observable<{ message: string | null }> {
    return this.http.get<{ message: string | null }>(`/api/tasks/${id}/commit-message`);
  }

  /** Persist a user-edited message (or clear with null). */
  setCommitMessage(id: string, message: string | null): Observable<{ message: string | null }> {
    return this.http.post<{ message: string | null }>(
      `/api/tasks/${id}/commit-message`,
      { message },
    );
  }

  /** Force a fresh agent compose, replacing whatever's stored. */
  regenerateCommitMessage(id: string): Observable<{ message: string | null }> {
    return this.http.post<{ message: string | null }>(
      `/api/tasks/${id}/commit-message`,
      { regenerate: true },
    );
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

  /** Per-phase agent outputs captured by the pipeline runner. Used to
   *  pull the intake's concept diagram, the explorer's verdict, etc. */
  getPhaseOutputs(id: string): Observable<{ phase_outputs: TaskPhaseOutputRow[] }> {
    return this.http.get<{ phase_outputs: TaskPhaseOutputRow[] }>(
      `/api/tasks/${id}/phase-outputs`,
    );
  }

  /** Per-task token + cost timeline for the Tokens tab. One row per
   *  assistant-turn — input/output tokens and cost per "step". */
  getUsageEvents(id: string): Observable<{ events: UsageEventRow[] }> {
    return this.http.get<{ events: UsageEventRow[] }>(`/api/tasks/${id}/usage-events`);
  }

  /** Latest scoring axes for many tasks at once. Used by the home
   *  pipeline to render a complexity chip on each card. */
  scoringsSummary(taskIds: string[]): Observable<{
    scorings: Record<string, Record<string, number>>;
  }> {
    return this.http.post<{ scorings: Record<string, Record<string, number>> }>(
      `/api/tasks/scorings/summary`,
      { task_ids: taskIds },
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

export interface TaskPhaseOutputRow {
  id: number;
  task_id: string;
  phase_id: string;
  agent_slug: string;
  output_md: string;
  created_at: number;
}

/** One usage_event row, surfaced to the Tokens tab. cost_usd is the
 *  decoded JS number (backend stores micros). */
export interface UsageEventRow {
  id: number;
  ts: number;
  session_id: string | null;
  provider_id: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
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
  severity: Severity;
  confidence: Confidence;
  location: string;
  title: string;
  detail: string;
}

export interface TaskReviewRow {
  id: number;
  task_id: string;
  cycle: number;
  decision: ReviewDecisionAction;
  notes: string | null;
  raw_text: string | null;
  /** Reviewer's confidence in its decision. null for older rows. */
  confidence: Confidence | null;
  /** JSON-encoded ReviewFinding[]. Parse client-side. */
  findings_json: string | null;
  created_at: number;
}

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
  /** Mermaid flowchart source — concept diagram for this alternative.
   *  null when the explorer didn't draw one. */
  diagram_mermaid: string | null;
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
