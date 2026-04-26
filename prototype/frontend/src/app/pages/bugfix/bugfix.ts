import { Component } from '@angular/core';
import { PlaceholderPage } from '../_placeholder';

@Component({
  selector: 'app-bugfix-page',
  standalone: true,
  imports: [PlaceholderPage],
  template: `
    <app-placeholder
      title="Bugfix"
      lead="Same gates as Feature with a bug-shaped spec template (repro steps, expected vs. observed, suspected scope, acceptance)."
      status="Spec editor in scope for v1; downstream agent execution v2."
      docHref="../../docs/10-spec-driven-workflow.md"
    />
  `,
})
export class BugfixPage {}
