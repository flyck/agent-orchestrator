import { Component } from '@angular/core';
import { PlaceholderPage } from '../_placeholder';

@Component({
  selector: 'app-review-page',
  standalone: true,
  imports: [PlaceholderPage],
  template: `
    <app-placeholder
      title="Review"
      lead="Paste a diff or local path. The planner maps the change, three reviewers (security, performance, architecture) work in parallel, and the synthesizer produces one ranked finding list."
      status="Frontend shell only. Backend orchestrator + WebSocket hub land in upcoming phases. The agent prompts already exist — see Settings."
      docHref="../../docs/07-multi-agent-review-flow.md"
    />
  `,
})
export class ReviewPage {}
