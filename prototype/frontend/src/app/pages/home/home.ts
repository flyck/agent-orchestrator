import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Pipeline state, in order. Each task lives in exactly one state.
 * Implement+Review run interleaved as a single phase ("Build"), per the
 * user's framing — review is not a separate gate after implementation.
 */
export const PIPELINE_STATES = ['spec', 'plan', 'build', 'ready'] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

export type TaskKind = 'feature' | 'bugfix' | 'arch';
export type TaskStatus = 'open' | 'closed';

export interface Task {
  id: string;
  title: string;
  kind: TaskKind;
  state: PipelineState;
  status: TaskStatus;
  /** 0..1 — coarse progress inferred from the state by default; finer-grained
   *  values may come from agents (Phase 6+ once the orchestrator emits them). */
  progress: number;
  /** True when an agent is blocked on user input. The card turns amber. */
  needsAttention: boolean;
  /** Path to the worktree on disk, if the task has reached Build or Ready. */
  worktreePath?: string;
}

export interface BacklogItem {
  id: string;
  source: 'github' | 'background-agent' | 'history';
  title: string;
  detail?: string;
  ref?: string;
}

interface ProviderUsageSlice {
  providerId: string;
  label: string;
  spentUsd: number;
  budgetUsd: number | null;
}

const STATE_LABELS: Record<PipelineState, string> = {
  spec: 'Spec',
  plan: 'Plan',
  build: 'Implement & Review',
  ready: 'Ready',
};

const KIND_LABELS: Record<TaskKind, string> = {
  feature: 'feature',
  bugfix: 'bugfix',
  arch: 'arch',
};

@Component({
  selector: 'app-home-page',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage {
  protected readonly states = PIPELINE_STATES;
  protected readonly stateLabels = STATE_LABELS;
  protected readonly kindLabels = KIND_LABELS;

  // ─── Tasks ────────────────────────────────────────────────────────────
  // FIXTURE DATA — replace with /api/tasks GET once the orchestrator lands
  // (Phase 6). Seeded only so the pipeline visuals (column tints, progress
  // bars, attention amber) are visible while iterating on the design.
  protected readonly tasks = signal<Task[]>([
    {
      id: 'demo-1', kind: 'feature', state: 'spec', status: 'open',
      title: 'Timezone-aware logging in the worker pool',
      progress: 0.2, needsAttention: false,
    },
    {
      id: 'demo-2', kind: 'bugfix', state: 'plan', status: 'open',
      title: 'Race in retry backoff when queue is saturated',
      progress: 0.55, needsAttention: true,
    },
    {
      id: 'demo-3', kind: 'arch', state: 'build', status: 'open',
      title: 'Move auth boundary into its own crate',
      progress: 0.7, needsAttention: false,
      worktreePath: '~/.local/share/ao/worktrees/api/feature-7f3a',
    },
    {
      id: 'demo-4', kind: 'feature', state: 'build', status: 'open',
      title: 'Pagination on /search results',
      progress: 0.4, needsAttention: false,
      worktreePath: '~/.local/share/ao/worktrees/api/feature-c1e2',
    },
    {
      id: 'demo-5', kind: 'bugfix', state: 'ready', status: 'open',
      title: 'Fix N+1 in audit log fetcher',
      progress: 1, needsAttention: false,
      worktreePath: '~/.local/share/ao/worktrees/api/bugfix-9a2d',
    },
    {
      id: 'demo-6', kind: 'feature', state: 'ready', status: 'closed',
      title: 'Add request id propagation',
      progress: 1, needsAttention: false,
    },
  ]);
  protected readonly showClosed = signal(false);

  protected readonly visibleTasks = computed(() => {
    const t = this.tasks();
    return this.showClosed() ? t : t.filter((x) => x.status === 'open');
  });

  protected readonly tasksByState = computed(() => {
    const visible = this.visibleTasks();
    const groups: Record<PipelineState, Task[]> = {
      spec: [], plan: [], build: [], ready: [],
    };
    for (const t of visible) groups[t.state].push(t);
    return groups;
  });

  protected readonly openCount = computed(
    () => this.tasks().filter((t) => t.status === 'open').length,
  );
  protected readonly closedCount = computed(
    () => this.tasks().filter((t) => t.status === 'closed').length,
  );

  // ─── Token usage (no historical store yet — empty graph) ──────────────
  protected readonly usage = signal<ProviderUsageSlice[]>([]);

  // ─── Backlog (no integrations / background agents wired yet) ──────────
  protected readonly relatedIssues = signal<BacklogItem[]>([]);
  protected readonly refactorSuggestions = signal<BacklogItem[]>([]);

  toggleClosed() {
    this.showClosed.update((v) => !v);
  }

  /** Promote a backlog item to an active task. Spec gate is then where the user authors intent. */
  pickUp(_item: BacklogItem) {
    // Phase 6+ wiring: POST /api/tasks; then route into spec editor.
    // For now this is a placeholder so the affordance exists in the UI.
  }
}
