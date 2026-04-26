import { Component } from '@angular/core';
import { PlaceholderPage } from '../_placeholder';

@Component({
  selector: 'app-arch-page',
  standalone: true,
  imports: [PlaceholderPage],
  template: `
    <app-placeholder
      title="Architecture compare"
      lead="Side-by-side: current design vs. one or more proposed alternatives, with structured pros/cons."
      status="Scaffolded only in v1."
      docHref="../../docs/01-product-brief.md"
    />
  `,
})
export class ArchPage {}
