import { describe, expect, test } from 'vitest';
import {
  REVIEW_PIPELINE_STATES,
  STATE_LABELS,
  STATE_ROLE,
  relativeTsIso,
  toCard,
} from './review-card';
import type { Task } from '../../services/tasks.service';

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    workspace: 'review',
    status: 'running',
    current_state: 'intake',
    title: 't',
    updated_at: 0,
    created_at: 0,
    ...over,
  } as Task;
}

describe('toCard — pipeline-column mapping', () => {
  test('open task with a valid state → that state', () => {
    const out = toCard(makeTask({ current_state: 'explore', status: 'running' }));
    expect(out.state).toBe('explore');
    expect(out.status).toBe('open');
  });

  test('open task with null current_state → "intake"', () => {
    const out = toCard(makeTask({ current_state: null, status: 'running' }));
    expect(out.state).toBe('intake');
    expect(out.status).toBe('open');
  });

  test('open task with unknown state (legacy) → "ready"', () => {
    const out = toCard(makeTask({ current_state: 'wat-is-this', status: 'running' }));
    expect(out.state).toBe('ready');
    expect(out.status).toBe('open');
  });

  test('closed states bucket as "closed"', () => {
    for (const status of ['done', 'failed', 'canceled'] as const) {
      const out = toCard(makeTask({ status, current_state: 'intake' }));
      expect(out.status).toBe('closed');
    }
  });

  test('closed task with non-ready state → state forced to "ready"', () => {
    const out = toCard(makeTask({ status: 'done', current_state: 'explore' }));
    expect(out.state).toBe('ready');
  });

  test('closed task already in "ready" stays "ready"', () => {
    const out = toCard(makeTask({ status: 'done', current_state: 'ready' }));
    expect(out.state).toBe('ready');
  });
});

describe('REVIEW_PIPELINE_STATES coverage', () => {
  test('every state has a label', () => {
    for (const s of REVIEW_PIPELINE_STATES) {
      expect(STATE_LABELS[s]).toBeTruthy();
    }
  });

  test('every state has a role', () => {
    for (const s of REVIEW_PIPELINE_STATES) {
      expect(STATE_ROLE[s] === 'human' || STATE_ROLE[s] === 'agent').toBe(true);
    }
  });

  test('gates + ready are human-driven, others are agent-driven', () => {
    expect(STATE_ROLE['direction-gate']).toBe('human');
    expect(STATE_ROLE.ready).toBe('human');
    expect(STATE_ROLE.intake).toBe('agent');
    expect(STATE_ROLE.explore).toBe('agent');
    expect(STATE_ROLE['deep-review']).toBe('agent');
    expect(STATE_ROLE.synthesis).toBe('agent');
  });
});

describe('relativeTsIso', () => {
  test('valid ISO → delegates to the relativeTs callback', () => {
    const stub = (ms: number) => `from-${ms}`;
    const ms = Date.parse('2026-05-07T12:00:00Z');
    expect(relativeTsIso('2026-05-07T12:00:00Z', stub)).toBe(`from-${ms}`);
  });

  test('garbage ISO → em dash', () => {
    expect(relativeTsIso('not-a-date', () => 'wrong')).toBe('—');
  });

  test('empty string → em dash', () => {
    expect(relativeTsIso('', () => 'wrong')).toBe('—');
  });
});
