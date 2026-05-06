import { Component, computed, inject, OnInit, signal } from '@angular/core';
import {
  IntegrationsService,
  type IntegrationStatus,
} from '../services/integrations.service';
import { GithubSettings } from './github-settings';
import { BitbucketSettings } from './bitbucket-settings';

type ProviderId = 'github' | 'bitbucket' | 'gitlab';

interface Provider {
  id: ProviderId;
  label: string;
  blurb: string;
  /** False until we wire the provider end-to-end. Disables the tab content
   *  but keeps the tab visible so the user knows it's planned. */
  ready: boolean;
}

const PROVIDERS: Provider[] = [
  { id: 'github',    label: 'GitHub',    blurb: 'Read PRs awaiting your review across watched repos.', ready: true },
  { id: 'bitbucket', label: 'Bitbucket', blurb: 'Connect with an app password or Atlassian API token.', ready: true },
  { id: 'gitlab',    label: 'GitLab',    blurb: 'Coming soon — connect a personal access token.',       ready: false },
];

/**
 * Provider switcher for Settings → Integrations. The product rule is
 * "at most one integration is active at a time" — once a provider is
 * connected, the others are disabled server-side and surfaced here as
 * dimmed tabs with a "disconnect <X> first" hint to make the constraint
 * obvious. The selected tab defaults to the active provider, falling back
 * to GitHub when nothing is configured.
 */
@Component({
  selector: 'app-integrations-panel',
  standalone: true,
  imports: [GithubSettings, BitbucketSettings],
  template: `
    <div class="integrations-panel">
      <nav class="provider-tabs" aria-label="Integration providers">
        @for (p of providers; track p.id) {
          <button type="button"
                  class="provider-tab"
                  [class.active]="selected() === p.id"
                  [class.disabled]="!p.ready"
                  [attr.aria-pressed]="selected() === p.id"
                  [title]="!p.ready ? p.blurb : (lockedTooltip(p.id) ?? p.blurb)"
                  (click)="select(p.id)">
            <span class="provider-name">{{ p.label }}</span>
            @if (statusFor(p.id); as s) {
              @if (s.enabled) {
                <span class="provider-badge active">active</span>
              } @else if (s.configured) {
                <span class="provider-badge inactive">stored</span>
              }
            }
            @if (!p.ready) { <span class="provider-badge soon">soon</span> }
          </button>
        }
      </nav>

      @if (lockedTooltip(selected()); as lock) {
        <p class="locked-hint meta">{{ lock }}</p>
      }

      @switch (selected()) {
        @case ('github')    { <app-github-settings /> }
        @case ('bitbucket') { <app-bitbucket-settings /> }
        @case ('gitlab') {
          <article class="placeholder">
            <p class="muted">
              GitLab support is on the roadmap. Once it lands, this tab will hold the same shape
              as the others — token field, scope docs, and a connection status header.
            </p>
          </article>
        }
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .integrations-panel { display: flex; flex-direction: column; gap: 12px; }
      .provider-tabs {
        display: flex;
        gap: 0;
        border-bottom: 1px solid var(--rule);
      }
      .provider-tab {
        background: transparent;
        border: 0;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        padding: 8px 14px;
        font-size: 13px;
        color: var(--ink-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 0;
      }
      .provider-tab:hover { color: var(--ink); }
      .provider-tab.active {
        color: var(--ink);
        border-bottom-color: var(--ink);
      }
      .provider-tab.disabled {
        opacity: 0.55;
      }
      .provider-name { font-family: var(--font-serif); font-size: 14px; }
      .provider-badge {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        font-family: var(--font-mono);
        padding: 1px 6px;
        border: 1px solid var(--rule-strong);
        border-radius: 8px;
        line-height: 14px;
      }
      .provider-badge.active {
        color: var(--state-ready-edge, var(--ink));
        border-color: var(--state-ready-edge, var(--ink));
      }
      .provider-badge.inactive { color: var(--ink-muted); }
      .provider-badge.soon { color: var(--ink-muted); border-style: dashed; }
      .locked-hint {
        margin: 0;
        font-size: 12px;
        color: var(--ink-amber, var(--ink-muted));
      }
      .placeholder {
        border: 1px dashed var(--rule);
        background: var(--paper-soft);
        padding: 16px 18px;
      }
      .muted { color: var(--ink-muted); }
    `,
  ],
})
export class IntegrationsPanel implements OnInit {
  private api = inject(IntegrationsService);

  protected readonly providers = PROVIDERS;
  protected readonly selected = signal<ProviderId>('github');
  protected readonly statuses = signal<IntegrationStatus[]>([]);

  protected readonly activeId = computed<ProviderId | null>(() => {
    const active = this.statuses().find((s) => s.enabled);
    return (active?.id as ProviderId | undefined) ?? null;
  });

  ngOnInit(): void {
    this.refresh();
  }

  protected select(id: ProviderId): void {
    const p = this.providers.find((x) => x.id === id);
    if (!p?.ready) return;
    this.selected.set(id);
    // Refresh statuses on tab switch so the locked-hint updates after the
    // user disconnects from another tab and comes back.
    this.refresh();
  }

  protected statusFor(id: ProviderId): IntegrationStatus | undefined {
    return this.statuses().find((s) => s.id === id);
  }

  /**
   * Returns a hint when the selected tab is *not* the currently-active
   * provider — i.e. the single-active rule means connecting here will
   * force a disconnect on the other side. Null when there's no conflict.
   */
  protected lockedTooltip(id: ProviderId): string | null {
    const active = this.activeId();
    if (!active || active === id) return null;
    const activeLabel = this.providers.find((p) => p.id === active)?.label ?? active;
    return `Only one integration can be active. Connecting here will replace ${activeLabel}.`;
  }

  private refresh(): void {
    this.api.list().subscribe({
      next: (r) => {
        this.statuses.set(r.integrations);
        // First hydration: jump to the active provider's tab so the user
        // sees its config straight away.
        const active = r.integrations.find((s) => s.enabled);
        if (active && this.providers.some((p) => p.id === active.id && p.ready)) {
          this.selected.set(active.id as ProviderId);
        }
      },
      error: () => {},
    });
  }
}
