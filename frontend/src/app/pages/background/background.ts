import { Component } from '@angular/core';
import { PlaceholderPage } from '../_placeholder';

@Component({
  selector: 'app-background-page',
  standalone: true,
  imports: [PlaceholderPage],
  template: `
    <app-placeholder
      title="Background"
      lead="Agent-initiated hygiene work in its own queue. Default concurrency 1. Findings, not patches."
      status="Scaffolded only in v1. Default agents (dead-code-detector, todo-aging, dependency-hygiene, doc-drift) ship disabled."
      docHref="../../docs/11-background-agents.md"
    />
  `,
})
export class BackgroundPage {}
