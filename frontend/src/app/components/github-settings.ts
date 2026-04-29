import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IntegrationsService,
  type GithubRepo,
} from '../services/integrations.service';

/**
 * GitHub integration card for Settings → Integrations. Two states:
 *
 *   1. **Disconnected.** A single token field + Connect button. The
 *      token gets validated server-side on submit; failure surfaces
 *      the raw github error so the user knows whether it's a scope
 *      issue or a typo.
 *   2. **Connected.** Shows the validated login, lists user repos in
 *      a multi-select (filterable), saves the watched-repos diff back
 *      to the server. Disconnect button wipes the token.
 *
 * Repos load lazily on connect. We don't pre-fetch on every Settings
 * render because the list can be big and Settings opens often.
 */
@Component({
  selector: 'app-github-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <article class="gh">
      <header class="gh-head">
        <h3>GitHub</h3>
        <p class="meta">{{ status() }}</p>
      </header>

      @if (!connected()) {
        <p class="muted small">
          Paste a personal access token. The orchestrator only reads — it never opens, comments
          on, or merges pull requests.
        </p>
        <details class="gh-perms">
          <summary>required token permissions</summary>
          <p class="muted small">Two tiers, depending on what you want the orchestrator to do.</p>
          <h4>Read-only (list PRs, fetch diffs)</h4>
          <ul>
            <li>
              <strong>Classic tokens:</strong> <code>repo</code> scope (covers private repos);
              public-only is fine with <code>public_repo</code>.
            </li>
            <li>
              <strong>Fine-grained tokens:</strong> per-repo access on the repos you want to
              watch, with <em>Repository permissions → Pull requests: Read-only</em> and
              <em>Metadata: Read-only</em>. Issues read-only is recommended (the search API
              that backs "review-requested for me" goes through the issues index).
            </li>
          </ul>
          <h4>Write (post review back as a PR comment)</h4>
          <ul>
            <li>
              <strong>Classic tokens:</strong> <code>repo</code> already covers it.
            </li>
            <li>
              <strong>Fine-grained tokens:</strong> upgrade <em>Pull requests</em> to
              <em>Read and write</em>. Issues to write only if you want to comment on
              the underlying issue too.
            </li>
            <li>
              The orchestrator only ever posts <em>COMMENT</em> reviews — never approves
              or requests changes on your behalf. The button on the Ready stage is the
              only place this fires.
            </li>
          </ul>
          <p class="muted small">
            Email / profile scopes are NOT needed — we identify you by GitHub login from
            <code>/user</code>.
          </p>
        </details>
        <div class="gh-row">
          <input class="gh-token"
                 type="password"
                 placeholder="ghp_… or github_pat_…"
                 [(ngModel)]="tokenDraft" />
          <button class="primary"
                  type="button"
                  [disabled]="!tokenDraft || saving()"
                  (click)="connect()">
            {{ saving() ? 'connecting…' : 'connect' }}
          </button>
        </div>
        @if (errorMessage()) {
          <p class="error small">{{ errorMessage() }}</p>
        }
      } @else {
        <p class="small">
          Connected as <strong>&#64;{{ login() }}</strong>.
          @if (lastError()) {
            <span class="error"> Last sync error: {{ lastError() }}</span>
          }
        </p>

        <div class="gh-watch">
          <header class="gh-watch-head">
            <span class="meta">watched repos · {{ selected().size }} of {{ filteredRepos().length }}</span>
            <button type="button" class="meta-action" (click)="reloadRepos()" [disabled]="reposLoading()">
              {{ reposLoading() ? 'loading…' : 'refresh list' }}
            </button>
          </header>
          <input class="gh-filter"
                 type="text"
                 placeholder="filter…"
                 [(ngModel)]="filter" />
          @if (reposLoading() && repos().length === 0) {
            <p class="muted small">loading repos…</p>
          } @else if (repos().length === 0) {
            <p class="muted small">no repos visible to this token</p>
          } @else {
            <ul class="gh-repos">
              @for (r of filteredRepos(); track r.full_name) {
                <li>
                  <label>
                    <input type="checkbox"
                           [checked]="selected().has(r.full_name)"
                           (change)="toggle(r.full_name, $event)" />
                    <span class="repo-name mono">{{ r.full_name }}</span>
                    @if (r.private) { <span class="meta">private</span> }
                  </label>
                </li>
              }
            </ul>
          }
        </div>

        <div class="gh-actions">
          <button class="primary" type="button" (click)="saveWatched()" [disabled]="saving() || !dirty()">
            {{ saving() ? 'saving…' : 'save selection' }}
          </button>
          <button type="button" (click)="rotate()">rotate token</button>
          <button type="button" class="danger" (click)="disconnect()">disconnect</button>
        </div>
        @if (errorMessage()) {
          <p class="error small">{{ errorMessage() }}</p>
        }
        @if (saveOk()) {
          <p class="small ok">saved.</p>
        }
      }
    </article>
  `,
  styles: [
    `
      :host { display: block; }
      .gh {
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 16px 18px;
      }
      .gh-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
        h3 {
          margin: 0;
          font-family: var(--font-serif);
          font-size: 16px;
        }
        .meta { margin: 0; }
      }
      .small { font-size: 13px; }
      .muted { color: var(--ink-muted); }
      .error { color: var(--ink-red); }
      .ok { color: var(--ink); }
      code {
        background: var(--paper-soft);
        border: 1px solid var(--rule);
        padding: 0 4px;
        font-family: var(--font-mono);
        font-size: 11px;
      }

      .gh-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        margin: 8px 0;
      }
      .gh-token {
        font-family: var(--font-mono);
        font-size: 12.5px;
      }

      .gh-watch {
        margin-top: 12px;
        border-top: 1px dashed var(--rule);
        padding-top: 10px;
      }
      .gh-watch-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 6px;
        .meta { margin: 0; }
        .meta-action {
          font-size: 11px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          background: transparent;
          border: 1px solid var(--rule-strong);
          padding: 3px 8px;
        }
      }
      .gh-filter {
        width: 100%;
        margin: 4px 0 8px;
        font-size: 12.5px;
      }
      .gh-repos {
        list-style: none;
        padding: 0;
        margin: 0;
        max-height: 280px;
        overflow: auto;
        border: 1px solid var(--rule);
        background: var(--paper-soft);
      }
      .gh-repos li {
        padding: 4px 10px;
        border-bottom: 1px solid var(--rule);
      }
      .gh-repos li:last-child { border-bottom: 0; }
      .gh-repos label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .gh-repos input { width: auto; }
      .repo-name { font-size: 12.5px; flex: 1; }

      .gh-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .gh-actions .danger {
        color: var(--ink-red);
        border-color: var(--ink-red);
      }
      .gh-actions .danger:hover { background: var(--ink-red-bg); }

      .gh-perms {
        margin: 8px 0;
        font-size: 13px;
      }
      .gh-perms summary {
        cursor: pointer;
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--ink-muted);
        padding: 4px 0;
      }
      .gh-perms ul {
        margin: 6px 0 0;
        padding-left: 18px;
      }
      .gh-perms li { margin: 4px 0; line-height: 1.5; }
      .gh-perms h4 {
        margin: 10px 0 4px;
        font-family: var(--font-serif);
        font-size: 13.5px;
        letter-spacing: -0.005em;
      }
      .gh-perms code {
        background: var(--paper-soft);
        padding: 0 4px;
        border: 1px solid var(--rule);
      }
    `,
  ],
})
export class GithubSettings implements OnInit {
  private api = inject(IntegrationsService);

  protected tokenDraft = '';
  protected filter = '';

  protected readonly login = signal<string | null>(null);
  protected readonly connected = computed(() => !!this.login());
  protected readonly lastError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveOk = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly reposLoading = signal(false);

  protected readonly repos = signal<GithubRepo[]>([]);
  protected readonly selected = signal<Set<string>>(new Set());
  /** Snapshot of the saved selection — used to compute dirty state. */
  private savedSnapshot = new Set<string>();

  protected readonly filteredRepos = computed(() => {
    const q = this.filter.trim().toLowerCase();
    const list = this.repos();
    if (!q) return list;
    return list.filter((r) => r.full_name.toLowerCase().includes(q));
  });

  protected readonly dirty = computed(() => {
    const sel = this.selected();
    if (sel.size !== this.savedSnapshot.size) return true;
    for (const f of sel) if (!this.savedSnapshot.has(f)) return true;
    return false;
  });

  protected status(): string {
    return this.connected() ? 'configured' : 'not connected';
  }

  ngOnInit(): void {
    // Hydrate from /api/integrations: reads stored login + watched_repos
    // without needing the token to round-trip.
    this.api.list().subscribe({
      next: (r) => {
        const gh = r.integrations.find((i) => i.id === 'github');
        if (!gh) return;
        if (gh.login) this.login.set(gh.login);
        const watched = gh.watched_repos ?? [];
        this.selected.set(new Set(watched));
        this.savedSnapshot = new Set(watched);
        this.lastError.set(gh.last_error);
        if (gh.login) this.reloadRepos();
      },
    });
  }

  connect(): void {
    if (!this.tokenDraft.trim()) return;
    this.errorMessage.set(null);
    this.saving.set(true);
    this.api.connectGithub({ token: this.tokenDraft.trim() }).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.login.set(r.login);
        this.tokenDraft = '';
        this.selected.set(new Set(r.watched_repos));
        this.savedSnapshot = new Set(r.watched_repos);
        this.reloadRepos();
      },
      error: (e) => {
        this.saving.set(false);
        this.errorMessage.set(this.formatError(e));
      },
    });
  }

  rotate(): void {
    // Switch back to the disconnected view to capture a new token,
    // without losing the watched-repos selection (server keeps it).
    this.login.set(null);
    this.tokenDraft = '';
    this.errorMessage.set(null);
  }

  disconnect(): void {
    if (!confirm('Disconnect GitHub? The token + watched repos will be wiped.')) return;
    this.api.disconnectGithub().subscribe({
      next: () => {
        this.login.set(null);
        this.repos.set([]);
        this.selected.set(new Set());
        this.savedSnapshot = new Set();
      },
    });
  }

  reloadRepos(): void {
    this.reposLoading.set(true);
    this.api.listGithubRepos().subscribe({
      next: (r) => {
        this.repos.set(r.repos);
        this.reposLoading.set(false);
      },
      error: (e) => {
        this.reposLoading.set(false);
        this.errorMessage.set(this.formatError(e));
      },
    });
  }

  toggle(fullName: string, ev: Event): void {
    const checked = (ev.target as HTMLInputElement).checked;
    const next = new Set(this.selected());
    if (checked) next.add(fullName);
    else next.delete(fullName);
    this.selected.set(next);
    this.saveOk.set(false);
  }

  saveWatched(): void {
    this.errorMessage.set(null);
    this.saveOk.set(false);
    this.saving.set(true);
    this.api
      .connectGithub({ watched_repos: [...this.selected()] })
      .subscribe({
        next: (r) => {
          this.saving.set(false);
          this.savedSnapshot = new Set(r.watched_repos);
          this.saveOk.set(true);
        },
        error: (e) => {
          this.saving.set(false);
          this.errorMessage.set(this.formatError(e));
        },
      });
  }

  private formatError(e: { error?: { message?: string }; message?: string } | string): string {
    if (typeof e === 'string') return e;
    return e?.error?.message ?? e?.message ?? 'unknown error';
  }
}
