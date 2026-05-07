import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService, type Settings } from '../../services/settings.service';
import { AgentsService, type Agent } from '../../services/agents.service';
import { RepoService } from '../../services/repo.service';
import { IntegrationsPanel } from '../../components/integrations-panel';

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [FormsModule, IntegrationsPanel],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPage {
  private settingsApi = inject(SettingsService);
  private agentsApi = inject(AgentsService);
  private repoApi = inject(RepoService);

  /** Result of the most recent "Test" click on an open-command input.
   *  command is null when nothing has been tested yet. The matching row's
   *  result line reads from this signal. */
  protected readonly testResult = signal<{
    command: 'ide' | 'emacs' | 'magit' | null;
    message: string;
    error: boolean;
  }>({ command: null, message: '', error: false });

  testOpen(which: 'ide' | 'emacs' | 'magit') {
    // Save first if there are unsaved edits — otherwise we'd test a stale
    // command. If no draft, skip straight to the open call.
    const fire = () => {
      this.testResult.set({ command: which, message: 'launching…', error: false });
      this.repoApi.open(which).subscribe({
        next: (r) =>
          this.testResult.set({
            command: which,
            message: `launched: ${r.cmd} ${r.args.join(' ')}`,
            error: false,
          }),
        error: (e) =>
          this.testResult.set({
            command: which,
            message: e?.error?.message ?? `failed: ${e?.message ?? e}`,
            error: true,
          }),
      });
    };
    if (this.hasUnsaved()) {
      this.savingMessage.set('saving before test…');
      this.settingsApi.update(this.draft()).subscribe({
        next: (s) => {
          this.settings.set(s);
          this.draft.set({});
          this.savingMessage.set(null);
          fire();
        },
        error: (e) => {
          this.savingMessage.set(`save failed: ${e.message ?? e}`);
          this.testResult.set({
            command: which,
            message: 'saved failed; not tested',
            error: true,
          });
        },
      });
    } else {
      fire();
    }
  }

  protected readonly settings = signal<Settings | null>(null);
  protected readonly agents = signal<Agent[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly savingMessage = signal<string | null>(null);

  // Local edit buffer; commits on blur / Save button.
  protected readonly draft = signal<Partial<Settings>>({});

  // ─── Agent editor (inline expand) ────────────────────────────────
  // Open agent id, with split source loaded into frontmatter + body
  // drafts. The editor saves to disk via PUT /api/agents/:id/source;
  // the backend warns the user a restart is needed for the runtime
  // to pick up the new prompt.
  protected readonly editingAgentId = signal<string | null>(null);
  protected readonly agentDraftFrontmatter = signal<string>('');
  protected readonly agentDraftBody = signal<string>('');
  protected readonly agentEditorLoading = signal<boolean>(false);
  protected readonly agentEditorError = signal<string | null>(null);
  /** Structured validator errors from the backend's pre-save check —
   *  shown as a bullet list so the user sees exactly which keys are
   *  malformed in the frontmatter. */
  protected readonly agentEditorIssues = signal<string[]>([]);
  protected readonly agentEditorSaving = signal<boolean>(false);
  protected readonly agentEditorSavedAt = signal<number | null>(null);

  toggleAgentEditor(id: string): void {
    if (this.editingAgentId() === id) {
      this.editingAgentId.set(null);
      return;
    }
    this.editingAgentId.set(id);
    this.agentDraftFrontmatter.set('');
    this.agentDraftBody.set('');
    this.agentEditorError.set(null);
    this.agentEditorIssues.set([]);
    this.agentEditorSavedAt.set(null);
    this.agentEditorLoading.set(true);
    this.agentsApi.getSource(id).subscribe({
      next: (s) => {
        this.agentDraftFrontmatter.set(s.frontmatter);
        this.agentDraftBody.set(s.body);
        this.agentEditorLoading.set(false);
      },
      error: (e) => {
        this.agentEditorLoading.set(false);
        this.agentEditorError.set(e?.error?.message ?? e?.message ?? String(e));
      },
    });
  }

  saveAgentSource(id: string): void {
    if (this.agentEditorSaving()) return;
    this.agentEditorSaving.set(true);
    this.agentEditorError.set(null);
    this.agentEditorIssues.set([]);
    this.agentsApi
      .saveSource(id, {
        frontmatter: this.agentDraftFrontmatter(),
        body: this.agentDraftBody(),
      })
      .subscribe({
        next: () => {
          this.agentEditorSaving.set(false);
          this.agentEditorSavedAt.set(Date.now());
        },
        error: (e) => {
          this.agentEditorSaving.set(false);
          this.agentEditorError.set(e?.error?.message ?? e?.message ?? String(e));
          const issues = e?.error?.issues;
          if (Array.isArray(issues)) {
            this.agentEditorIssues.set(issues.filter((s) => typeof s === 'string'));
          }
        },
      });
  }

  protected readonly merged = computed<Settings | null>(() => {
    const s = this.settings();
    if (!s) return null;
    return { ...s, ...this.draft() };
  });

  protected readonly hasUnsaved = computed(() => Object.keys(this.draft()).length > 0);

  constructor() {
    this.refresh();
  }

  refresh() {
    this.loadError.set(null);
    this.settingsApi.get().subscribe({
      next: (s) => this.settings.set(s),
      error: (e) => this.loadError.set(`Couldn't load settings: ${e.message ?? e}`),
    });
    this.agentsApi.list().subscribe({
      next: (r) => this.agents.set(r.agents),
      error: (e) => this.loadError.set(`Couldn't load agents: ${e.message ?? e}`),
    });
  }

  setDraft<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  save() {
    const patch = this.draft();
    if (Object.keys(patch).length === 0) return;
    this.savingMessage.set('saving…');
    this.settingsApi.update(patch).subscribe({
      next: (s) => {
        this.settings.set(s);
        this.draft.set({});
        this.savingMessage.set('saved');
        setTimeout(() => this.savingMessage.set(null), 1500);
      },
      error: (e) => this.savingMessage.set(`error: ${e.message ?? e}`),
    });
  }

  discard() {
    this.draft.set({});
  }
}
