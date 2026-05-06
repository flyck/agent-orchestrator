import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { catchError, of, timer, switchMap } from 'rxjs';
import { BugReportButton } from './components/bug-report-button';
import { TasksService, type ContextSwitchRow } from './services/tasks.service';
import { formatTs } from './util/time';

interface HealthResponse {
  ok: boolean;
  name: string;
  started_at: number;
  uptime_ms: number;
}

interface EngineHealthResponse {
  state: 'cold' | 'ok' | 'stalled';
  checked_at: number;
}

const TABS: { path: string; label: string }[] = [
  { path: 'home',         label: 'Home' },
  { path: 'review',       label: 'Review' },
  { path: 'architecture', label: 'Architecture' },
  { path: 'background',   label: 'Background' },
  { path: 'analysis',     label: 'Analysis' },
  { path: 'settings',     label: 'Settings' },
  { path: 'cost',         label: 'Cost' },
];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, BugReportButton],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private http = inject(HttpClient);
  private tasksApi = inject(TasksService);
  protected readonly tabs = TABS;

  // Poll backend health every 5s. If the backend is down, .ok stays false.
  protected readonly health = signal<HealthResponse | null>(null);
  // Engine health: cold (not started yet), ok, or stalled. Polled on a
  // longer cadence — the engine probe hits opencode each time and we
  // don't need second-level granularity for "is the LLM runtime alive".
  protected readonly engineHealth = signal<EngineHealthResponse | null>(null);

  // Latest context switch since last clear. Drives the navbar label.
  protected readonly currentContext = signal<ContextSwitchRow | null>(null);
  protected readonly ctxClearing = signal(false);

  constructor() {
    timer(0, 5000)
      .pipe(
        switchMap(() =>
          this.http
            .get<HealthResponse>('/api/health')
            .pipe(catchError(() => of(null))),
        ),
      )
      .subscribe((h) => this.health.set(h));

    timer(0, 15_000)
      .pipe(
        switchMap(() =>
          this.http
            .get<EngineHealthResponse>('/api/health/engine')
            .pipe(catchError(() => of(null))),
        ),
      )
      .subscribe((h) => this.engineHealth.set(h));

    // Refresh the current-context indicator every 10s so the label
    // appears soon after the LLM finishes labelling a switch.
    timer(0, 10_000)
      .pipe(
        switchMap(() =>
          this.tasksApi.getCurrentContextSwitch().pipe(catchError(() => of({ current: null }))),
        ),
      )
      .subscribe((r) => this.currentContext.set(r.current));
  }

  protected clearContext(): void {
    if (this.ctxClearing()) return;
    this.ctxClearing.set(true);
    this.tasksApi.clearCurrentContext().subscribe({
      next: () => {
        this.currentContext.set(null);
        this.ctxClearing.set(false);
      },
      error: () => this.ctxClearing.set(false),
    });
  }

  protected ctxLabelTooltip(cs: ContextSwitchRow | null): string {
    if (!cs) return 'No current context — mark a context switch on the Review page (↻ on a card) to track interruptions.';
    const when = formatTs(cs.created_at);
    const label = cs.label ?? 'pending — agent is labeling…';
    return `${label} · marked ${when}`;
  }
}
