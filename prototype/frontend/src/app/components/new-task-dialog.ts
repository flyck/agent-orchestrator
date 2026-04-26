import { Component, EventEmitter, inject, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TasksService, type TaskWorkspace } from '../services/tasks.service';

const SPEC_TEMPLATE = `## Goal

<one paragraph: what outcome are we after?>

## Non-goals

- <what we are NOT doing>

## Acceptance criteria

- <concrete, checkable: when X happens, Y>

## Scope

- <files / modules likely to change — best guess; agent may correct>

## Open questions

- <known unknowns; the agent may answer here on re-run>
`;

interface KindOption {
  value: TaskWorkspace;
  label: string;
}

const KINDS: KindOption[] = [
  { value: 'feature', label: 'Feature' },
  { value: 'bugfix', label: 'Bugfix' },
  { value: 'arch_compare', label: 'Architecture' },
];

@Component({
  selector: 'app-new-task-dialog',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (open()) {
      <div class="overlay" (click)="cancel()"></div>
      <div class="dialog" role="dialog" aria-label="New task">
        <header>
          <p class="meta">spec · per the manifesto, you author this</p>
          <h2>New task</h2>
        </header>

        <div class="form">
          <label class="label-row">
            <span class="label">Kind</span>
            <select [(ngModel)]="kind" name="kind">
              @for (k of kinds; track k.value) {
                <option [value]="k.value">{{ k.label }}</option>
              }
            </select>
          </label>

          <label class="label-row">
            <span class="label">Title</span>
            <input type="text" name="title"
                   [(ngModel)]="title"
                   placeholder="One-line summary, e.g. 'Add Today/Week/Month range buttons to usage chart'"
                   maxlength="500" />
          </label>

          <label class="label-row stretch">
            <span class="label">Spec</span>
            <textarea rows="14"
                      name="spec"
                      [(ngModel)]="spec"
                      spellcheck="false"></textarea>
          </label>

          @if (status()) {
            <p class="status" [class.error]="error()">{{ status() }}</p>
          }
        </div>

        <footer>
          <button type="button" (click)="cancel()" [disabled]="busy()">Cancel</button>
          <button type="button" class="primary" (click)="submit()" [disabled]="busy() || !title().trim()">
            {{ busy() ? 'Creating…' : 'Create & run' }}
          </button>
        </footer>
      </div>
    }
  `,
  styles: [
    `
      :host { display: contents; }
      .overlay {
        position: fixed; inset: 0;
        background: rgba(26, 26, 24, 0.18);
        z-index: 50;
      }
      .dialog {
        position: fixed;
        z-index: 51;
        top: 6vh;
        left: 50%;
        transform: translateX(-50%);
        width: min(720px, 94vw);
        max-height: 88vh;
        display: flex;
        flex-direction: column;
        background: var(--paper);
        border: 1px solid var(--rule-strong);
        padding: 24px;
        h2 { margin: 4px 0 0; }
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin: 16px 0;
        flex: 1;
        overflow: auto;
      }
      .label-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .label-row.stretch { flex: 1; min-height: 200px; }
      .label-row.stretch textarea {
        flex: 1;
        min-height: 200px;
        font-family: var(--font-mono);
        font-size: 12.5px;
        line-height: 1.55;
        resize: vertical;
      }
      .label {
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--ink-muted);
      }
      input[type="text"], select {
        width: 100%;
      }
      .status {
        margin: 0;
        font-size: 13px;
        color: var(--ink-muted);
      }
      .status.error { color: var(--ink-red); }
      footer {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
    `,
  ],
})
export class NewTaskDialog {
  private tasksApi = inject(TasksService);

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly status = signal<string | null>(null);
  protected readonly error = signal(false);
  protected readonly kinds = KINDS;

  protected readonly title = signal('');
  protected readonly spec = signal(SPEC_TEMPLATE);
  protected readonly kind = signal<TaskWorkspace>('feature');

  /** Emitted with the new task id once create+run succeed, so the parent
   *  page can select it (drives ?task=<id> + opens the detail panel). */
  @Output() created = new EventEmitter<string>();

  show() {
    this.title.set('');
    this.spec.set(SPEC_TEMPLATE);
    this.kind.set('feature');
    this.status.set(null);
    this.error.set(false);
    this.open.set(true);
  }

  cancel() {
    if (this.busy()) return;
    this.open.set(false);
  }

  submit() {
    const title = this.title().trim();
    if (!title) return;
    this.busy.set(true);
    this.error.set(false);
    this.status.set('creating task…');
    this.tasksApi
      .create({
        workspace: this.kind(),
        title,
        input_kind: 'spec',
        input_payload: this.spec(),
      })
      .subscribe({
        next: (t) => {
          this.status.set(`starting agent…`);
          this.tasksApi.run(t.id).subscribe({
            next: () => {
              this.busy.set(false);
              this.open.set(false);
              this.created.emit(t.id);
            },
            error: (e) => {
              this.busy.set(false);
              this.error.set(true);
              this.status.set(
                `Task created (${t.id}) but run failed: ${e?.error?.message ?? e?.message ?? e}`,
              );
            },
          });
        },
        error: (e) => {
          this.busy.set(false);
          this.error.set(true);
          this.status.set(`Create failed: ${e?.error?.message ?? e?.message ?? e}`);
        },
      });
  }
}
