import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IntegrationsService,
} from '../services/integrations.service';
import { WatchedReposPicker } from './watched-repos-picker';

/**
 * Bitbucket integration card. Mirrors the GithubSettings shape (connect /
 * connected views) but with Bitbucket-specific copy + permission docs:
 *
 *   - Auth is HTTP Basic with `username:app_password`. We label the field
 *     "username (or Atlassian email)" so the same form covers both
 *     classic Bitbucket app passwords and the newer Atlassian API tokens.
 *   - The required-scopes block calls out the exact app-password scopes
 *     (Account: Read, Repositories: Read, Pull requests: Read) instead of
 *     GitHub's classic / fine-grained dichotomy.
 */
@Component({
  selector: 'app-bitbucket-settings',
  standalone: true,
  imports: [FormsModule, WatchedReposPicker],
  template: `
    <article class="bb">
      <header class="bb-head">
        <h3>Bitbucket</h3>
        <p class="meta">{{ status() }}</p>
      </header>

      @if (!connected()) {
        <p class="muted small">
          Bitbucket Cloud auth uses an <strong>app password</strong> (or an Atlassian API token —
          paste the email in the username field). The orchestrator only reads.
        </p>
        <details class="bb-perms" open>
          <summary>required permissions</summary>
          <h4>Option A — App password (classic)</h4>
          <p class="muted small">
            Create at
            <a href="https://bitbucket.org/account/settings/app-passwords/" target="_blank" rel="noopener">
              bitbucket.org/account/settings/app-passwords
            </a>. Username field: your <strong>Bitbucket username</strong> (the lowercase slug, not
            your email).
          </p>
          <ul>
            <li><strong>Account</strong> → <em>Read</em> — surfaces your display name in
              "connected as …".</li>
            <li><strong>Workspace membership</strong> → <em>Read</em> — needed to list the
              workspaces this credential can see.</li>
            <li><strong>Repositories</strong> → <em>Read</em> — lists repos you've opted in
              to watch.</li>
            <li><strong>Pull requests</strong> → <em>Read</em> — fetches PR metadata + diffs.</li>
          </ul>
          <h4>Option B — Atlassian API token with Bitbucket scopes</h4>
          <p class="muted small">
            Create at
            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">
              id.atlassian.com/manage-profile/security/api-tokens
            </a>
            and tick the <em>Bitbucket</em> scopes at creation. Username field: your
            <strong>Atlassian email</strong>.
          </p>
          <ul>
            <li><code>read:workspace:bitbucket</code> — required.</li>
            <li><code>read:repository:bitbucket</code> — list repos.</li>
            <li><code>read:pullrequest:bitbucket</code> — fetch PRs.</li>
            <li>Optional, for posting review comments later:
              <code>write:pullrequest:bitbucket</code>.</li>
          </ul>
          <p class="muted small">
            Plain Atlassian API tokens scoped for Jira/Confluence only — i.e. created without
            ticking any Bitbucket scope — will NOT authenticate against
            <code>api.bitbucket.org</code>.
          </p>
        </details>
        <div class="bb-row">
          <input class="bb-user"
                 type="text"
                 placeholder="username or atlassian email"
                 autocomplete="username"
                 [(ngModel)]="usernameDraft" />
          <input class="bb-secret"
                 type="password"
                 placeholder="app password / API token"
                 autocomplete="current-password"
                 [(ngModel)]="passwordDraft" />
          <button class="primary"
                  type="button"
                  [disabled]="!usernameDraft || !passwordDraft || saving()"
                  (click)="connect()">
            {{ saving() ? 'connecting…' : 'connect' }}
          </button>
        </div>
        @if (errorMessage()) {
          <p class="error small">{{ errorMessage() }}</p>
        }
      } @else {
        <p class="small">
          Connected as <strong>{{ displayName() ?? username() }}</strong>.
          @if (lastError()) {
            <span class="error"> Last sync error: {{ lastError() }}</span>
          }
        </p>

        <!-- Workspace slug. Editable so users can fix the auto-detected
             slug (or set it from scratch when /2.0/user/workspaces
             returned empty for an API-token identity). -->
        <section class="bb-workspace">
          <header class="bb-ws-head">
            <span class="meta">workspace slug</span>
            @if (workspace() && !editingWorkspace()) {
              <code class="bb-ws-current">{{ workspace() }}</code>
              <button type="button" class="meta-action" (click)="startEditWorkspace()">
                change
              </button>
            }
          </header>

          @if (!workspace() || editingWorkspace()) {
            <div class="bb-ws-row">
              <input class="bb-ws-input"
                     type="text"
                     placeholder="e.g. whereversim — the slug from bitbucket.org/<slug>/…"
                     [(ngModel)]="workspaceDraft"
                     (keydown.enter)="saveWorkspace()" />
              <button type="button"
                      class="primary"
                      [disabled]="workspaceSaving() || !workspaceDraft.trim()"
                      (click)="saveWorkspace()">
                {{ workspaceSaving() ? 'saving…' : 'save' }}
              </button>
              @if (workspace() && editingWorkspace()) {
                <button type="button"
                        (click)="cancelEditWorkspace()"
                        [disabled]="workspaceSaving()">
                  cancel
                </button>
              }
            </div>
            <p class="muted small">
              Type your workspace slug (the part of <code>bitbucket.org/&lt;slug&gt;/&lt;repo&gt;</code>).
              Saving here updates the API scope used for repo / PR listings.
            </p>
          }
        </section>

        @if (workspace()) {
          <app-watched-repos-picker [initialSelection]="watchedRepos()" />
        }

        <div class="bb-actions">
          <button type="button" (click)="rotate()">rotate credential</button>
          <button type="button" class="danger" (click)="disconnect()">disconnect</button>
        </div>
        @if (errorMessage()) {
          <p class="error small">{{ errorMessage() }}</p>
        }
      }
    </article>
  `,
  styles: [
    `
      :host { display: block; }
      .bb {
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 16px 18px;
      }
      .bb-head {
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
      .error { color: var(--ink-red); white-space: pre-wrap; }

      .bb-row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: 8px;
        margin: 8px 0;
      }
      .bb-user, .bb-secret {
        font-family: var(--font-mono);
        font-size: 12.5px;
      }

      .bb-workspace {
        margin: 12px 0;
        border-top: 1px dashed var(--rule);
        padding-top: 10px;
      }
      .bb-ws-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
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
      .bb-ws-current {
        font-family: var(--font-mono);
        font-size: 12.5px;
        background: var(--paper-soft);
        padding: 1px 6px;
        border: 1px solid var(--rule);
      }
      .bb-ws-row {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 8px;
        margin: 4px 0 6px;
      }
      .bb-ws-input {
        font-family: var(--font-mono);
        font-size: 12.5px;
      }

      .bb-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .bb-actions .danger {
        color: var(--ink-red);
        border-color: var(--ink-red);
      }
      .bb-actions .danger:hover { background: var(--ink-red-bg); }

      .bb-perms {
        margin: 8px 0;
        font-size: 13px;
      }
      .bb-perms summary {
        cursor: pointer;
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--ink-muted);
        padding: 4px 0;
      }
      .bb-perms ul {
        margin: 6px 0 0;
        padding-left: 18px;
      }
      .bb-perms li { margin: 4px 0; line-height: 1.5; }
      .bb-perms code {
        background: var(--paper-soft);
        padding: 0 4px;
        border: 1px solid var(--rule);
        font-family: var(--font-mono);
        font-size: 11px;
      }
    `,
  ],
})
export class BitbucketSettings implements OnInit {
  private api = inject(IntegrationsService);

  protected usernameDraft = '';
  protected passwordDraft = '';
  protected workspaceDraft = '';

  protected readonly username = signal<string | null>(null);
  protected readonly displayName = signal<string | null>(null);
  protected readonly workspace = signal<string | null>(null);
  protected readonly watchedRepos = signal<string[]>([]);
  protected readonly connected = computed(() => !!this.username());
  protected readonly lastError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly editingWorkspace = signal(false);
  protected readonly workspaceSaving = signal(false);

  protected status(): string {
    return this.connected() ? 'configured' : 'not connected';
  }

  ngOnInit(): void {
    this.api.list().subscribe({
      next: (r) => {
        const bb = r.integrations.find((i) => i.id === 'bitbucket');
        if (!bb) return;
        if (bb.username) this.username.set(bb.username);
        this.displayName.set(bb.display_name ?? null);
        this.workspace.set(bb.workspace ?? null);
        this.watchedRepos.set(bb.watched_repos ?? []);
        this.lastError.set(bb.last_error);
      },
    });
  }

  connect(): void {
    if (!this.usernameDraft.trim() || !this.passwordDraft) return;
    this.errorMessage.set(null);
    this.saving.set(true);
    this.api
      .connectBitbucket({
        username: this.usernameDraft.trim(),
        app_password: this.passwordDraft,
      })
      .subscribe({
        next: (r) => {
          this.saving.set(false);
          this.username.set(r.username);
          this.displayName.set(r.display_name);
          this.workspace.set(r.workspace);
          this.usernameDraft = '';
          this.passwordDraft = '';
        },
        error: (e) => {
          this.saving.set(false);
          this.errorMessage.set(this.formatError(e));
        },
      });
  }

  rotate(): void {
    this.username.set(null);
    this.displayName.set(null);
    this.workspace.set(null);
    this.usernameDraft = '';
    this.passwordDraft = '';
    this.errorMessage.set(null);
  }

  disconnect(): void {
    if (!confirm('Disconnect Bitbucket? The stored credential will be wiped.')) return;
    this.api.disconnectBitbucket().subscribe({
      next: () => {
        this.username.set(null);
        this.displayName.set(null);
        this.workspace.set(null);
      },
    });
  }

  startEditWorkspace(): void {
    this.workspaceDraft = this.workspace() ?? '';
    this.editingWorkspace.set(true);
    this.errorMessage.set(null);
  }

  cancelEditWorkspace(): void {
    this.editingWorkspace.set(false);
    this.workspaceDraft = '';
  }

  saveWorkspace(): void {
    const slug = this.workspaceDraft.trim();
    if (!slug || this.workspaceSaving()) return;
    this.workspaceSaving.set(true);
    this.errorMessage.set(null);
    this.api.setBitbucketWorkspace(slug).subscribe({
      next: (r) => {
        this.workspace.set(r.workspace);
        this.workspaceDraft = '';
        this.editingWorkspace.set(false);
        this.workspaceSaving.set(false);
      },
      error: (e) => {
        this.workspaceSaving.set(false);
        this.errorMessage.set(this.formatError(e));
      },
    });
  }

  private formatError(
    e:
      | { error?: { message?: string; hint?: string }; message?: string }
      | string,
  ): string {
    if (typeof e === 'string') return e;
    const msg = e?.error?.message ?? e?.message ?? 'unknown error';
    const hint = e?.error?.hint;
    return hint ? `${msg}\n\nHint: ${hint}` : msg;
  }
}
