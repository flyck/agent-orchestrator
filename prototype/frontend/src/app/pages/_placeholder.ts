import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-placeholder',
  standalone: true,
  template: `
    <article class="placeholder">
      <p class="meta">workspace</p>
      <h1>{{ title }}</h1>
      <p class="lead">{{ lead }}</p>
      <hr />
      <p class="meta">v1 status</p>
      <p>{{ status }}</p>
      <p class="meta">design reference</p>
      <p>
        See
        <a [href]="docHref" target="_blank" rel="noopener">{{ docHref }}</a>
      </p>
    </article>
  `,
  styles: [
    `
      .placeholder { max-width: 720px; }
      .lead { font-family: var(--font-serif); font-size: 18px; color: var(--ink); margin: 8px 0 4px; }
      p { margin: 8px 0; color: var(--ink-muted); }
      p.lead { color: var(--ink); }
      a { word-break: break-all; }
    `,
  ],
})
export class PlaceholderPage {
  @Input() title = '';
  @Input() lead = '';
  @Input() status = '';
  @Input() docHref = '';
}
