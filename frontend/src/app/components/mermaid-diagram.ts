import {
  Component,
  ElementRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import mermaid from 'mermaid';

/** One-shot global init. Runs on the first <app-mermaid-diagram> mount;
 *  subsequent inits are no-ops because mermaid keeps internal state. */
let mermaidInited = false;
function ensureMermaidInit(dark: boolean): void {
  if (mermaidInited) {
    // Theme can change between calls (OS prefers-color-scheme flips);
    // re-init swaps the theme in place. Cheap.
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? 'dark' : 'neutral',
      securityLevel: 'strict',
      flowchart: { curve: 'linear', htmlLabels: false },
      themeVariables: dark
        ? { fontFamily: 'Inter, system-ui, sans-serif' }
        : { fontFamily: 'Inter, system-ui, sans-serif' },
    });
    return;
  }
  mermaidInited = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'neutral',
    securityLevel: 'strict',
    flowchart: { curve: 'linear', htmlLabels: false },
    themeVariables: { fontFamily: 'Inter, system-ui, sans-serif' },
  });
}

let renderCounter = 0;

/**
 * Render a Mermaid diagram from text. The component keeps the render
 * fully isolated from Angular's change detection — mermaid.render()
 * returns the SVG string, we drop it into innerHTML.
 *
 * Two failure modes the agents will hit:
 *   - syntax error → mermaid throws. We render a quiet error block
 *     instead of breaking the page.
 *   - empty input → render nothing.
 */
@Component({
  selector: 'app-mermaid-diagram',
  standalone: true,
  template: `
    @if (errorMessage()) {
      <div class="mermaid-error">
        <p class="meta">diagram parse failed</p>
        <pre>{{ errorMessage() }}</pre>
      </div>
    } @else if (svg()) {
      <div class="mermaid-svg" [innerHTML]="svgHtml()"></div>
    } @else {
      <div class="mermaid-empty muted small">empty diagram</div>
    }
  `,
  styles: [
    `
      :host { display: block; }
      .mermaid-svg {
        background: var(--paper);
        border: 1px solid var(--rule);
        padding: 12px;
        overflow: auto;
        max-width: 100%;
      }
      .mermaid-svg :global(svg) {
        max-width: 100%;
        height: auto;
      }
      .mermaid-error {
        background: var(--ink-red-bg);
        border: 1px solid var(--ink-red);
        padding: 10px 12px;
        font-size: 12px;
      }
      .mermaid-error pre {
        margin: 4px 0 0;
        font-family: var(--font-mono);
        white-space: pre-wrap;
      }
      .mermaid-empty {
        background: var(--paper-soft);
        border: 1px dashed var(--rule);
        padding: 20px;
        text-align: center;
      }
      .meta { margin: 0; font-size: 11px; color: var(--ink-red); }
    `,
  ],
})
export class MermaidDiagram {
  /** Mermaid source text. Re-rendered whenever this changes. */
  readonly source = input<string | null | undefined>('');
  /** Match the OS scheme so dark mode renders dark mermaid output. */
  readonly darkMode = input<boolean>(false);

  protected readonly svg = signal<string>('');
  protected readonly errorMessage = signal<string | null>(null);

  /** SVG dropped into innerHTML — Angular's standard sanitizer accepts
   *  the SVG that mermaid generates because securityLevel='strict'
   *  strips everything dangerous before we get here. */
  protected readonly svgHtml = signal<string>('');

  private host = inject(ElementRef<HTMLElement>);

  constructor() {
    effect(() => {
      const text = (this.source() ?? '').trim();
      const dark = this.darkMode();
      if (!text) {
        this.svg.set('');
        this.svgHtml.set('');
        this.errorMessage.set(null);
        return;
      }
      ensureMermaidInit(dark);
      const id = `mmd-${++renderCounter}`;
      // mermaid.render is async — fire and update signals on resolve.
      // Errors are surfaced as a small inline block; never throw past
      // the component boundary.
      void mermaid
        .render(id, text)
        .then(({ svg }) => {
          this.svg.set(svg);
          this.svgHtml.set(svg);
          this.errorMessage.set(null);
        })
        .catch((err: unknown) => {
          this.svg.set('');
          this.svgHtml.set('');
          this.errorMessage.set(err instanceof Error ? err.message : String(err));
        });
    });
  }
}
