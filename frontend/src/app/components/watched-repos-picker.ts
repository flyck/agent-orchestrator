import { Component, computed, inject, OnInit, signal, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IntegrationsService,
  type NormalizedRepo,
} from '../services/integrations.service';

/**
 * Provider-agnostic watched-repos picker. Lists every repo the active
 * provider can see (via /api/integrations/repos) and lets the user check
 * which ones to watch. "Watch all" toggles the entire visible list at
 * once. Saves through PATCH /api/integrations/watched.
 *
 * Reused from both GithubSettings and BitbucketSettings so the two cards
 * have identical selection UX.
 */
@Component({
  selector: 'app-watched-repos-picker',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="picker">
      <header class="picker-head">
        <span class="meta">watched repos · {{ selected().size }} of {{ filteredRepos().length }}</span>
        <button type="button" class="meta-action" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'loading…' : 'refresh list' }}
        </button>
      </header>

      <div class="picker-bulk">
        <label class="bulk-toggle">
          <input type="checkbox"
                 [checked]="allSelected()"
                 [indeterminate]="someSelected() && !allSelected()"
                 (change)="toggleAll($event)" />
          <span>watch all ({{ filteredRepos().length }})</span>
        </label>
        <input class="picker-filter"
               type="text"
               placeholder="filter…"
               [(ngModel)]="filter" />
      </div>

      @if (loading() && repos().length === 0) {
        <p class="muted small">loading repos…</p>
      } @else if (repos().length === 0) {
        <p class="muted small">no repos visible to this credential</p>
      } @else {
        <ul class="picker-list">
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

      <div class="picker-actions">
        <button class="primary"
                type="button"
                (click)="save()"
                [disabled]="saving() || !dirty()">
          {{ saving() ? 'saving…' : 'save selection' }}
        </button>
        @if (saveOk()) { <span class="small ok">saved.</span> }
        @if (errorMessage()) { <span class="error small">{{ errorMessage() }}</span> }
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .picker {
        margin-top: 12px;
        border-top: 1px dashed var(--rule);
        padding-top: 10px;
      }
      .picker-head {
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
      .picker-bulk {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 12px;
        align-items: center;
        margin: 4px 0 8px;
      }
      .bulk-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        cursor: pointer;
      }
      .bulk-toggle input { width: auto; }
      .picker-filter { width: 100%; font-size: 12.5px; }
      .picker-list {
        list-style: none;
        padding: 0;
        margin: 0;
        max-height: 280px;
        overflow: auto;
        border: 1px solid var(--rule);
        background: var(--paper-soft);
      }
      .picker-list li {
        padding: 4px 10px;
        border-bottom: 1px solid var(--rule);
      }
      .picker-list li:last-child { border-bottom: 0; }
      .picker-list label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .picker-list input { width: auto; }
      .repo-name { font-size: 12.5px; flex: 1; }
      .picker-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 12px;
      }
      .small { font-size: 13px; }
      .muted { color: var(--ink-muted); }
      .ok { color: var(--ink); }
      .error { color: var(--ink-red); }
    `,
  ],
})
export class WatchedReposPicker implements OnInit {
  private api = inject(IntegrationsService);

  /** Initial selection — what the server says is currently watched. The
   *  picker hydrates this into its internal Set on first load. */
  readonly initialSelection = input<string[]>([]);

  protected filter = '';

  protected readonly repos = signal<NormalizedRepo[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveOk = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly selected = signal<Set<string>>(new Set());
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

  /** Every visible repo is in the selection. Uses filteredRepos so the
   *  "watch all" toggle reflects the filtered subset, not the full list. */
  protected readonly allSelected = computed(() => {
    const visible = this.filteredRepos();
    if (visible.length === 0) return false;
    const sel = this.selected();
    return visible.every((r) => sel.has(r.full_name));
  });

  protected readonly someSelected = computed(() => {
    const sel = this.selected();
    return this.filteredRepos().some((r) => sel.has(r.full_name));
  });

  ngOnInit(): void {
    const initial = new Set(this.initialSelection());
    this.selected.set(initial);
    this.savedSnapshot = new Set(initial);
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.api.listRepos().subscribe({
      next: (r) => {
        this.repos.set(r.repos);
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
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

  /** "Watch all" — checks every visible repo (i.e. filtered subset).
   *  Unchecking the master toggle clears just the visible ones, leaving
   *  hidden selections alone so users can curate per filter. */
  toggleAll(ev: Event): void {
    const checked = (ev.target as HTMLInputElement).checked;
    const visible = this.filteredRepos();
    const next = new Set(this.selected());
    for (const r of visible) {
      if (checked) next.add(r.full_name);
      else next.delete(r.full_name);
    }
    this.selected.set(next);
    this.saveOk.set(false);
  }

  save(): void {
    this.errorMessage.set(null);
    this.saveOk.set(false);
    this.saving.set(true);
    this.api.setWatchedRepos([...this.selected()]).subscribe({
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
