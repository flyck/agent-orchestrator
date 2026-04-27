import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NgApexchartsModule, type ApexOptions } from 'ng-apexcharts';
import { catchError, of, Subject, merge, switchMap, takeUntil, timer } from 'rxjs';
import { SettingsService } from '../../services/settings.service';
import {
  TasksService,
  type Task,
  type TaskState,
} from '../../services/tasks.service';
import { CostService, type CostSummary } from '../../services/cost.service';
import { RepoService, type DiffResponse } from '../../services/repo.service';
import { TaskStreamService, type StreamEvent } from '../../services/task-stream.service';
import { NewTaskDialog } from '../../components/new-task-dialog';
import type { Subscription } from 'rxjs';

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

function deriveProgress(t: Task): {
  progress: number;
  hasReportedProgress: boolean;
  step: number;
  total: number;
} {
  // Agent-reported step / total is the only honest signal. Without it we
  // refuse to fake a percentage — the bar stays empty and the label says
  // 0/0 (planning) so the user isn't misled by a bar stuck at 60%.
  if (
    typeof t.current_step === 'number' &&
    typeof t.total_steps === 'number' &&
    t.total_steps > 0
  ) {
    return {
      progress: Math.max(0, Math.min(1, t.current_step / t.total_steps)),
      hasReportedProgress: true,
      step: t.current_step,
      total: t.total_steps,
    };
  }
  // Closed tasks: full bar. Otherwise: empty + 0/0.
  const closed = t.status === 'done' || t.status === 'failed' || t.status === 'canceled';
  return {
    progress: closed ? 1 : 0,
    hasReportedProgress: false,
    step: 0,
    total: 0,
  };
}

interface ViewTask {
  raw: Task;
  state: PipelineState;
  status: 'open' | 'closed';
  kind: TaskKind;
  needsAttention: boolean;
  /** 0..1 — only used when hasReportedProgress; otherwise ignored. */
  progress: number;
  /** True when the agent has reported a step plan. */
  hasReportedProgress: boolean;
  /** Step / total — shown explicitly. 0/0 means "discovering, no plan yet". */
  step: number;
  total: number;
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

interface StreamLine {
  ts: number;
  tag: string;
  text: string;
  /** Severity affects visual treatment in the log. */
  level: 'info' | 'tool' | 'text' | 'error' | 'status' | 'perm';
}

/** Persisted message tail — what the user sees in the "last responses"
 *  panel when the live stream isn't connected. */
export interface TranscriptLine {
  role: string;
  text: string;
  ts: number | null;
}

/**
 * Convert one raw engine event into a single log line. The shell pane
 * renders these directly. Text parts get the latest content (opencode
 * emits cumulative text per part-update); tool calls collapse to a tag.
 */
export function formatStreamLine(ev: StreamEvent): StreamLine {
  const ts = ev.ts;
  const raw = ev.raw as { properties?: any };
  const props = raw?.properties ?? {};
  switch (ev.type) {
    case 'message.part.updated': {
      const part = props.part;
      if (part?.type === 'text' && typeof part.text === 'string') {
        const text = part.text.trim();
        return { ts, tag: 'text', text, level: 'text' };
      }
      if (part?.type === 'tool' || part?.type === 'tool-invocation' || part?.type === 'tool-result') {
        const name = part.tool ?? part.toolName ?? part.type;
        const id = part.id ? ` ${String(part.id).slice(0, 8)}` : '';
        return { ts, tag: 'tool', text: `${name}${id}`, level: 'tool' };
      }
      return { ts, tag: 'part', text: part?.type ?? '?', level: 'info' };
    }
    case 'message.updated': {
      const info = props.info;
      if (info?.role === 'assistant' && info?.finish) {
        const tokens = info.tokens ?? {};
        const cost = typeof info.cost === 'number' ? `$${info.cost.toFixed(4)}` : '?';
        return {
          ts,
          tag: 'asst-done',
          text: `finish=${info.finish} in=${tokens.input ?? 0} out=${tokens.output ?? 0} ${cost}`,
          level: 'info',
        };
      }
      if (info?.error) {
        const msg = (info.error as { data?: { message?: string } })?.data?.message ?? 'error';
        return { ts, tag: 'asst-error', text: String(msg).slice(0, 200), level: 'error' };
      }
      return { ts, tag: 'message', text: info?.role ?? '', level: 'info' };
    }
    case 'session.status': {
      return { ts, tag: 'status', text: props.status?.type ?? '', level: 'status' };
    }
    case 'session.diff': {
      return { ts, tag: 'diff', text: 'session emitted file diff', level: 'info' };
    }
    case 'session.idle': {
      return { ts, tag: 'idle', text: 'session idle', level: 'status' };
    }
    case 'session.error': {
      return { ts, tag: 'error', text: 'session error', level: 'error' };
    }
    case 'permission.asked': {
      const perm = props.permission ?? props.tool?.toolName ?? '?';
      return { ts, tag: 'perm', text: `${perm} (auto-granted)`, level: 'perm' };
    }
    case 'subscribed': {
      return { ts, tag: 'sse', text: 'subscribed', level: 'status' };
    }
    default:
      return { ts, tag: ev.type, text: '', level: 'info' };
  }
}

function toViewTask(t: Task): ViewTask {
  // Closed = task has reached a terminal status (done/failed/canceled).
  const closed = t.status === 'done' || t.status === 'failed' || t.status === 'canceled';
  // Map raw state to pipeline state. If the task is "done" its column should
  // be ready unless it's already in finalize.
  const baseState: PipelineState = (t.current_state ?? 'spec') as PipelineState;
  const state: PipelineState = closed && baseState !== 'finalize' ? 'ready' : baseState;
  const p = deriveProgress(t);
  return {
    raw: t,
    state,
    status: closed ? 'closed' : 'open',
    kind: inferKind(t.workspace),
    needsAttention: t.needs_feedback === 1,
    progress: p.progress,
    hasReportedProgress: p.hasReportedProgress,
    step: p.step,
    total: p.total,
  };
}

@Component({
  selector: 'app-home-page',
  standalone: true,
  imports: [NgApexchartsModule, FormsModule, NewTaskDialog],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage {
  private settingsApi = inject(SettingsService);
  private tasksApi = inject(TasksService);
  private costApi = inject(CostService);
  private repoApi = inject(RepoService);
  private streamApi = inject(TaskStreamService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  protected readonly states = PIPELINE_STATES;
  protected readonly stateLabels = STATE_LABELS;
  protected readonly kindLabels = KIND_LABELS;
  protected readonly formatTs = formatTs;
  protected readonly relativeTs = relativeTs;
  protected readonly terminalStatuses = new Set(['done', 'failed', 'canceled']);

  /** Ticks every second so the per-card "Xs in this stage" counters stay live
   *  without waiting for the 5s task-list poll. Cheap — pure signal update,
   *  no I/O. */
  protected readonly nowTick = signal(Date.now());

  /** Compact "Xs / Xm Ys / Xh Ym" format for stage timers. */
  protected secondsInState(t: ViewTask): string {
    const since = t.raw.state_entered_at ?? t.raw.updated_at;
    const sec = Math.max(0, Math.round((this.nowTick() - since) / 1000));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  }

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
  protected readonly queueState = signal<{ active: string[]; pending: string[]; max: number } | null>(null);
  protected readonly runningCount = computed(() => this.queueState()?.active.length ?? 0);
  protected readonly queuedCount = computed(() => this.queueState()?.pending.length ?? 0);
  protected readonly maxParallel = computed(() => this.queueState()?.max ?? null);

  // ─── Inline task expansion ────────────────────────────────────────────
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selectedTask = computed<ViewTask | null>(() => {
    const id = this.selectedId();
    return id ? this.tasks().find((t) => t.raw.id === id) ?? null : null;
  });
  protected interjectionText = '';

  // Tab within the detail card. Persisted in the URL as ?tab= so reload
  // and direct-link both keep their place.
  protected readonly detailTabs = ['spec', 'stream', 'files'] as const;
  protected readonly detailTab = signal<(typeof this.detailTabs)[number]>('stream');
  setDetailTab(tab: (typeof this.detailTabs)[number]) {
    this.detailTab.set(tab);
    this.syncQueryParams({ tab });
  }

  // ─── Finalize ─────────────────────────────────────────────────────────
  protected readonly finalizeBranch = signal('');
  protected readonly finalizing = signal(false);
  protected readonly finalizeResult = signal<string | null>(null);
  protected readonly finalizeError = signal<string | null>(null);

  // ─── Working-tree changes for selected task ───────────────────────────
  protected readonly diff = signal<DiffResponse | null>(null);
  protected readonly diffLoading = signal(false);
  protected readonly diffError = signal<string | null>(null);
  protected readonly showPatch = signal(false);
  protected readonly openMessage = signal<string | null>(null);

  // ─── Live SSE stream for selected task ────────────────────────────────
  // Capped ring buffer of recent events, rendered as the shell pane. Older
  // events fall off so memory stays bounded across long-running tasks.
  protected readonly streamEvents = signal<StreamEvent[]>([]);
  protected readonly streamConnected = signal(false);
  /** Persisted-tail backfill: messages from opencode when live stream is dead. */
  protected readonly transcriptTail = signal<TranscriptLine[]>([]);
  protected readonly transcriptLoading = signal(false);
  /** Most recent text emitted by the assistant, by part id. opencode emits
   *  full part replacements per update — we keep the latest text per part
   *  so the rendering stays stable. */
  private partTexts = new Map<string, string>();
  private streamSub: Subscription | null = null;
  private static readonly STREAM_BUFFER_LIMIT = 250;

  /** Derived: condense raw events into a human-readable line list. */
  protected readonly streamLines = computed(() => {
    return this.streamEvents().map((ev) => formatStreamLine(ev));
  });

  togglePatch() {
    this.showPatch.update((v) => !v);
  }

  protected readonly hasIdeCommand = signal(false);
  protected readonly hasEmacsCommand = signal(false);
  protected readonly hasMagitCommand = signal(false);

  selectTask(id: string) {
    const next = this.selectedId() === id ? null : id;
    this.selectedId.set(next);
    this.interjectionText = '';
    this.finalizeResult.set(null);
    this.finalizeError.set(null);
    this.openMessage.set(null);
    this.syncQueryParams({ task: next });
    if (next) {
      this.refreshDiff();
      this.openStream(next);
      // If the task is closed (Ready), the SSE stream won't have anything
      // to deliver — so backfill the persisted opencode transcript so the
      // user sees where the conversation ended.
      const t = this.tasks().find((x) => x.raw.id === next);
      if (t && t.status === 'closed' && t.raw.last_session_id) {
        this.refreshTranscript(next);
      } else {
        this.transcriptTail.set([]);
      }
    } else {
      this.diff.set(null);
      this.transcriptTail.set([]);
      this.closeStream();
    }
  }

  refreshTranscript(taskId: string) {
    this.transcriptLoading.set(true);
    this.tasksApi.transcript(taskId).subscribe({
      next: (r) => {
        const lines: TranscriptLine[] = [];
        for (const m of (r.messages ?? []) as Array<{
          info?: { role?: string; time?: { created?: number } };
          parts?: Array<{ type?: string; text?: string }>;
        }>) {
          const role = m.info?.role ?? 'unknown';
          const text = (m.parts ?? [])
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text!)
            .join('')
            .trim();
          if (!text) continue;
          lines.push({ role, text, ts: m.info?.time?.created ?? null });
        }
        // Tail only — last 6 messages keep it readable.
        this.transcriptTail.set(lines.slice(-6));
        this.transcriptLoading.set(false);
      },
      error: () => {
        this.transcriptTail.set([]);
        this.transcriptLoading.set(false);
      },
    });
  }

  private openStream(taskId: string) {
    this.closeStream();
    this.streamEvents.set([]);
    this.partTexts.clear();
    this.streamConnected.set(false);
    this.streamSub = this.streamApi.open(taskId).subscribe({
      next: (ev) => {
        this.streamConnected.set(true);
        // Track per-part text for the rolling assistant transcript.
        if (ev.type === 'message.part.updated') {
          const part = (ev.raw as {
            properties?: { part?: { id?: string; type?: string; text?: string } };
          }).properties?.part;
          if (part?.type === 'text' && typeof part.text === 'string' && part.id) {
            this.partTexts.set(part.id, part.text);
          }
        }
        // Append to the capped ring buffer. Use update to keep change detection cheap.
        this.streamEvents.update((arr) => {
          const next = arr.length >= HomePage.STREAM_BUFFER_LIMIT ? arr.slice(1) : arr.slice();
          next.push(ev);
          return next;
        });
      },
      complete: () => this.streamConnected.set(false),
      error: () => this.streamConnected.set(false),
    });
  }

  private closeStream() {
    this.streamSub?.unsubscribe();
    this.streamSub = null;
    this.streamConnected.set(false);
  }

  closeDetail() {
    this.selectedId.set(null);
    this.syncQueryParams({ task: null });
    this.closeStream();
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

  forceCompleteSelectedTask() {
    const sel = this.selectedTask();
    if (!sel) return;
    this.tasksApi.forceComplete(sel.raw.id).subscribe({
      next: () => this.refreshTasks(),
      error: (e) =>
        this.finalizeError.set(`force-complete failed: ${e?.error?.message ?? e?.message ?? e}`),
    });
  }

  /** Spec-editor dialog. The "+ new task" button calls show() on it,
   *  and on success we auto-select the new task so the user lands on
   *  its detail panel and can watch the live stream immediately. */
  protected readonly newTaskDialog = viewChild<NewTaskDialog>('newTaskDialog');
  openNewTaskDialog() {
    this.newTaskDialog()?.show();
  }
  onTaskCreated(id: string) {
    this.refreshTasks();
    this.selectedId.set(id);
    this.detailTab.set('stream');
    this.syncQueryParams({ task: id, tab: 'stream' });
    this.openStream(id);
  }

  /** While task is open: forward the comment as a live in-session message.
   *  When the task is closed (Ready): re-run the orchestrator with the comment
   *  as feedback — the task transitions back to Build with a fresh session. */
  sendInterjection() {
    const sel = this.selectedTask();
    const text = this.interjectionText.trim();
    if (!sel || !text) return;

    if (sel.status === 'open') {
      this.tasksApi.sendMessage(sel.raw.id, text).subscribe({
        next: () => { this.interjectionText = ''; },
        error: (e) => this.finalizeError.set(`send failed: ${e.message ?? e}`),
      });
    } else {
      this.tasksApi.continueWithFeedback(sel.raw.id, text).subscribe({
        next: () => {
          this.interjectionText = '';
          this.refreshTasks();
        },
        error: (e) =>
          this.finalizeError.set(`send-back failed: ${e?.error?.message ?? e?.message ?? e}`),
      });
    }
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
  // Driven by the backend counter: backend bumps `completed_since_last_nudge`
  // on every successful task termination; banner is shown once that hits
  // the configured threshold. Dismiss zeroes the counter server-side.
  // `threshold = 0` disables the nudge entirely.
  protected readonly nudgeCompleted = signal(0);
  protected readonly nudgeThreshold = signal(0);
  protected readonly nudgeVisible = computed(() => {
    const t = this.nudgeThreshold();
    return t > 0 && this.nudgeCompleted() >= t;
  });
  dismissNudge() {
    // Optimistic — hide immediately, then sync the counter from the server.
    this.nudgeCompleted.set(0);
    this.settingsApi.dismissNudge().subscribe({
      next: (s) => {
        this.nudgeCompleted.set(s.completed_since_last_nudge);
        this.nudgeThreshold.set(s.manual_coding_nudge_after_n_tasks);
      },
    });
  }

  // ─── Token usage chart ────────────────────────────────────────────────
  protected readonly costSummary = signal<CostSummary | null>(null);
  protected readonly costLoading = signal(true);

  // Mirrors the OS-level prefers-color-scheme so the ApexChart palette
  // tracks the rest of the page (which uses CSS @media). Apex doesn't
  // read CSS variables, so we feed it explicit colors per scheme.
  protected readonly darkMode = signal(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  );

  // Selected range for the usage chart. Possible values: 'today', '7d', '30d'
  protected readonly selectedRange = signal<'today' | '7d' | '30d'>('today');
  private readonly rangeChanged = new Subject<void>();
  protected readonly costMeta = computed(() => {
    const r = this.selectedRange();
    return r === 'today' ? 'today' : r === '7d' ? 'last 7 days' : 'last 30 days';
  });

  protected readonly usageOptions = computed<ApexOptions>(() => {
    const cs = this.costSummary();
    const dark = this.darkMode();
    // Palette mirrors the CSS variables in styles.scss for both schemes.
    const ink = dark ? '#E8E6DF' : '#1A1A18';
    const inkMuted = dark ? '#9D9A93' : '#6E6E69';
    const inkFaint = dark ? '#5C5A55' : '#A3A19A';
    const rule = dark ? '#2C2E33' : '#D8D6CF';
    const seriesColors = dark
      ? ['#E8E6DF', '#9D9A93', '#E5B870', '#E69090']
      : ['#1A1A18', '#6E6E69', '#A66A1F', '#8B1E1E'];
    const series =
      cs && cs.series.length > 0
        ? cs.series.map((s) => ({ name: s.provider_id, data: s.data as number[][] }))
        : []; // empty triggers noData

    // Determine x-axis min/max from server range if available, otherwise
    // derive from the selected range.
    const xaxis: any = {
      type: 'datetime',
      axisBorder: { color: rule },
      axisTicks: { color: rule },
      labels: { style: { fontSize: '10px' } },
    };

    if (cs && Number.isFinite(cs.range?.from) && Number.isFinite(cs.range?.to)) {
      const from = cs.range!.from!;
      const to = cs.range!.to!;
      xaxis.min = from;
      xaxis.max = to > from ? to - 1 : to;
    } else {
      const now = Date.now();
      const sel = this.selectedRange();
      if (sel === 'today') {
        const start = new Date();
        start.setUTCHours(0, 0, 0, 0);
        xaxis.min = start.getTime();
        xaxis.max = now;
      } else if (sel === '7d') {
        xaxis.min = now - 7 * 24 * 60 * 60 * 1000;
        xaxis.max = now;
      } else {
        xaxis.min = now - 30 * 24 * 60 * 60 * 1000;
        xaxis.max = now;
      }
    }

    return {
      chart: {
        type: 'line',
        height: 200,
        toolbar: { show: false },
        zoom: { enabled: false },
        foreColor: inkMuted,
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
        style: { color: inkFaint, fontSize: '11px', fontFamily: 'Inter, sans-serif' },
      },
      stroke: { curve: 'straight', width: 1.5 },
      markers: { size: 3, strokeWidth: 0, hover: { size: 4 } },
      grid: {
        borderColor: rule,
        strokeDashArray: 3,
        xaxis: { lines: { show: false } },
      },
      xaxis,
      yaxis: {
        labels: {
          formatter: (v: number) => `$${v.toFixed(2)}`,
          style: { fontSize: '10px' },
        },
      },
      legend: {
        show: true,
        showForSingleSeries: true, // always show, even with one provider
        fontSize: '11px',
        fontFamily: 'Inter, sans-serif',
        position: 'top',
        horizontalAlign: 'right',
        labels: { colors: ink },
        markers: { strokeWidth: 0, size: 8 },
        itemMargin: { horizontal: 12, vertical: 0 },
      },
      colors: seriesColors,
      tooltip: {
        theme: dark ? 'dark' : 'light',
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
    // Hydrate filter + selection + active detail tab from the URL.
    this.route.queryParamMap
      .pipe(takeUntil(this.destroy$))
      .subscribe((p) => {
        const closed = p.get('closed');
        this.showClosed.set(closed === '1' || closed === 'true');
        const task = p.get('task');
        this.selectedId.set(task && task.length > 0 ? task : null);
        const tab = p.get('tab');
        if (tab === 'spec' || tab === 'stream' || tab === 'files') {
          this.detailTab.set(tab);
        }
      });

    // Settings — poll every 10s. We need the nudge counter to refresh as
    // tasks finish, and one-time fields (IDE commands, poll interval) just
    // come along for the ride; updates are cheap.
    timer(0, 10_000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.settingsApi.get().pipe(catchError(() => of(null)))),
      )
      .subscribe((s) => {
        if (!s) return;
        this.prPollMinutes.set(s.pr_review_poll_interval_minutes);
        this.hasIdeCommand.set(!!s.ide_open_command?.trim());
        this.hasEmacsCommand.set(!!s.emacs_open_command?.trim());
        this.hasMagitCommand.set(!!s.magit_open_command?.trim());
        this.nudgeCompleted.set(s.completed_since_last_nudge);
        this.nudgeThreshold.set(s.manual_coding_nudge_after_n_tasks);
      });

    // Live tick for the stage timers — every 1000ms.
    timer(0, 1000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.nowTick.set(Date.now()));

    // Track OS color-scheme changes so the ApexChart palette flips with
    // the rest of the page (CSS handles itself via @media). Listener is
    // detached on destroy; older Safari uses the deprecated addListener.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e: MediaQueryListEvent) => this.darkMode.set(e.matches);
      mq.addEventListener?.('change', onChange);
      this.destroy$.subscribe(() => mq.removeEventListener?.('change', onChange));
    }

    // Queue snapshot — every 3s while the Home is open. Cheap (in-memory).
    timer(0, 3000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.tasksApi.queueSnapshot().pipe(catchError(() => of(null)))),
      )
      .subscribe((q) => this.queueState.set(q));

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
    merge(timer(0, 15000), this.rangeChanged.asObservable())
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          this.costApi.summary(this.selectedRange()).pipe(
            catchError(() => of(null)),
          ),
        ),
      )
      .subscribe((cs) => {
        if (!cs) {
          this.costSummary.set(null);
          this.costLoading.set(false);
          return;
        }
        const from = cs.range?.from ?? 0;
        const to = cs.range?.to ?? 0;
        const series = cs.series.map((s) => {
          const pts = [...s.data];
          pts.sort((a, b) => a[0] - b[0]);

          // Remove a leading zero datapoint that matches the period start.
          // Some backends include an empty zero point at `from` which shows
          // as an undesired marker at the left edge. Only drop it when it's
          // exactly at `from` and its value is zero.
          if (pts.length > 1 && Number.isFinite(from) && pts[0][0] === from && pts[0][1] === 0) {
            pts.shift();
          }

          return { ...s, data: pts };
        });
        this.costSummary.set({ ...cs, series });
        this.costLoading.set(false);
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.rangeChanged.complete();
    this.closeStream();
  }

  refreshTasks() {
    this.tasksApi.list().subscribe({
      next: (r) => this.tasks.set(r.tasks.map(toViewTask)),
    });
  }

  refreshDiff() {
    const sel = this.selectedTask();
    if (!sel) return;
    this.diffLoading.set(true);
    this.diffError.set(null);
    // Prefer task-scoped diff (runs git in the task's worktree).
    // Falls back to repo-wide diff for tasks created before worktrees.
    this.tasksApi.diff(sel.raw.id).subscribe({
      next: (d) => {
        this.diff.set(d as DiffResponse);
        this.diffLoading.set(false);
      },
      error: () => {
        const base = sel.raw.worktree_base_ref ?? null;
        this.repoApi.diff({ base }).subscribe({
          next: (d) => {
            this.diff.set(d);
            this.diffLoading.set(false);
          },
          error: (e) => {
            this.diffError.set(e?.message ?? String(e));
            this.diffLoading.set(false);
          },
        });
      },
    });
  }

  /** If the selected task has a worktree, open paths there; otherwise the
   *  parent repo. `path` is a repo-relative file path or undefined for
   *  the root open. */
  openInIde(path?: string) {
    const sel = this.selectedTask();
    const wt = sel?.raw.worktree_path;
    const target = path
      ? wt
        ? `${wt}/${path}`
        : path
      : (wt ?? undefined);
    this.openMessage.set('opening…');
    this.repoApi.open('ide', target).subscribe({
      next: (r) => this.openMessage.set(`launched ${r.cmd} ${r.target}`),
      error: (e) =>
        this.openMessage.set(e?.error?.message ?? `error: ${e?.message ?? e}`),
    });
  }

  openInEmacs(path?: string) {
    const sel = this.selectedTask();
    const wt = sel?.raw.worktree_path;
    const target = path
      ? wt
        ? `${wt}/${path}`
        : path
      : (wt ?? undefined);
    this.openMessage.set('opening emacs…');
    this.repoApi.open('emacs', target).subscribe({
      next: (r) => this.openMessage.set(`launched ${r.cmd} ${r.target}`),
      error: (e) =>
        this.openMessage.set(e?.error?.message ?? `error: ${e?.message ?? e}`),
    });
  }

  openInMagit() {
    const sel = this.selectedTask();
    const wt = sel?.raw.worktree_path ?? undefined;
    this.openMessage.set('opening magit…');
    this.repoApi.open('magit', wt).subscribe({
      next: (r) => this.openMessage.set(`launched ${r.cmd} on ${r.target}`),
      error: (e) =>
        this.openMessage.set(e?.error?.message ?? `error: ${e?.message ?? e}`),
    });
  }

  toggleClosed() {
    const next = !this.showClosed();
    this.showClosed.set(next);
    this.syncQueryParams({ closed: next ? '1' : null });
  }

  setRange(range: 'today' | '7d' | '30d') {
    this.selectedRange.set(range);
    this.rangeChanged.next();
  }

  pickUp(_item: { id: string; title: string }) {
    /* Phase 13+ wiring */
  }
}
