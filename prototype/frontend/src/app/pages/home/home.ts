import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgApexchartsModule, type ApexOptions } from 'ng-apexcharts';
import { SettingsService } from '../../services/settings.service';

/**
 * Pipeline state, in order. Each task lives in exactly one state.
 * Implement+Review run interleaved as a single phase ("Build") — review
 * is not a separate gate after implementation.
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
  /** 0..1 — coarse from orchestrator events; finer-grained values come later
   *  from a progress-reporting skill (TBD). */
  progress: number;
  /** True when an agent is blocked on user input. The card flips to amber. */
  needsAttention: boolean;
  /** Path on disk, when the task has reached Build or Ready. */
  worktreePath?: string;
  /** Stub: lines of agent output to show in the inline expansion. */
  shellLines?: string[];
}

export interface BacklogItem {
  id: string;
  source: 'github' | 'background-agent' | 'history';
  title: string;
  detail?: string;
  ref?: string;
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
  imports: [NgApexchartsModule, FormsModule],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage {
  private settingsApi = inject(SettingsService);

  protected readonly states = PIPELINE_STATES;
  protected readonly stateLabels = STATE_LABELS;
  protected readonly kindLabels = KIND_LABELS;

  // ─── Tasks ────────────────────────────────────────────────────────────
  // FIXTURE — replace with /api/tasks GET in Phase 6.
  protected readonly tasks = signal<Task[]>([
    {
      id: 'demo-1', kind: 'feature', state: 'spec', status: 'open',
      title: 'Timezone-aware logging in the worker pool',
      progress: 0.2, needsAttention: false,
      shellLines: [
        '> spec editor open · 2 of 5 sections filled',
        '  Goal       (2 lines)',
        '  Acceptance (4 lines)',
      ],
    },
    {
      id: 'demo-2', kind: 'bugfix', state: 'plan', status: 'open',
      title: 'Race in retry backoff when queue is saturated',
      progress: 0.55, needsAttention: true,
      shellLines: [
        '> architecture-agent · message #4',
        '  I think the race is between dispatcher and the cleanup job. Should',
        '  I treat the cleanup job as authoritative, or make dispatcher idempotent?',
        '  ↳ waiting for your input',
      ],
    },
    {
      id: 'demo-3', kind: 'arch', state: 'build', status: 'open',
      title: 'Move auth boundary into its own crate',
      progress: 0.7, needsAttention: false,
      worktreePath: '~/.local/share/ao/worktrees/api/feature-7f3a',
      shellLines: [
        '> implementer · running',
        '  edit src/auth/mod.rs (+82 -14)',
        '  edit Cargo.toml (+3 -0)',
        '> reviewer-architecture · streaming',
        '  flagging boundary leak in fn refresh_token_inner — should not be pub',
      ],
    },
    {
      id: 'demo-4', kind: 'feature', state: 'build', status: 'open',
      title: 'Pagination on /search results',
      progress: 0.4, needsAttention: false,
      worktreePath: '~/.local/share/ao/worktrees/api/feature-c1e2',
      shellLines: [
        '> implementer · message #2',
        '  Adding cursor-based pagination. Default page size 25.',
      ],
    },
    {
      id: 'demo-5', kind: 'bugfix', state: 'ready', status: 'open',
      title: 'Fix N+1 in audit log fetcher',
      progress: 1, needsAttention: false,
      worktreePath: '~/.local/share/ao/worktrees/api/bugfix-9a2d',
      shellLines: [
        '> synthesizer · 3 findings (1 high, 2 low)',
        '  high · src/audit/fetch.rs:42 — N+1 resolved by single SELECT IN (...)',
        '  low  · two TODOs left from previous attempt',
      ],
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
    const groups: Record<PipelineState, Task[]> = { spec: [], plan: [], build: [], ready: [] };
    for (const t of this.visibleTasks()) groups[t.state].push(t);
    return groups;
  });

  protected readonly openCount = computed(
    () => this.tasks().filter((t) => t.status === 'open').length,
  );
  protected readonly closedCount = computed(
    () => this.tasks().filter((t) => t.status === 'closed').length,
  );

  // ─── Inline task expansion ────────────────────────────────────────────
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selectedTask = computed<Task | null>(() => {
    const id = this.selectedId();
    return id ? this.tasks().find((t) => t.id === id) ?? null : null;
  });
  protected interjectionText = '';

  selectTask(id: string) {
    this.selectedId.update((cur) => (cur === id ? null : id));
    this.interjectionText = '';
  }

  closeDetail() {
    this.selectedId.set(null);
  }

  sendInterjection() {
    if (!this.interjectionText.trim() || !this.selectedTask()) return;
    // TODO Phase 7: post over WebSocket to the active agent session.
    this.interjectionText = '';
  }

  // ─── Manual-coding nudge banner ───────────────────────────────────────
  protected readonly nudgeVisible = signal(true); // FIXTURE: wired to backend counter in Phase 11
  dismissNudge() {
    this.nudgeVisible.set(false);
  }

  // ─── Token usage chart ────────────────────────────────────────────────
  protected readonly usageOptions: Partial<ApexOptions> = {
    chart: {
      type: 'line',
      height: 160,
      toolbar: { show: false },
      zoom: { enabled: false },
      foreColor: '#6E6E69',
      fontFamily: 'Inter, system-ui, sans-serif',
      animations: { enabled: false },
    },
    series: [], // empty until backend records cost rows
    noData: {
      text: 'AWAITING DATA — provider lines will appear here once tasks run',
      align: 'center',
      style: { color: '#A3A19A', fontSize: '11px' },
    },
    stroke: { curve: 'straight', width: 1.5 },
    grid: {
      borderColor: '#D8D6CF',
      strokeDashArray: 3,
      xaxis: { lines: { show: false } },
    },
    xaxis: {
      type: 'datetime',
      axisBorder: { color: '#D8D6CF' },
      axisTicks: { color: '#D8D6CF' },
      labels: { style: { fontSize: '10px' } },
    },
    yaxis: {
      labels: {
        formatter: (v: number) => `$${v.toFixed(2)}`,
        style: { fontSize: '10px' },
      },
    },
    legend: { fontSize: '11px', position: 'top', horizontalAlign: 'right' },
    colors: ['#1A1A18', '#6E6E69', '#A66A1F', '#8B1E1E'],
    tooltip: { theme: 'light' },
  };

  // ─── Backlog ──────────────────────────────────────────────────────────
  protected readonly relatedIssues = signal<BacklogItem[]>([]);
  protected readonly refactorSuggestions = signal<BacklogItem[]>([]);
  protected readonly prsAwaitingReview = signal<BacklogItem[]>([]);

  // ─── PR poll setting (display only) ───────────────────────────────────
  protected readonly prPollMinutes = signal<number | null>(null);
  constructor() {
    this.settingsApi.get().subscribe({
      next: (s) => this.prPollMinutes.set(s.pr_review_poll_interval_minutes),
      error: () => this.prPollMinutes.set(null),
    });
  }

  toggleClosed() {
    this.showClosed.update((v) => !v);
  }

  pickUp(_item: BacklogItem) {
    // Phase 6+: POST /api/tasks; route into spec editor.
  }
}
