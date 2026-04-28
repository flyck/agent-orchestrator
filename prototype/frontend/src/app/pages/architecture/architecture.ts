import { Component } from '@angular/core';

@Component({
  selector: 'app-architecture-page',
  standalone: true,
  template: `
    <article class="arch">
      <header class="head">
        <p class="meta">workspace</p>
        <h1>Architecture Compare</h1>
        <p class="lead">
          Map a codebase's current architecture, then have a counter-architecture agent propose an
          alternative shape. Read both side-by-side and decide whether the boundaries you have are
          the boundaries you want.
        </p>
      </header>

      <hr />

      <section class="section">
        <p class="meta">v1 status</p>
        <p>
          Scaffolded only. The agents below share the same orchestrator, job queue, and websocket hub
          as the Review and Build pipelines — when this tab is wired, the agent panes behave like
          any other task on the Home pipeline.
        </p>
      </section>

      <section class="section">
        <p class="meta">planned agent composition</p>
        <ol class="agent-list">
          <li>
            <h3>Architecture analyst</h3>
            <p class="muted">
              Walks the repository (skill-aware), produces a markdown map of modules, boundaries,
              dependencies, and notable patterns. Output is plain markdown — no diagram rendering
              in v1; v2 may layer a renderer on top of the same prose.
            </p>
          </li>
          <li>
            <h3>Counter-architecture agent</h3>
            <p class="muted">
              Reads the analyst's map and proposes one alternative shape with the trade-offs called
              out. Strict no-implementation rule: this agent describes, it does not refactor.
            </p>
          </li>
          <li>
            <h3>Synthesizer</h3>
            <p class="muted">
              Reconciles both views into a short, ranked list of decisions worth making and the
              cost of each. Same role pattern as the Review synthesizer.
            </p>
          </li>
        </ol>
      </section>

      <section class="section">
        <p class="meta">non-goals (deferred)</p>
        <ul class="muted">
          <li>Architecture diagram rendering — v2.</li>
          <li>Counter-architecture side-by-side compare UI — v2.</li>
          <li>Auto-refactor toward the counter-architecture — out of scope, ever.</li>
        </ul>
      </section>

      <section class="section">
        <p class="meta">design reference</p>
        <p>
          See
          <a href="../../docs/06-v1-scope-and-non-goals.md" target="_blank" rel="noopener">
            docs/06-v1-scope-and-non-goals.md
          </a>
          and
          <a href="../../docs/04-architecture.md" target="_blank" rel="noopener">
            docs/04-architecture.md
          </a>.
        </p>
      </section>
    </article>
  `,
  styles: [
    `
      :host { display: block; }
      .arch { max-width: 880px; }
      .head { margin-bottom: 16px; }
      .lead {
        font-family: var(--font-serif);
        font-size: 18px;
        line-height: 1.45;
        color: var(--ink);
        margin: 8px 0 0;
        max-width: 720px;
      }
      .section { margin: 20px 0; }
      .section .meta { margin: 0 0 6px; }
      .section p { margin: 4px 0; }
      .agent-list {
        list-style: none;
        padding: 0;
        margin: 8px 0 0;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .agent-list li {
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 12px 16px;
      }
      .agent-list h3 {
        margin: 0 0 4px;
        font-family: var(--font-serif);
        font-size: 16px;
      }
      .agent-list p { margin: 0; font-size: 14px; line-height: 1.5; }
      ul.muted { padding-left: 18px; margin: 4px 0; }
      ul.muted li { margin: 2px 0; }
      .muted { color: var(--ink-muted); }
      a { word-break: break-all; }
    `,
  ],
})
export class ArchitecturePage {}
