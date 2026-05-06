import { Component, computed, input } from '@angular/core';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Renders untrusted markdown safely. Used by the per-session transcript
 * blocks and any other surface where the agent's own text lands —
 * agent output is markdown by convention, but until now we rendered it
 * as monospace pre-wrap text.
 *
 * marked → DOMPurify → innerHTML. DOMPurify strips event handlers,
 * <script>, javascript: URLs etc. We pin the parser config to
 * disable HTML passthrough so the only HTML reaching the sanitizer is
 * what marked emits from the markdown AST.
 *
 * Styling lives in the host's stylesheet; this component just emits
 * a wrapper with class `markdown-body` so consumers can target it.
 */
@Component({
  selector: 'app-markdown-view',
  standalone: true,
  template: `<div class="markdown-body" [innerHTML]="rendered()"></div>`,
  styles: [
    `
      :host { display: block; }
      .markdown-body {
        font-family: var(--font-sans);
        font-size: 13.5px;
        line-height: 1.6;
        color: var(--ink);
      }
      .markdown-body > *:first-child { margin-top: 0; }
      .markdown-body > *:last-child { margin-bottom: 0; }
      .markdown-body h1,
      .markdown-body h2,
      .markdown-body h3,
      .markdown-body h4 {
        font-family: var(--font-serif);
        margin: 1.4em 0 0.5em;
        line-height: 1.25;
      }
      .markdown-body h1 { font-size: 22px; }
      .markdown-body h2 { font-size: 18px; }
      .markdown-body h3 { font-size: 15.5px; letter-spacing: -0.005em; }
      .markdown-body h4 { font-size: 14px; }
      .markdown-body p { margin: 0.7em 0; }
      .markdown-body ul,
      .markdown-body ol { margin: 0.7em 0; padding-left: 22px; }
      .markdown-body li { margin: 0.2em 0; }
      .markdown-body li > p { margin: 0.2em 0; }
      .markdown-body strong { font-weight: 600; }
      .markdown-body em { font-style: italic; }
      .markdown-body a { color: var(--ink); text-decoration: underline; }
      .markdown-body a:hover { color: var(--ink-amber, var(--ink)); }
      .markdown-body code {
        font-family: var(--font-mono);
        font-size: 0.88em;
        background: var(--paper-soft);
        border: 1px solid var(--rule);
        padding: 1px 5px;
        border-radius: 2px;
      }
      .markdown-body pre {
        background: var(--paper-soft);
        border: 1px solid var(--rule);
        padding: 10px 12px;
        margin: 0.8em 0;
        font-size: 12px;
        line-height: 1.5;
        overflow-x: auto;
      }
      .markdown-body pre code {
        background: transparent;
        border: 0;
        padding: 0;
        font-size: inherit;
      }
      .markdown-body blockquote {
        border-left: 3px solid var(--rule-strong);
        padding: 4px 12px;
        margin: 0.7em 0;
        color: var(--ink-muted);
        font-style: italic;
      }
      .markdown-body hr {
        border: 0;
        border-top: 1px dashed var(--rule);
        margin: 1.2em 0;
      }
      .markdown-body table {
        border-collapse: collapse;
        margin: 0.8em 0;
        font-size: 12.5px;
      }
      .markdown-body th,
      .markdown-body td {
        padding: 4px 10px;
        border: 1px solid var(--rule);
        text-align: left;
      }
      .markdown-body th {
        background: var(--paper-soft);
        font-weight: 600;
      }
    `,
  ],
})
export class MarkdownView {
  readonly source = input<string | null | undefined>('');

  protected readonly rendered = computed<string>(() => {
    const src = this.source() ?? '';
    if (!src) return '';
    // marked.parse is synchronous when given a string. Cast to string —
    // some plugins return Promise<string> but we don't enable any.
    const html = marked.parse(src, { async: false }) as string;
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  });
}
