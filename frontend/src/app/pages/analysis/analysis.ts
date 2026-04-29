import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgApexchartsModule, type ApexOptions } from 'ng-apexcharts';
import { Subject, switchMap, takeUntil, timer, catchError, of } from 'rxjs';
import {
  AnalysisService,
  type AggregationKind,
  type AnalysisResponse,
} from '../../services/analysis.service';

const AGG_OPTIONS: { value: AggregationKind; label: string }[] = [
  { value: 'avg', label: 'Average' },
  { value: 'p90', label: 'p90' },
  { value: 'p95', label: 'p95' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

function formatNumber(n: number, fractionDigits = 0): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) {
    return n.toLocaleString(undefined, {
      maximumFractionDigits: fractionDigits,
    });
  }
  return n.toFixed(fractionDigits);
}

@Component({
  selector: 'app-analysis-page',
  standalone: true,
  imports: [FormsModule, NgApexchartsModule],
  template: `
    <header class="head">
      <p class="meta">workspace</p>
      <h1>Analysis</h1>
      <p class="lead">
        Numbers over your completed tasks. Pick an aggregation per metric — average is the
        default. Each card uses only tasks that have reached the Done state.
      </p>
    </header>

    <section class="metric-row">
      <article class="metric-card">
        <header class="metric-head">
          <p class="meta">tasks completed</p>
          <h2>{{ data() ? data()!.tasks_completed : '—' }}</h2>
        </header>
        <p class="muted small">All-time count. Includes both first-pass accepts and send-back loops.</p>
      </article>

      <article class="metric-card">
        <header class="metric-head">
          <p class="meta">tokens per task</p>
          <select [ngModel]="tokensAgg()" (ngModelChange)="tokensAgg.set($event)">
            @for (o of AGG_OPTIONS; track o.value) {
              <option [value]="o.value">{{ o.label }}</option>
            }
          </select>
        </header>
        <h2>{{ tokensValue() }}</h2>
        <p class="muted small">
          @if (data()) {
            sample size {{ data()!.tokens_per_task.sample_size }} task(s)
          } @else {
            loading…
          }
        </p>
      </article>

      <article class="metric-card">
        <header class="metric-head">
          <p class="meta">send-backs per task</p>
          <select [ngModel]="sendbacksAgg()" (ngModelChange)="sendbacksAgg.set($event)">
            @for (o of AGG_OPTIONS; track o.value) {
              <option [value]="o.value">{{ o.label }}</option>
            }
          </select>
        </header>
        <h2>{{ sendbacksValue() }}</h2>
        <p class="muted small">
          @if (data()) {
            sample size {{ data()!.sendbacks_per_task.sample_size }} task(s)
          } @else {
            loading…
          }
        </p>
      </article>
    </section>

    <section class="chart-block">
      <header class="block-head">
        <div>
          <p class="meta">last 30 days</p>
          <h2>Daily send-backs</h2>
        </div>
      </header>
      <div class="chart-wrap">
        @let opts = dailyOptions();
        <apx-chart
          [chart]="opts.chart!"
          [series]="opts.series!"
          [stroke]="opts.stroke!"
          [grid]="opts.grid!"
          [xaxis]="opts.xaxis!"
          [yaxis]="opts.yaxis!"
          [colors]="opts.colors!"
          [legend]="opts.legend!"
          [tooltip]="opts.tooltip!"
          [dataLabels]="opts.dataLabels!"
          [markers]="opts.markers!"
          [noData]="opts.noData!"
        />
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .head { margin-bottom: 16px; max-width: 720px; }
      .lead { font-family: var(--font-serif); font-size: 17px; line-height: 1.45; }

      .metric-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 16px;
        margin: 24px 0;
      }
      @media (max-width: 900px) {
        .metric-row { grid-template-columns: 1fr; }
      }

      .metric-card {
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 16px 18px;
      }
      .metric-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 6px;
        .meta { margin: 0; }
        select {
          font-size: 12px;
          padding: 2px 8px;
          background: var(--paper);
          color: var(--ink-muted);
          border: 1px solid var(--rule);
        }
      }
      .metric-card h2 {
        margin: 4px 0 6px;
        font-family: var(--font-serif);
        font-size: 30px;
        letter-spacing: -0.01em;
      }
      .muted { color: var(--ink-muted); }
      .small { font-size: 13px; margin: 4px 0 0; }

      .chart-block { margin-top: 24px; }
      .block-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        margin-bottom: 12px;
        h2 { margin: 0; }
      }
      .chart-wrap {
        border: 1px solid var(--rule);
        background: var(--paper-soft);
        padding: 8px 8px 4px;
        min-height: 220px;
      }
    `,
  ],
})
export class AnalysisPage implements OnDestroy {
  private api = inject(AnalysisService);

  protected readonly AGG_OPTIONS = AGG_OPTIONS;

  protected readonly data = signal<AnalysisResponse | null>(null);
  protected readonly tokensAgg = signal<AggregationKind>('avg');
  protected readonly sendbacksAgg = signal<AggregationKind>('avg');

  protected readonly darkMode = signal(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  );

  private readonly destroy$ = new Subject<void>();

  protected readonly tokensValue = computed(() => {
    const d = this.data();
    if (!d) return '—';
    return formatNumber(d.tokens_per_task.aggregations[this.tokensAgg()] ?? 0);
  });

  protected readonly sendbacksValue = computed(() => {
    const d = this.data();
    if (!d) return '—';
    const v = d.sendbacks_per_task.aggregations[this.sendbacksAgg()] ?? 0;
    // Send-backs are integer counts; show one decimal for fractional
    // aggregations so "avg 0.4" doesn't get rounded to "0".
    const isInt = this.sendbacksAgg() === 'min' || this.sendbacksAgg() === 'max';
    return formatNumber(v, isInt ? 0 : 1);
  });

  protected readonly dailyOptions = computed<ApexOptions>(() => {
    const d = this.data();
    const dark = this.darkMode();
    const ink = dark ? '#E8E6DF' : '#1A1A18';
    const inkMuted = dark ? '#9D9A93' : '#6E6E69';
    const rule = dark ? '#2C2E33' : '#D8D6CF';
    const series = d
      ? [{ name: 'Send-backs', data: d.daily_sendbacks.data as number[][] }]
      : [];
    return {
      chart: {
        type: 'bar',
        height: 220,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: false },
        background: 'transparent',
        foreColor: inkMuted,
        fontFamily: 'Inter, system-ui, sans-serif',
      },
      series,
      stroke: { show: false },
      grid: { borderColor: rule, strokeDashArray: 3, xaxis: { lines: { show: false } } },
      xaxis: {
        type: 'datetime',
        axisBorder: { color: rule },
        axisTicks: { color: rule },
        labels: { style: { fontSize: '10px' } },
      },
      yaxis: {
        labels: {
          formatter: (v: number) => `${Math.round(v)}`,
          style: { fontSize: '10px' },
        },
        forceNiceScale: true,
      },
      colors: [ink],
      legend: { show: false },
      tooltip: {
        theme: dark ? 'dark' : 'light',
        x: { format: 'MMM dd' },
        y: { formatter: (v: number) => `${v} send-back${v === 1 ? '' : 's'}` },
      },
      dataLabels: { enabled: false },
      markers: { size: 0 },
      noData: {
        text: 'No send-backs in the last 30 days',
        align: 'center',
        verticalAlign: 'middle',
        style: { color: inkMuted, fontSize: '11px' },
      },
    };
  });

  constructor() {
    timer(0, 10_000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.api.get().pipe(catchError(() => of(null)))),
      )
      .subscribe((r) => {
        if (r) this.data.set(r);
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
}
