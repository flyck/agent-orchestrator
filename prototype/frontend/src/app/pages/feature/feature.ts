import { Component } from '@angular/core';
import { PlaceholderPage } from '../_placeholder';

@Component({
  selector: 'app-feature-page',
  standalone: true,
  imports: [PlaceholderPage],
  template: `
    <app-placeholder
      title="Feature"
      lead="You write the spec. From there, agents work and you can interject at any moment."
      status="Spec editor + state strip in scope for v1; downstream agent execution is v2. Hard gates were rejected — the spec is the discipline."
      docHref="../../docs/10-spec-driven-workflow.md"
    />
  `,
})
export class FeaturePage {}
