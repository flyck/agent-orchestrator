import { Component, Input } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-task-detail-page',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="head">
      <a class="back" routerLink="/home">← back to pipeline</a>
      <h1>Task {{ id }}</h1>
    </div>

    <p class="muted">
      This is where the live agent stream(s) for the task render — one pane per agent currently
      working on it, with text deltas, tool-call blocks, and a comment input strip at the bottom of
      each pane so you can interject directly into the agent's session. The same pane goes amber
      when the agent is waiting on you.
    </p>

    <p class="muted small">
      The streaming view depends on the WebSocket hub (Phase 7) and the orchestrator (Phase 6).
      Both are in progress. The IA is in place so this route is reachable from every pipeline card.
    </p>
  `,
  styles: [
    `
      :host { display: block; max-width: 880px; }
      .head { display: flex; align-items: baseline; gap: 16px; margin-bottom: 16px; }
      .back { font-size: 13px; color: var(--ink-muted); text-decoration: none; }
      .back:hover { color: var(--ink); }
      h1 { margin: 0; }
      .muted { color: var(--ink-muted); margin: 8px 0; }
      .small { font-size: 13px; }
    `,
  ],
})
export class TaskDetailPage {
  @Input() id = '';
}
