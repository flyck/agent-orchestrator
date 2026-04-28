import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgApexchartsModule, type ApexOptions } from 'ng-apexcharts';
import { Subject, switchMap, takeUntil, timer, catchError, of } from 'rxjs';
import {
  ActivitiesService,
  type Activity,
  type ActivityActor,
  type ActivityKind,
} from '../services/activities.service';

/**
 * Home top-left activity panel:
 *   • Squares strip — one per recent event, colored by actor and kind.
 *     Hover surfaces the kind + task title; click jumps to ?task=<id>.
 *   • Small pie — agent vs. manual ratio over the visible activities.
 *
 * The visualisation itself reminds the user when their manual ratio is
 * thin, replacing the explicit "do something manual today" banner.
 */

const KIND_LABEL: Record<ActivityKind, string> = {
  spec_create: 'Spec write',
  spec_edit: 'Spec edit',
  review_sendback: 'Send-back',
  review_rate: 'Review rating',
  finalize: 'Finalize',
  task_run: 'Agent run',
  abandon: 'Abandoned',
};

@Component({
  selector: 'app-activity-panel',
  standalone: true,
  imports: [NgApexchartsModule],
  template: `
    <section class="activity">
      <header class="block-head">
        <div>
          <p class="meta">recent activity · last {{ activities().length }} events</p>
          <h2>What's been happening</h2>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="sq sq-spec"></span>Spec</span>
          <span class="legend-item"><span class="sq sq-review"></span>Review</span>
          <span class="legend-item"><span class="sq sq-agent"></span>Agent</span>
          <span class="legend-item"><span class="sq sq-abandoned"></span>Abandoned</span>
        </div>
      </header>

      <div class="activity-body">
        <div class="squares" role="list">
          @for (a of activities(); track a.id) {
            <button
              class="sq"
              type="button"
              role="listitem"
              [class.sq-agent]="a.actor === 'agent' && a.kind !== 'abandon'"
              [class.sq-spec]="a.kind === 'spec_create' || a.kind === 'spec_edit'"
              [class.sq-review]="
                a.kind === 'review_sendback' ||
                a.kind === 'review_rate' ||
                a.kind === 'finalize'
              "
              [class.sq-abandoned]="a.kind === 'abandon'"
              [title]="tooltip(a)"
              [disabled]="!a.task_id"
              (click)="jumpToTask(a.task_id)"
            ></button>
          } @empty {
            <p class="muted small">No activity yet — finish a task to populate this strip.</p>
          }
        </div>

        @if (activities().length > 0) {
          <div class="ratio">
            @let opts = pieOptions();
            <apx-chart
              [chart]="opts.chart!"
              [series]="opts.series!"
              [labels]="opts.labels!"
              [colors]="opts.colors!"
              [legend]="opts.legend!"
              [stroke]="opts.stroke!"
              [dataLabels]="opts.dataLabels!"
              [tooltip]="opts.tooltip!"
              [plotOptions]="opts.plotOptions!"
            />
            <p class="ratio-meta meta">{{ ratioLabel() }}</p>
          </div>
        }
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .activity {
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 14px 16px;
      }
      .block-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 16px;
        margin-bottom: 12px;
        h2 { margin: 0; }
      }
      .legend {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--ink-muted);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .legend-item .sq {
        width: 10px;
        height: 10px;
        border-radius: 1px;
        cursor: default;
      }
      .activity-body {
        display: grid;
        grid-template-columns: 1fr 140px;
        gap: 16px;
        align-items: start;
      }
      .squares {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-content: flex-start;
        padding: 4px 0;
      }
      .sq {
        width: 14px;
        height: 14px;
        padding: 0;
        border: 1px solid var(--rule);
        border-radius: 1px;
        background: var(--ink-faint);
        cursor: pointer;
        transition: outline 0.05s ease;
      }
      .sq:hover { outline: 1px solid var(--ink); outline-offset: 1px; }
      .sq:disabled { cursor: default; }
      /* Three category palettes — gray for agent, sage-green for spec, slate-blue for review. */
      .sq-agent     { background: var(--ink-faint); border-color: var(--ink-faint); }
      .sq-spec      { background: #6E8F66; border-color: #4F7048; }
      .sq-review    { background: #5874A2; border-color: #3D5882; }
      .sq-abandoned { background: var(--ink-red); border-color: var(--ink-red); }
      @media (prefers-color-scheme: dark) {
        .sq-spec   { background: #88AB80; border-color: #ADCDA5; }
        .sq-review { background: #7991BB; border-color: #9DAFCF; }
      }
      .ratio {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      .ratio-meta { margin: 0; }
      .muted { color: var(--ink-muted); }
      .small { font-size: 12.5px; }
    `,
  ],
})
export class ActivityPanel implements OnInit, OnDestroy {
  private api = inject(ActivitiesService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  protected readonly activities = signal<Activity[]>([]);
  private readonly destroy$ = new Subject<void>();

  protected readonly darkMode = signal(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  );

  /** Counts split into the same 3 categories the squares use. */
  protected readonly categoryCounts = computed<{ agent: number; spec: number; review: number }>(() => {
    const c = { agent: 0, spec: 0, review: 0 };
    for (const a of this.activities()) {
      if (a.actor === 'agent') c.agent++;
      else if (a.kind === 'spec_create' || a.kind === 'spec_edit') c.spec++;
      else c.review++;
    }
    return c;
  });

  protected readonly ratioLabel = computed(() => {
    const c = this.categoryCounts();
    const total = c.agent + c.spec + c.review;
    if (total === 0) return '';
    const manual = c.spec + c.review;
    const pct = Math.round((manual / total) * 100);
    return `${pct}% manual`;
  });

  protected readonly pieOptions = computed<ApexOptions>(() => {
    const dark = this.darkMode();
    const c = this.categoryCounts();
    const ink = dark ? '#E8E6DF' : '#1A1A18';
    const inkMuted = dark ? '#9D9A93' : '#6E6E69';
    return {
      chart: {
        type: 'donut',
        height: 180,
        width: 140,
        animations: { enabled: false },
        background: 'transparent',
        foreColor: inkMuted,
        fontFamily: 'Inter, system-ui, sans-serif',
        toolbar: { show: false },
      },
      series: [c.agent, c.spec, c.review],
      labels: ['Agent', 'Spec (you)', 'Review (you)'],
      colors: dark
        ? ['#5C5A55', '#88AB80', '#7991BB']
        : ['#A3A19A', '#6E8F66', '#5874A2'],
      legend: {
        show: true,
        position: 'bottom' as const,
        fontSize: '11px',
        fontFamily: 'Inter, system-ui, sans-serif',
        labels: { colors: inkMuted },
        markers: { size: 5, offsetX: -2 },
        itemMargin: { horizontal: 4, vertical: 0 },
      },
      stroke: { width: 1, colors: [dark ? '#16171A' : '#FAFAF7'] },
      dataLabels: { enabled: false },
      tooltip: {
        theme: dark ? 'dark' : 'light',
        y: { formatter: (v: number) => `${v} event${v === 1 ? '' : 's'}` },
      },
      plotOptions: {
        pie: {
          donut: {
            size: '60%',
            labels: { show: false },
          },
        },
      },
    };
  });

  ngOnInit(): void {
    timer(0, 5000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.api.list(120).pipe(catchError(() => of({ activities: [] })))),
      )
      .subscribe((r) => {
        // Reverse so chronological-oldest renders left-to-right; the API
        // returns newest-first.
        this.activities.set([...r.activities].reverse());
      });

    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e: MediaQueryListEvent) => this.darkMode.set(e.matches);
      mq.addEventListener?.('change', onChange);
      this.destroy$.subscribe(() => mq.removeEventListener?.('change', onChange));
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  protected tooltip(a: Activity): string {
    const kind = KIND_LABEL[a.kind] ?? a.kind;
    const title = a.task_title ?? '(unknown task)';
    return `${kind} — ${title}\n(click to open)`;
  }

  protected jumpToTask(id: string | null): void {
    if (!id) return;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { task: id },
      queryParamsHandling: 'merge',
    });
  }
}
