import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IntegrationsService } from '../../services/integrations.service';

@Component({
  selector: 'app-review-page',
  standalone: true,
  imports: [RouterLink],
  template: `
    <header class="head">
      <p class="meta">workspace</p>
      <h1>Review</h1>
      <p class="lead">
        Paste a diff or local path. The planner maps the change, three reviewers (security,
        performance, architecture) work in parallel, and the synthesizer produces one ranked
        finding list.
      </p>
    </header>

    @if (showWarning()) {
      <aside class="warning">
        <p class="meta">no review-source integrations connected</p>
        <p>
          You can still review pasted diffs and local paths from this tab. To pull pull requests
          directly from GitHub, Bitbucket, or GitLab, connect a provider in
          <a routerLink="/settings">Settings → Integrations</a>.
        </p>
      </aside>
    }

    <p class="muted small">
      Frontend shell only. Backend orchestrator + WebSocket hub land in upcoming phases. The agent
      prompts already exist — see Settings → Agents.
    </p>
  `,
  styles: [
    `
      :host { display: block; max-width: 880px; }
      .head { margin-bottom: 16px; }
      .lead { font-family: var(--font-serif); font-size: 17px; color: var(--ink); }
      .warning {
        border: 1px solid var(--rule-strong);
        background: var(--paper-soft);
        padding: 12px 16px;
        margin: 16px 0;
        p { margin: 4px 0 0; }
      }
      .small { font-size: 13px; color: var(--ink-muted); }
    `,
  ],
})
export class ReviewPage {
  private integrationsApi = inject(IntegrationsService);

  protected readonly anyEnabled = signal<boolean | null>(null);
  protected readonly showWarning = computed(() => this.anyEnabled() === false);

  constructor() {
    this.integrationsApi.list().subscribe({
      next: (r) => this.anyEnabled.set(r.any_enabled),
      error: () => this.anyEnabled.set(null),
    });
  }
}
