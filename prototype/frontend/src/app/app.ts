import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { catchError, of, timer, switchMap } from 'rxjs';

interface HealthResponse {
  ok: boolean;
  name: string;
  started_at: number;
  uptime_ms: number;
}

const TABS: { path: string; label: string }[] = [
  { path: 'review',     label: 'Review' },
  { path: 'feature',    label: 'Feature' },
  { path: 'bugfix',     label: 'Bugfix' },
  { path: 'arch',       label: 'Arch' },
  { path: 'background', label: 'Background' },
  { path: 'settings',   label: 'Settings' },
  { path: 'cost',       label: 'Cost' },
];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private http = inject(HttpClient);
  protected readonly tabs = TABS;

  // Poll backend health every 5s. If the backend is down, .ok stays false.
  protected readonly health = signal<HealthResponse | null>(null);

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
  }
}
