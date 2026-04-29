import { Component, computed, EventEmitter, inject, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TasksService, type TaskWorkspace } from '../services/tasks.service';

/** User-creatable kinds in this dialog. Excludes `review`, `background`,
 *  and `internal` — those are created by other flows (Review tab, the
 *  background queue, internal orchestration). */
type DialogKind = Extract<TaskWorkspace, 'feature' | 'bugfix' | 'arch_compare'>;

/**
 * Per-kind spec templates. Different kinds prompt for different things —
 * Bugfix renames Goal→"Bug summary" and adds Repro steps + Expected vs.
 * Observed, per docs/05 Phase 12.
 *
 * Section bodies start with an angle-bracket placeholder (e.g.
 * `<concrete, checkable: when X happens, Y>`). We treat any section whose
 * body is whitespace OR consists only of placeholders/bullets-with-only-
 * placeholders as "empty" for the soft-completeness hint.
 */
const TEMPLATES: Record<DialogKind, string> = {
  feature: `## Goal

<one paragraph: what outcome are we after?>

## Non-goals

- <what we are NOT doing>

## Acceptance criteria

- <concrete, checkable: when X happens, Y>

## Scope

- <files / modules likely to change — best guess; agent may correct>

## Open questions

- <known unknowns; the agent may answer here on re-run>
`,
  bugfix: `## Bug summary

<one paragraph: what's broken and where you noticed it?>

## Repro steps

1. <step one>
2. <step two>
3. <…>

## Expected vs. observed

- Expected: <what should happen>
- Observed: <what actually happens>

## Scope

- <files / modules likely to change — best guess; agent may correct>

## Open questions

- <known unknowns; the agent may answer here on re-run>
`,
  arch_compare: `## Goal

<one paragraph: which architectural choice are we evaluating?>

## Current architecture

<short description of what's in place today>

## Proposed architecture

<short description of the alternative under consideration>

## Decision criteria

- <what makes one option better than the other for our case>

## Open questions

- <known unknowns; the agent may answer here on re-run>
`,
};

/** Strip angle-bracket placeholders + leading bullets/numbers from a section
 *  body so we can decide whether the user has actually written anything.
 *  Returns true if the section is "empty" (untouched template). */
function isSectionEmpty(body: string): boolean {
  const cleaned = body
    .split('\n')
    .map((l) => l.trim())
    // Drop bare list markers ("-", "1.") and angle-bracket placeholders.
    .map((l) =>
      l
        .replace(/^[-*]\s*/, '')
        .replace(/^\d+\.\s*/, '')
        .replace(/<[^>]*>/g, '')
        .replace(/^Expected:\s*$/i, '')
        .replace(/^Observed:\s*$/i, '')
        .trim(),
    )
    .filter(Boolean)
    .join('');
  return cleaned.length === 0;
}

/** Parse `## Heading` blocks out of the spec markdown and return the names
 *  of any whose body is still empty per `isSectionEmpty`. Order preserved
 *  so hints render in the same order as the template. */
function emptySectionNames(spec: string): string[] {
  const lines = spec.split('\n');
  const out: string[] = [];
  let currentHeading: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentHeading && isSectionEmpty(buffer.join('\n'))) out.push(currentHeading);
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      currentHeading = m[1];
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

interface KindOption {
  value: DialogKind;
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
      <div class="dialog" role="dialog" [attr.aria-label]="editingId() ? 'Edit spec' : 'New task'">
        <header>
          <p class="meta">spec · per the manifesto, you author this</p>
          <h2>{{ editingId() ? 'Edit spec' : 'New task' }}</h2>
        </header>

        <div class="form">
          @if (!editingId()) {
            <label class="label-row">
              <span class="label">Kind</span>
              <select [ngModel]="kind()" (ngModelChange)="setKind($event)" name="kind">
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
          } @else {
            <p class="meta editing-context">
              editing <code class="mono">{{ editingId() }}</code> — saves a new revision.
              The agent does not auto-pick this up; click "Send back" on the task to apply.
            </p>
          }

          <label class="label-row stretch">
            <span class="label">Spec</span>
            <textarea rows="14"
                      name="spec"
                      [(ngModel)]="spec"
                      spellcheck="false"></textarea>
          </label>

          <!-- Soft completeness hints. Empty sections (still containing
               the angle-bracket template placeholders) surface here. They
               never block submission — per docs/10, discipline is the
               user's; we just whisper. -->
          @if (emptySections().length > 0) {
            <div class="hints">
              @for (name of emptySections(); track name) {
                <p class="hint meta">
                  <span class="hint-section">{{ name }}</span> empty — proceed without?
                </p>
              }
            </div>
          }

          @if (status()) {
            <p class="status" [class.error]="error()">{{ status() }}</p>
          }
        </div>

        <footer>
          <button type="button" (click)="cancel()" [disabled]="busy()">Cancel</button>
          <button type="button" class="primary" (click)="submit()"
                  [disabled]="busy() || (!editingId() && !title().trim())">
            {{ submitLabel() }}
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
      .editing-context {
        margin: 0 0 4px;
        padding: 6px 10px;
        background: var(--paper-soft);
        border: 1px solid var(--rule);
        font-size: 12px;
      }
      .editing-context code { font-size: 11.5px; }
      .hints {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px 0 0;
        border-top: 1px solid var(--rule);
      }
      .hint {
        margin: 0;
        font-size: 12px;
        color: var(--ink-faint);
      }
      .hint-section {
        color: var(--ink-muted);
        font-weight: 500;
      }
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
  protected readonly spec = signal(TEMPLATES.feature);
  protected readonly kind = signal<DialogKind>('feature');
  /** When set, the dialog is in edit-spec mode for that task id. Null = create. */
  protected readonly editingId = signal<string | null>(null);

  /** Soft hints listing section names whose body is still the template
   *  placeholder. Recomputed on every spec keystroke (cheap — small string,
   *  one regex pass per line). */
  protected readonly emptySections = computed(() => emptySectionNames(this.spec()));

  /** Submit-button label tracks mode and busy state. */
  protected readonly submitLabel = computed(() => {
    if (this.busy()) return this.editingId() ? 'Saving…' : 'Creating…';
    return this.editingId() ? 'Save revision' : 'Create & run';
  });

  /** Emitted with the new task id once create+run succeed (create mode),
   *  or the edited task id once save succeeds (edit mode). The parent
   *  page can use this to refresh / select the task. */
  @Output() created = new EventEmitter<string>();

  /** Open the dialog. With no args, blank create form. With initial
   *  values (used by the voice-input flow), title and/or spec are
   *  pre-filled and the user reviews/edits before clicking Create. */
  show(initial?: { title?: string; spec?: string }) {
    this.editingId.set(null);
    this.title.set(initial?.title ?? '');
    this.kind.set('feature');
    this.spec.set(initial?.spec ?? TEMPLATES.feature);
    this.status.set(null);
    this.error.set(false);
    this.open.set(true);
  }

  /** Open in edit-spec mode, pre-filled with the current spec. */
  showEdit(taskId: string, currentSpec: string) {
    this.editingId.set(taskId);
    this.title.set('');
    this.spec.set(currentSpec);
    this.status.set(null);
    this.error.set(false);
    this.open.set(true);
  }

  /** Switch kind. If the user hasn't touched the spec yet (current text is
   *  exactly one of the kind templates), swap to the new kind's template
   *  so the section headers match. Otherwise leave the spec alone — we
   *  don't trash the user's drafted content. */
  setKind(k: DialogKind) {
    const current = this.spec();
    const untouched = Object.values(TEMPLATES).includes(current);
    this.kind.set(k);
    if (untouched) this.spec.set(TEMPLATES[k]);
  }

  cancel() {
    if (this.busy()) return;
    this.open.set(false);
  }

  submit() {
    const editingId = this.editingId();
    if (editingId) {
      this.submitEdit(editingId);
      return;
    }
    this.submitCreate();
  }

  private submitCreate() {
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

  private submitEdit(taskId: string) {
    this.busy.set(true);
    this.error.set(false);
    this.status.set('saving revision…');
    this.tasksApi.updateSpec(taskId, this.spec()).subscribe({
      next: () => {
        this.busy.set(false);
        this.open.set(false);
        this.created.emit(taskId);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(true);
        this.status.set(`Save failed: ${e?.error?.message ?? e?.message ?? e}`);
      },
    });
  }
}
