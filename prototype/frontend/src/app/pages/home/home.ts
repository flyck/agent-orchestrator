import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NgApexchartsModule, type ApexOptions } from 'ng-apexcharts';
import { catchError, of, Subject, switchMap, takeUntil, timer } from 'rxjs';
import { SettingsService } from '../../services/settings.service';
import {
  TasksService,
  type Task,
  type TaskState,
} from '../../services/tasks.service';
import { CostService, type CostSummary } from '../../services/cost.service';

/**
 * Pipeline state, in order. Each task lives in exactly one state.
 * Implement+Review run interleaved as a single phase ("Build"). After the
 * agent goes Ready, the user reviews in their IDE and clicks one of the
 * two finalize options (commit current / commit new branch).
 */
export const PIPELINE_STATES = ['spec', 'plan', 'build', 'ready', 'finalize'] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

export type TaskKind = 'feature' | 'bugfix' | 'arch';

const STATE_LABELS: Record<PipelineState, string> = {
  spec: 'Spec',
  plan: 'Plan',
  build: 'Implement & Review',
  ready: 'Ready',
  finalize: 'Finalize',
};

const KIND_LABELS: Record<TaskKind, string> = {
  feature: 'feature',
  bugfix: 'bugfix',
  arch: 'arch',
};

function inferKind(workspace: string): TaskKind {
  if (workspace === 'bugfix') return 'bugfix';
  if (workspace === 'arch_compare') return 'arch';
  return 'feature';
}

function progressForState(state: TaskState | null, status: string): number {
  if (status === 'done') return 1;
  if (status === 'failed' || status === 'canceled') return 1;
  switch (state) {
    case 'spec': return 0.15;
    case 'plan': return 0.35;
    case 'build': return 0.65;
    case 'ready': return 0.9;
    case 'finalize': return 0.95;
    default: return 0;
  }
}

interface ViewTask {
  raw: Task;
  state: PipelineState;
  status: 'open' | 'closed';
  kind: TaskKind;
  needsAttention: boolean;
  progress: number;
  worktreePath: string | null;
}

/** ISO date + time, UTC. Hover shows the same; we just want unambiguous text. */
export function formatTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** "5s ago", "12m ago", "2h ago", "3d ago" — coarse but consistent. */
export function relativeTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function toViewTask(t: Task): ViewTask {
  // Closed = task has reached a terminal status (done/failed/canceled).
  const closed = t.status === 'done' || t.status === 'failed' || t.status === 'canceled';
  // Map raw state to pipeline state. If the task is "done" its column should
  // be ready unless it's already in finalize.
  const baseState: PipelineState = (t.current_state ?? 'spec') as PipelineState;
  const state: PipelineState = closed && baseState !== 'finalize' ? 'ready' : baseState;
  return {
    raw: t,
    state,
    status: closed ? 'closed' : 'open',
    kind: inferKind(t.workspace),
    needsAttention: false, // backend doesn't surface this yet
    progress: progressForState(t.current_state ?? null, t.status),
    worktreePath: t.worktree_path,
  };
}

@Component({
  selector: 'app-home-page',
  standalone: true,
  imports: [NgApexchartsModule, FormsModule],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage {
  private settingsApi = inject(SettingsService);
  private tasksApi = inject(TasksService);
  private costApi = inject(CostService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  protected readonly states = PIPELINE_STATES;
  protected readonly stateLabels = STATE_LABELS;
  protected readonly kindLabels = KIND_LABELS;
  protected readonly formatTs = formatTs;
  protected readonly relativeTs = relativeTs;
  protected readonly terminalStatuses = new Set(['done', 'failed', 'canceled']);

  // ─── Real tasks ───────────────────────────────────────────────────────
  protected readonly tasks = signal<ViewTask[]>([]);
  protected readonly tasksLoading = signal(true);
  protected readonly tasksError = signal<string | null>(null);
  protected readonly showClosed = signal(false);

  protected readonly visibleTasks = computed(() => {
    const t = this.tasks();
    return this.showClosed() ? t : t.filter((x) => x.status === 'open');
  });

  protected readonly tasksByState = computed(() => {
    const groups: Record<PipelineState, ViewTask[]> = {
      spec: [], plan: [], build: [], ready: [], finalize: [],
    };
    for (const t of this.visibleTasks()) groups[t.state].push(t);
    // Ready column gets a deterministic order (newest-updated first) so
    // recently-finished tasks float to the top. Other columns keep the
    // backend's order (created_at desc) — they're typically short-lived
    // and inserting churn would make them feel jumpy.
    groups.ready.sort((a, b) => b.raw.updated_at - a.raw.updated_at);
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
  protected readonly selectedTask = computed<ViewTask | null>(() => {
    const id = this.selectedId();
    return id ? this.tasks().find((t) => t.raw.id === id) ?? null : null;
  });
  protected interjectionText = '';

  // ─── Finalize ─────────────────────────────────────────────────────────
  protected readonly finalizeBranch = signal('');
  protected readonly finalizing = signal(false);
  protected readonly finalizeResult = signal<string | null>(null);
  protected readonly finalizeError = signal<string | null>(null);

  selectTask(id: string) {
    const next = this.selectedId() === id ? null : id;
    this.selectedId.set(next);
    this.interjectionText = '';
    this.finalizeResult.set(null);
    this.finalizeError.set(null);
    this.syncQueryParams({ task: next });
  }

  closeDetail() {
    this.selectedId.set(null);
    this.syncQueryParams({ task: null });
  }

  private syncQueryParams(patch: Record<string, string | null>) {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: patch,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  deleteSelectedTask() {
    const sel = this.selectedTask();
    if (!sel) return;
    this.tasksApi.delete(sel.raw.id).subscribe({
      next: () => {
        this.selectedId.set(null);
        this.syncQueryParams({ task: null });
        this.refreshTasks();
      },
      error: (e) =>
        this.finalizeError.set(`delete failed: ${e?.error?.message ?? e?.message ?? e}`),
    });
  }

  sendInterjection() {
    const sel = this.selectedTask();
    if (!sel || !this.interjectionText.trim()) return;
    const text = this.interjectionText;
    this.tasksApi.sendMessage(sel.raw.id, text).subscribe({
      next: () => (this.interjectionText = ''),
      error: (e) => this.finalizeError.set(`send failed: ${e.message ?? e}`),
    });
  }

  finalizeCurrent() {
    this.runFinalize({ strategy: 'current' });
  }

  finalizeNew() {
    const branch = this.finalizeBranch().trim();
    if (!branch) {
      this.finalizeError.set('Branch name required for new-branch finalize.');
      return;
    }
    this.runFinalize({ strategy: 'new', branch });
  }

  private runFinalize(input: { strategy: 'current' | 'new'; branch?: string }) {
    const sel = this.selectedTask();
    if (!sel) return;
    this.finalizing.set(true);
    this.finalizeError.set(null);
    this.finalizeResult.set(null);
    this.tasksApi.finalize(sel.raw.id, input).subscribe({
      next: (r) => {
        this.finalizing.set(false);
        if (r.ok) {
          const shortSha = (r.commit ?? '').slice(0, 8);
          this.finalizeResult.set(
            `Committed ${r.files_committed.length} file(s) on ${r.branch} (${shortSha}).`,
          );
          this.refreshTasks();
        } else {
          this.finalizeError.set('Nothing to commit — working tree was clean.');
        }
      },
      error: (e) => {
        this.finalizing.set(false);
        const msg = e?.error?.message ?? e?.message ?? String(e);
        this.finalizeError.set(`Finalize failed: ${msg}`);
      },
    });
  }

  // ─── Manual-coding nudge banner ───────────────────────────────────────
  protected readonly nudgeVisible = signal(true);
  dismissNudge() {
    this.nudgeVisible.set(false);
  }

  // ─── Token usage chart ────────────────────────────────────────────────
  protected readonly costSummary = signal<CostSummary | null>(null);
  protected readonly costLoading = signal(true);

  protected readonly usageOptions = computed<ApexOptions>(() => {
    const cs = this.costSummary();
    const series =
      cs && cs.series.length > 0
        ? cs.series.map((s) => ({ name: s.provider_id, data: s.data as number[][] }))
        : []; // empty triggers noData
    return {
      chart: {
        type: 'line',
        height: 200,
        toolbar: { show: false },
        zoom: { enabled: false },
        foreColor: '#6E6E69',
        fontFamily: 'Inter, system-ui, sans-serif',
        animations: { enabled: false },
        background: 'transparent',
      },
      series,
      noData: {
        text: cs && cs.series.length === 0
          ? 'No usage recorded yet — run a task to see provider lines'
          : 'Loading…',
        align: 'center',
        verticalAlign: 'middle',
        style: { color: '#A3A19A', fontSize: '11px', fontFamily: 'Inter, sans-serif' },
      },
      stroke: { curve: 'straight', width: 1.5 },
      markers: { size: 3, strokeWidth: 0, hover: { size: 4 } },
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
      legend: {
        fontSize: '11px',
        position: 'top',
        horizontalAlign: 'right',
        markers: { strokeWidth: 0, size: 6 },
      },
      colors: ['#1A1A18', '#6E6E69', '#A66A1F', '#8B1E1E'],
      tooltip: {
        theme: 'light',
        x: { format: 'MMM dd' },
        y: { formatter: (v: number) => `$${v.toFixed(4)}` },
      },
      dataLabels: { enabled: false },
    };
  });

  // ─── Backlog (still placeholders until Phase 13) ──────────────────────
  protected readonly relatedIssues = signal<{ id: string; title: string }[]>([]);
  protected readonly refactorSuggestions = signal<{ id: string; title: string }[]>([]);

  // ─── PR poll setting (display only) ───────────────────────────────────
  protected readonly prPollMinutes = signal<number | null>(null);

  private destroy$ = new Subject<void>();

  constructor() {
    // Hydrate filter + selection from the URL. Only applies on initial nav
    // — subsequent param changes from our own syncQueryParams calls are
    // idempotent (the values already match the signals).
    this.route.queryParamMap
      .pipe(takeUntil(this.destroy$))
      .subscribe((p) => {
        const closed = p.get('closed');
        this.showClosed.set(closed === '1' || closed === 'true');
        const task = p.get('task');
        this.selectedId.set(task && task.length > 0 ? task : null);
      });

    // Settings — one-shot for the PR poll display.
    this.settingsApi.get().subscribe({
      next: (s) => this.prPollMinutes.set(s.pr_review_poll_interval_minutes),
      error: () => this.prPollMinutes.set(null),
    });

    // Tasks — refresh every 5s (covers SSE-less initial wiring).
    timer(0, 5000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          this.tasksApi.list().pipe(
            catchError((e) => {
              this.tasksError.set(e?.message ?? String(e));
              return of({ tasks: [] as Task[] });
            }),
          ),
        ),
      )
      .subscribe((r) => {
        this.tasks.set(r.tasks.map(toViewTask));
        this.tasksLoading.set(false);
        this.tasksError.set(null);
      });

    // Cost — refresh every 15s.
    timer(0, 15000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          this.costApi.summary('7d').pipe(
            catchError(() => of(null)),
          ),
        ),
      )
      .subscribe((cs) => {
        this.costSummary.set(cs);
        this.costLoading.set(false);
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  refreshTasks() {
    this.tasksApi.list().subscribe({
      next: (r) => this.tasks.set(r.tasks.map(toViewTask)),
    });
  }

  toggleClosed() {
    const next = !this.showClosed();
    this.showClosed.set(next);
    this.syncQueryParams({ closed: next ? '1' : null });
  }

  pickUp(_item: { id: string; title: string }) {
    /* Phase 13+ wiring */
  }
}
