import { Component } from '@angular/core';
import { PlaceholderPage } from '../_placeholder';

@Component({
  selector: 'app-cost-page',
  standalone: true,
  imports: [PlaceholderPage],
  template: `
    <app-placeholder
      title="Cost"
      lead="Today / 7-day token + USD totals, per-agent breakdown."
      status="Scaffolded only — wired once the engine adapter records cost on session.idle."
      docHref="../../docs/04-architecture.md"
    />
  `,
})
export class CostPage {}
