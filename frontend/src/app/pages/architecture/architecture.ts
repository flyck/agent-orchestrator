import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, of, Subject, switchMap, takeUntil, timer } from 'rxjs';
import { MermaidDiagram } from '../../components/mermaid-diagram';
import {
  ArchitectureService,
  type ArchitectureTask,
} from '../../services/architecture.service';

/**
 * Architecture page. Browse the concept diagrams from approved
 * (status='done') tasks — pull-back at past architectural sketches
 * the intake / explorer agents drew. Two-pane layout: compact list
 * on the left, large diagram canvas on the right.
 *
 * Task list comes from /api/architecture/diagrams, which already
 * filters out tasks without a mermaid block. The list is read-only;
 * clicking a task pins it to the right pane.
 */
@Component({
  selector: 'app-architecture-page',
  standalone: true,
  imports: [MermaidDiagram],
  templateUrl: './architecture.html',
  styleUrl: './architecture.scss',
})
export class ArchitecturePage {
  private api = inject(ArchitectureService);
  private router = inject(Router);
  private destroy$ = new Subject<void>();

  protected readonly tasks = signal<ArchitectureTask[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly selectedId = signal<string | null>(null);

  protected readonly darkMode = signal(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  );

  protected readonly selected = computed<ArchitectureTask | null>(() => {
    const id = this.selectedId();
    if (!id) return this.tasks()[0] ?? null;
    return this.tasks().find((t) => t.id === id) ?? this.tasks()[0] ?? null;
  });

  constructor() {
    timer(0, 30_000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => {
          this.loading.set(true);
          return this.api.list().pipe(
            catchError((e) => {
              this.error.set(e?.message ?? String(e));
              return of(null);
            }),
          );
        }),
      )
      .subscribe((r) => {
        this.loading.set(false);
        if (r) {
          this.error.set(null);
          this.tasks.set(r.tasks);
          // If nothing selected yet, default to the most recent task.
          if (!this.selectedId() && r.tasks.length > 0) {
            this.selectedId.set(r.tasks[0]!.id);
          }
        }
      });

    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => this.darkMode.set(e.matches);
      mq.addEventListener('change', handler);
      this.destroy$.subscribe(() => mq.removeEventListener('change', handler));
    }
  }

  protected select(id: string): void {
    this.selectedId.set(id);
  }

  protected openTask(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.router.navigate(['/home'], { queryParams: { task: id } });
  }

  protected formatDate(ts: number): string {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  protected workspaceLabel(w: string): string {
    switch (w) {
      case 'review':       return 'PR review';
      case 'feature':      return 'feature';
      case 'bugfix':       return 'bugfix';
      case 'arch_compare': return 'architecture';
      case 'background':   return 'background';
      case 'internal':     return 'internal';
      default:             return w;
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
