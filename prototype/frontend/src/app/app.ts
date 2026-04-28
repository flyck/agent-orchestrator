import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { catchError, of, timer, switchMap } from 'rxjs';
import { BugReportButton } from './components/bug-report-button';

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
  protected readonly tabs = TABS;

  // Poll backend health every 5s. If the backend is down, .ok stays false.
  protected readonly health = signal<HealthResponse | null>(null);
  // Engine health: cold (not started yet), ok, or stalled. Polled on a
  // longer cadence — the engine probe hits opencode each time and we
  // don't need second-level granularity for "is the LLM runtime alive".
  protected readonly engineHealth = signal<EngineHealthResponse | null>(null);

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
  }
}
