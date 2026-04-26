import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService, type Settings } from '../../services/settings.service';
import { AgentsService, type Agent } from '../../services/agents.service';
import { RepoService } from '../../services/repo.service';

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [FormsModule],
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
