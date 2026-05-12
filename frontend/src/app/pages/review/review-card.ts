/**
 * Pure helpers for the Review page's pipeline-column logic. Lives in
 * its own file so unit tests can import without dragging Angular's
 * @Component decorator and the page's services through. Component
 * file re-exports for the existing imports paths.
 */

import type { Task } from '../../services/tasks.service';

/**
 * PR-review pipeline phases (Design A). Order matters — matches the
 * runner's phase index in `orchestrator/pipelines.ts:PR_REVIEW_GATED_PIPELINE`.
 * Stable enough to be a const-tuple so consumers get exact-state types.
 */
export const REVIEW_PIPELINE_STATES = [
  'intake',
  'explore',
  'direction-gate',
  'deep-review',
  'synthesis',
  'ready',
] as const;
export type ReviewPipelineState = (typeof REVIEW_PIPELINE_STATES)[number];

export const STATE_LABELS: Record<ReviewPipelineState, string> = {
  intake: 'Intake',
  explore: 'Explore',
  'direction-gate': 'Direction',
  'deep-review': 'Deep Review',
  synthesis: 'Synthesis',
  ready: 'Ready',
};

/** Engineer (human) on gates + ready; robot (agent) on the rest. */
export const STATE_ROLE: Record<ReviewPipelineState, 'human' | 'agent'> = {
  intake: 'agent',
  explore: 'agent',
  'direction-gate': 'human',
  'deep-review': 'agent',
  synthesis: 'agent',
  ready: 'human',
};

export interface ReviewCard {
  raw: Task;
  state: ReviewPipelineState;
  status: 'open' | 'closed';
}

/**
 * Map a task's raw current_state into a column on the Review page.
 *
 * Review tasks auto-finalize to status='done' the moment the reviewer
 * agent posts its findings — but the user hasn't actually seen them
 * yet at that point, so we keep the task in the Ready column of the
 * pipeline (status='open' to this UI) until the user explicitly
 * dismisses it via "Mark done", which stamps abandoned_at. failed /
 * canceled tasks go straight to History since the agent didn't
 * produce a usable result.
 *
 * Anything with a current_state that isn't one of the pipeline phases
 * (legacy review-tasks created before Phase 16) maps to 'ready' so
 * old rows still appear in History.
 */
export function toCard(t: Task): ReviewCard {
  const userDismissed = t.abandoned_at !== null;
  const hardFailed = t.status === 'failed' || t.status === 'canceled';
  const closed = userDismissed || hardFailed;
  const raw = (t.current_state ?? 'intake') as string;
  let state: ReviewPipelineState = (
    REVIEW_PIPELINE_STATES as readonly string[]
  ).includes(raw)
    ? (raw as ReviewPipelineState)
    : 'ready';
  if (closed && state !== 'ready') state = 'ready';
  return { raw: t, state, status: closed ? 'closed' : 'open' };
}

/**
 * PR timestamps come as ISO strings, not ms — converts before passing
 * to the shared relativeTs helper. Pulled out as a named function
 * because it shows up in the template multiple times.
 */
export function relativeTsIso(iso: string, relativeTs: (ms: number) => string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? relativeTs(ms) : '—';
}
