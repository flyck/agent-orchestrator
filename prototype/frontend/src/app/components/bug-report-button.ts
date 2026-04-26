import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

const MAX_HTML_BYTES = 1_400_000; // stay under backend's 1.5MB cap

@Component({
  selector: 'app-bug-report-button',
  standalone: true,
  imports: [FormsModule],
  template: `
    <button class="trigger" type="button" (click)="open.set(true)" title="Report a bug">
      report bug
    </button>

    @if (open()) {
      <div class="overlay" (click)="open.set(false)"></div>
      <div class="dialog" role="dialog" aria-label="Report a bug">
        <header>
          <p class="meta">internal · debugger agent will pick this up when enabled</p>
          <h2>Report a bug</h2>
        </header>

        <p class="muted">
          A snapshot of the current page is attached automatically. Add a comment if you want to
          describe the problem; otherwise just submit.
        </p>

        <textarea
          rows="4"
          placeholder="Optional comment — what went wrong, what you expected"
          [(ngModel)]="comment"
        ></textarea>

        @if (status()) {
          <p class="status">{{ status() }}</p>
        }

        <footer>
          <button type="button" (click)="open.set(false)" [disabled]="busy()">Cancel</button>
          <button type="button" class="primary" (click)="submit()" [disabled]="busy()">
            {{ busy() ? 'Sending…' : 'Submit' }}
          </button>
        </footer>
      </div>
    }
  `,
  styles: [
    `
      :host { display: inline-block; }
      .trigger {
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 4px 10px;
        background: var(--paper);
      }
      .overlay {
        position: fixed; inset: 0;
        background: rgba(26, 26, 24, 0.18);
        z-index: 50;
      }
      .dialog {
        position: fixed;
        z-index: 51;
        top: 12vh;
        left: 50%;
        transform: translateX(-50%);
        width: min(560px, 92vw);
        background: var(--paper);
        border: 1px solid var(--rule-strong);
        padding: 24px;
        h2 { margin: 4px 0 0; }
      }
      .muted { color: var(--ink-muted); margin: 12px 0; }
      textarea { width: 100%; resize: vertical; }
      .status { margin-top: 8px; font-size: 13px; color: var(--ink-muted); }
      .status.error { color: var(--ink-red); }
      footer {
        display: flex; gap: 8px; justify-content: flex-end;
        margin-top: 16px;
      }
    `,
  ],
})
export class BugReportButton {
  private http = inject(HttpClient);
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly status = signal<string | null>(null);
  protected comment = '';

  submit() {
    let snapshot = document.documentElement.outerHTML;
    if (snapshot.length > MAX_HTML_BYTES) {
      snapshot = snapshot.slice(0, MAX_HTML_BYTES);
    }
    this.busy.set(true);
    this.status.set(null);
    this.http
      .post<{ id: string }>('/api/bug-reports', {
        page_url: window.location.href,
        user_agent: navigator.userAgent.slice(0, 1000),
        comment: this.comment || null,
        html_snapshot: snapshot,
      })
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          this.status.set(`Sent. ${r.id}`);
          this.comment = '';
          setTimeout(() => {
            this.open.set(false);
            this.status.set(null);
          }, 1200);
        },
        error: (e) => {
          this.busy.set(false);
          this.status.set(`Failed: ${e.message ?? e}`);
        },
      });
  }
}
