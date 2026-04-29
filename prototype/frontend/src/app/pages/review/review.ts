import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, switchMap, takeUntil, timer, catchError, of } from 'rxjs';
import {
  IntegrationsService,
  type GithubPr,
  type PrFilter,
} from '../../services/integrations.service';
import { TasksService, type Task } from '../../services/tasks.service';
import { formatTs, relativeTs } from '../../util/time';

/**
 * PR-review pipeline phases (Design A). Mirrors the order in
 * `orchestrator/pipelines.ts:PR_REVIEW_GATED_PIPELINE`. Kept as its
 * own const here so the Review page is independent of the home
 * (code-task) pipeline list.
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

const STATE_LABELS: Record<ReviewPipelineState, string> = {
  intake: 'Intake',
  explore: 'Explore',
  'direction-gate': 'Direction',
  'deep-review': 'Deep Review',
  synthesis: 'Synthesis',
  ready: 'Ready',
};

/** Engineer (human) on gates + ready; robot (agent) on the rest. */
const STATE_ROLE: Record<ReviewPipelineState, 'human' | 'agent'> = {
  intake: 'agent',
  explore: 'agent',
  'direction-gate': 'human',
  'deep-review': 'agent',
  synthesis: 'agent',
  ready: 'human',
};

interface ReviewCard {
  raw: Task;
  state: ReviewPipelineState;
  status: 'open' | 'closed';
}

/**
 * Map a task's raw current_state into a column on the Review page.
 * Anything that isn't one of the pipeline phases (legacy review-tasks
 * created before Phase 16) maps to 'ready' so old rows still appear
 * in the History at least, and don't visually pollute the new columns.
 */
function toCard(t: Task): ReviewCard {
  const closed = t.status === 'done' || t.status === 'failed' || t.status === 'canceled';
  const raw = (t.current_state ?? 'intake') as string;
  let state: ReviewPipelineState = (REVIEW_PIPELINE_STATES as readonly string[]).includes(raw)
    ? (raw as ReviewPipelineState)
    : 'ready';
  if (closed && state !== 'ready') state = 'ready';
  return { raw: t, state, status: closed ? 'closed' : 'open' };
}

/** PR timestamps come as ISO strings, not ms. Convert before passing to
 *  the shared relativeTs helper. */
function relativeTsIso(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? relativeTs(ms) : '—';
}

@Component({
  selector: 'app-review-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <header class="head">
      <p class="meta">workspace</p>
      <h1>Review</h1>
      <p class="lead">
        Pull requests across your watched repos. Review tasks at the top, the open PR list
        below it (with filters), and a history of everything you've reviewed at the bottom.
      </p>
    </header>

    @if (githubStatus() === 'unknown') {
      <p class="muted small">checking GitHub connection…</p>
    } @else if (githubStatus() === 'disconnected') {
      <aside class="warning">
        <p class="meta">github not connected</p>
        <p>
          Connect a personal access token in
          <a routerLink="/settings">Settings → Integrations</a>
          and pick the repos to watch.
        </p>
      </aside>
    } @else if (githubStatus() === 'no-watched') {
      <aside class="warning">
        <p class="meta">no watched repos</p>
        <p>
          Connected as <strong>&#64;{{ login() }}</strong>. Pick a few repos in
          <a routerLink="/settings">Settings → Integrations</a> to populate this page.
        </p>
      </aside>
    }

    <!-- ─── 1. Active review tasks + pipeline ───────────────────────── -->
    <section class="block pipeline">
      <header class="block-head">
        <div>
          <p class="meta">active review tasks · click a card to open it on Home</p>
          <h2>Pipeline</h2>
        </div>
        <span class="meta">{{ openCount() }} open · {{ closedCount() }} closed</span>
      </header>

      <div class="columns">
        @for (state of states; track state) {
          <div class="column" [attr.data-state]="state">
            <div class="column-head">
              <span class="state-title">
                <span class="role-icon"
                      [class.role-human]="stateRole[state] === 'human'"
                      [class.role-agent]="stateRole[state] === 'agent'">
                  @if (stateRole[state] === 'human') {
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 14h16"/><path d="M5 14a7 7 0 0 1 14 0"/>
                      <path d="M10 7v3"/><path d="M14 7v3"/><path d="M2 18h20"/>
                    </svg>
                  } @else {
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="5" y="8" width="14" height="11" rx="1.5"/>
                      <path d="M12 4v4"/><circle cx="12" cy="3.2" r="0.9"/>
                      <circle cx="9.5" cy="13" r="0.9" fill="currentColor"/>
                      <circle cx="14.5" cy="13" r="0.9" fill="currentColor"/>
                      <path d="M9.5 17h5"/>
                    </svg>
                  }
                </span>
                <span class="state-name">{{ stateLabels[state] }}</span>
              </span>
              <span class="meta">{{ openByState()[state].length }}</span>
            </div>

            @if (openByState()[state].length === 0) {
              <div class="column-empty"><span class="meta">no tasks</span></div>
            } @else {
              @for (vt of openByState()[state]; track vt.raw.id) {
                <button class="task-card" (click)="openOnHome(vt.raw.id)">
                  <div class="task-card-head">
                    <span class="kind">PR review</span>
                    <span class="dot running"></span>
                  </div>
                  <div class="task-title">{{ vt.raw.title }}</div>
                  <div class="task-foot meta">
                    {{ relativeTs(vt.raw.updated_at) }}
                  </div>
                </button>
              }
            }
          </div>
        }
      </div>

      <p class="muted small">
        Detail view (Stream / Review / Files tabs) opens on the Home page when you click a
        card. The same task lives in both views — Home renders the full panel, Review focuses
        on the queue.
      </p>
    </section>

    <!-- ─── 2. Open pull requests with filters ───────────────────────── -->
    @if (githubStatus() === 'connected') {
      <section class="block pr-section">
        <header class="block-head">
          <div>
            <p class="meta">open pull requests · refreshed every 60s</p>
            <h2>Pull requests</h2>
          </div>
          <div class="pr-controls">
            <div class="pr-filter">
              <button type="button"
                      [class.active]="prFilter() === 'awaiting_me'"
                      (click)="setFilter('awaiting_me')">
                awaiting me
              </button>
              <button type="button"
                      [class.active]="prFilter() === 'all_open'"
                      (click)="setFilter('all_open')">
                all open
              </button>
            </div>
            <input class="pr-search"
                   type="text"
                   placeholder="filter title / repo / author…"
                   [(ngModel)]="prSearch" />
            <button type="button" class="meta-action" (click)="refreshPrs()" [disabled]="prsLoading()">
              {{ prsLoading() ? 'loading…' : 'refresh' }}
            </button>
          </div>
        </header>

        @if (prsLoading() && prs().length === 0) {
          <p class="muted small">loading…</p>
        } @else if (filteredPrs().length === 0) {
          <p class="muted small">No PRs match.</p>
        } @else {
          <ul class="pr-list">
            @for (pr of filteredPrs(); track pr.repo + pr.number) {
              <li class="pr-card" [class.faded]="!pr.awaiting_me">
                <div class="pr-head">
                  <a class="pr-title" [href]="pr.url" target="_blank" rel="noopener">
                    {{ pr.title }}
                  </a>
                  @if (pr.draft) { <span class="meta">draft</span> }
                  @if (pr.awaiting_me) {
                    <span class="badge badge-awaiting">awaiting you</span>
                  }
                </div>
                <div class="pr-meta meta">
                  <span class="mono">{{ pr.repo }}#{{ pr.number }}</span>
                  · &#64;{{ pr.author }}
                  · {{ pr.base_ref }} ← {{ pr.head_ref }}
                  · updated {{ relativeTsIso(pr.updated_at) }}
                </div>
                @if (pr.body) {
                  <p class="pr-body">{{ truncateBody(pr.body) }}</p>
                }
                <div class="pr-actions">
                  @if (pr.awaiting_me) {
                    <button class="primary"
                            type="button"
                            [disabled]="busyOn() === pr.repo + '#' + pr.number"
                            (click)="reviewPr(pr)">
                      {{ busyOn() === pr.repo + '#' + pr.number ? 'starting…' : 'review' }}
                    </button>
                  } @else {
                    <button type="button" disabled
                            title="The Review action only spawns a task when GitHub has actually requested @{{ login() }} as a reviewer.">
                      not requested
                    </button>
                  }
                </div>
              </li>
            }
          </ul>
        }

        @if (prError()) {
          <p class="error small">{{ prError() }}</p>
        }
      </section>
    }

    <!-- ─── 3. History — closed review tasks ─────────────────────────── -->
    <section class="block history">
      <header class="block-head">
        <div>
          <p class="meta">history · review tasks you've finished</p>
          <h2>Past reviews</h2>
        </div>
        <span class="meta">{{ closedTasks().length }}</span>
      </header>

      @if (closedTasks().length === 0) {
        <p class="muted small">No completed review tasks yet.</p>
      } @else {
        <ul class="history-list">
          @for (t of closedTasks(); track t.raw.id) {
            <li class="history-row">
              <button type="button" class="history-link" (click)="openOnHome(t.raw.id)">
                <span class="history-title">{{ t.raw.title }}</span>
                <span class="meta">{{ relativeTs(t.raw.updated_at) }}</span>
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .head { margin-bottom: 16px; max-width: 720px; }
      .lead { font-family: var(--font-serif); font-size: 17px; line-height: 1.45; }

      .warning {
        border: 1px solid var(--rule-strong);
        background: var(--paper-soft);
        padding: 12px 16px;
        margin: 16px 0;
        p { margin: 4px 0 0; }
      }

      .small { font-size: 13px; }
      .muted { color: var(--ink-muted); }
      .error { color: var(--ink-red); }

      .block {
        border-top: 1px solid var(--rule);
        padding: 24px 0;
      }
      .block-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 24px;
        margin-bottom: 16px;
        flex-wrap: wrap;
        h2 { margin: 0; }
      }
      .meta-action {
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: transparent;
        border: 1px solid var(--rule-strong);
        padding: 4px 10px;
      }

      /* ─── Pipeline (same shape as Home) ─────────────────── */
      .columns {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 12px;
      }
      @media (max-width: 1280px) {
        .columns { grid-template-columns: repeat(3, 1fr); }
      }
      @media (max-width: 720px) {
        .columns { grid-template-columns: 1fr; }
      }
      .column {
        border: 1px solid var(--rule);
        border-top: 3px solid var(--rule-strong);
        padding: 14px;
        min-height: 200px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        background: var(--paper);
      }
      /* Color the column tops by phase, reusing the home page's
         state-edge tokens so the two pipelines feel coherent. */
      .column[data-state='intake']         { border-top-color: var(--state-spec-edge); }
      .column[data-state='explore']        { border-top-color: var(--state-plan-edge); }
      .column[data-state='direction-gate'] { border-top-color: var(--ink-amber); }
      .column[data-state='deep-review']    { border-top-color: var(--state-build-edge); }
      .column[data-state='synthesis']      { border-top-color: var(--state-plan-edge); }
      .column[data-state='ready']          { border-top-color: var(--state-ready-edge); }
      .column-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .state-title { display: inline-flex; align-items: center; gap: 6px; }
      .state-name {
        font-family: var(--font-serif);
        font-size: 15px;
      }
      .role-icon { display: inline-flex; height: 14px; width: 14px; }
      .role-icon.role-human { color: var(--ink); }
      .role-icon.role-agent { color: var(--ink-muted); }
      .column-empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px dashed var(--rule);
        padding: 16px 8px;
      }
      .task-card {
        display: block;
        width: 100%;
        text-align: left;
        color: var(--ink);
        border: 1px solid var(--rule);
        padding: 12px 14px;
        background: var(--paper);
        cursor: pointer;
        font: inherit;
      }
      .task-card:hover { background: var(--paper-soft); }
      .task-card-head { display: flex; justify-content: space-between; align-items: center; }
      .kind {
        font-size: 11.5px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--ink-muted);
      }
      .task-title {
        margin: 8px 0;
        font-size: 14px;
        line-height: 1.35;
        font-family: var(--font-serif);
      }
      .task-foot { font-size: 11.5px; color: var(--ink-muted); }

      /* ─── PR section ────────────────────────────────────── */
      .pr-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .pr-filter { display: flex; gap: 0; }
      .pr-filter button {
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 5px 10px;
        background: transparent;
        border: 1px solid var(--rule-strong);
        color: var(--ink-muted);
        cursor: pointer;
        border-radius: 0;
      }
      .pr-filter button:first-child { border-radius: 2px 0 0 2px; }
      .pr-filter button:last-child  { border-radius: 0 2px 2px 0; border-left: 0; }
      .pr-filter button.active {
        background: var(--ink);
        color: var(--paper);
        border-color: var(--ink);
      }
      .pr-search { width: 240px; font-size: 12.5px; }

      .pr-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 1100px) {
        .pr-list { grid-template-columns: 1fr; }
      }
      .pr-card {
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 12px 14px;
      }
      .pr-card.faded { opacity: 0.65; }
      .pr-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .pr-title {
        font-family: var(--font-serif);
        font-size: 16px;
        text-decoration: none;
        flex: 1;
        min-width: 0;
      }
      .pr-meta { margin-top: 4px; }
      .pr-body {
        font-size: 13px;
        margin: 8px 0;
        color: var(--ink-muted);
        white-space: pre-wrap;
        max-height: 80px;
        overflow: hidden;
      }
      .pr-actions { margin-top: 8px; }
      .badge {
        font-size: 10.5px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        font-family: var(--font-mono);
        padding: 1px 6px;
        border: 1px solid var(--rule-strong);
        border-radius: 8px;
        line-height: 14px;
      }
      .badge-awaiting {
        color: var(--ink-amber);
        border-color: var(--ink-amber);
      }

      /* ─── History ───────────────────────────────────────── */
      .history-list {
        list-style: none;
        padding: 0;
        margin: 0;
        border-top: 1px solid var(--rule);
      }
      .history-row {
        border-bottom: 1px solid var(--rule);
      }
      .history-link {
        display: flex;
        width: 100%;
        gap: 12px;
        align-items: baseline;
        padding: 8px 4px;
        background: transparent;
        border: 0;
        cursor: pointer;
        font: inherit;
        text-align: left;
      }
      .history-link:hover { background: var(--paper-soft); }
      .history-title {
        flex: 1;
        font-size: 14px;
        color: var(--ink);
      }
    `,
  ],
})
export class ReviewPage implements OnDestroy {
  private integrationsApi = inject(IntegrationsService);
  private tasksApi = inject(TasksService);
  private router = inject(Router);

  protected readonly states = REVIEW_PIPELINE_STATES;
  protected readonly stateLabels = STATE_LABELS;
  protected readonly stateRole = STATE_ROLE;
  protected readonly relativeTs = relativeTs;
  protected readonly relativeTsIso = relativeTsIso;
  protected readonly formatTs = formatTs;

  protected readonly githubStatus = signal<'unknown' | 'disconnected' | 'no-watched' | 'connected'>(
    'unknown',
  );
  protected readonly login = signal<string | null>(null);

  protected readonly prFilter = signal<PrFilter>('awaiting_me');
  protected prSearch = '';
  protected readonly prs = signal<GithubPr[]>([]);
  protected readonly prsLoading = signal(false);
  protected readonly prError = signal<string | null>(null);
  protected readonly busyOn = signal<string | null>(null);

  protected readonly filteredPrs = computed(() => {
    const q = this.prSearch.trim().toLowerCase();
    if (!q) return this.prs();
    return this.prs().filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.repo.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q),
    );
  });

  // Tasks come from the same /api/tasks endpoint as Home; we filter to
  // workspace='review' server-side and split open/closed for the two
  // sections (Pipeline + History).
  protected readonly tasks = signal<ReviewCard[]>([]);
  protected readonly openTasks = computed(() => this.tasks().filter((t) => t.status === 'open'));
  protected readonly closedTasks = computed(() => {
    return [...this.tasks().filter((t) => t.status === 'closed')].sort(
      (a, b) => b.raw.updated_at - a.raw.updated_at,
    );
  });
  protected readonly openByState = computed(() => {
    const groups: Record<ReviewPipelineState, ReviewCard[]> = {
      intake: [],
      explore: [],
      'direction-gate': [],
      'deep-review': [],
      synthesis: [],
      ready: [],
    };
    for (const t of this.openTasks()) groups[t.state].push(t);
    return groups;
  });
  protected readonly openCount = computed(() => this.openTasks().length);
  protected readonly closedCount = computed(() => this.closedTasks().length);

  private destroy$ = new Subject<void>();

  constructor() {
    // Hydrate GH status. /api/integrations carries login + watched_repos
    // so the page can render its three states without an extra request.
    this.integrationsApi.list().subscribe({
      next: (r) => {
        const gh = r.integrations.find((i) => i.id === 'github');
        if (!gh || !gh.login) {
          this.githubStatus.set('disconnected');
        } else {
          this.login.set(gh.login);
          if ((gh.watched_repos ?? []).length === 0) {
            this.githubStatus.set('no-watched');
          } else {
            this.githubStatus.set('connected');
            this.refreshPrs();
          }
        }
      },
      error: () => this.githubStatus.set('disconnected'),
    });

    timer(60_000, 60_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.githubStatus() === 'connected') this.refreshPrs();
      });

    timer(0, 5000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          this.tasksApi.list({ workspace: 'review' }).pipe(catchError(() => of({ tasks: [] }))),
        ),
      )
      .subscribe((r) => {
        this.tasks.set(r.tasks.map(toCard));
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  setFilter(f: PrFilter): void {
    if (this.prFilter() === f) return;
    this.prFilter.set(f);
    this.refreshPrs();
  }

  refreshPrs(): void {
    this.prsLoading.set(true);
    this.prError.set(null);
    this.integrationsApi.listGithubPrs(this.prFilter()).subscribe({
      next: (r) => {
        this.prs.set(r.prs);
        this.prsLoading.set(false);
      },
      error: (e) => {
        this.prsLoading.set(false);
        this.prError.set(e?.error?.message ?? e?.message ?? String(e));
      },
    });
  }

  reviewPr(pr: GithubPr): void {
    if (!pr.awaiting_me) return;
    const key = `${pr.repo}#${pr.number}`;
    this.busyOn.set(key);
    this.integrationsApi.reviewPr(pr.repo, pr.number).subscribe({
      next: (r) => {
        this.busyOn.set(null);
        this.router.navigate(['/home'], { queryParams: { task: r.task_id, tab: 'stream' } });
      },
      error: (e) => {
        this.busyOn.set(null);
        this.prError.set(e?.error?.message ?? e?.message ?? String(e));
      },
    });
  }

  openOnHome(taskId: string): void {
    this.router.navigate(['/home'], { queryParams: { task: taskId } });
  }

  truncateBody(s: string): string {
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  }
}
