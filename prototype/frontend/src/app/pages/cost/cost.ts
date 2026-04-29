import { Component, computed, inject, signal } from '@angular/core';
import { Subject, switchMap, takeUntil, timer, catchError, of, merge } from 'rxjs';
import { Router } from '@angular/router';
import { NgApexchartsModule, type ApexOptions } from 'ng-apexcharts';
import {
  CostService,
  type CostRange,
  type CostSummary,
  type ModelCostRow,
  type TaskCostRow,
} from '../../services/cost.service';

/**
 * Cost page. Pulls the same /api/cost/summary the home top-strip uses,
 * plus /api/cost/by-model and /api/cost/top-tasks for tables. Range
 * pills (today / 7d / 30d) drive all three queries; refresh polls every
 * 30s so newly-completed runs show up without a manual reload.
 *
 * Wired against the orchestrator's existing usage_events table — every
 * assistant message with `info.finish && cost && tokens` writes one row.
 */
@Component({
  selector: 'app-cost-page',
  standalone: true,
  imports: [NgApexchartsModule],
  templateUrl: './cost.html',
  styleUrl: './cost.scss',
})
export class CostPage {
  private costApi = inject(CostService);
  private router = inject(Router);
  private destroy$ = new Subject<void>();

  protected readonly range = signal<CostRange>('7d');
  protected readonly rangeChanged$ = new Subject<void>();

  protected readonly summary = signal<CostSummary | null>(null);
  protected readonly byModel = signal<ModelCostRow[]>([]);
  protected readonly topTasks = signal<TaskCostRow[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly darkMode = signal(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  );

  protected readonly rangeLabel = computed(() => {
    switch (this.range()) {
      case 'today': return 'today';
      case '7d':    return 'last 7 days';
      case '30d':   return 'last 30 days';
    }
  });

  protected setRange(r: CostRange): void {
    if (this.range() === r) return;
    this.range.set(r);
    this.rangeChanged$.next();
  }

  /** Per-provider stacked-area daily chart. Mirrors the home page's
   *  usage chart palette so the two read consistently. */
  protected readonly chartOptions = computed<ApexOptions>(() => {
    const cs = this.summary();
    const dark = this.darkMode();
    const ink = dark ? '#E8E6DF' : '#1A1A18';
    const inkMuted = dark ? '#9D9A93' : '#6E6E69';
    const rule = dark ? '#2C2E33' : '#D8D6CF';
    const seriesColors = dark
      ? ['#E8E6DF', '#9D9A93', '#E5B870', '#E69090', '#A8C8E8']
      : ['#1A1A18', '#6E6E69', '#A66A1F', '#8B1E1E', '#1F4F8B'];
    const series =
      cs && cs.series.length > 0
        ? cs.series.map((s) => ({ name: s.provider_id, data: s.data as number[][] }))
        : [];

    const xaxis: ApexOptions['xaxis'] = {
      type: 'datetime',
      axisBorder: { color: rule },
      axisTicks: { color: rule },
      labels: { style: { fontSize: '11px', colors: inkMuted } },
    };
    if (cs?.range && Number.isFinite(cs.range.from) && Number.isFinite(cs.range.to)) {
      xaxis.min = cs.range.from;
      xaxis.max = cs.range.to;
    }

    return {
      chart: {
        type: 'area',
        height: 260,
        stacked: true,
        toolbar: { show: false },
        zoom: { enabled: false },
        background: 'transparent',
      },
      series,
      colors: seriesColors,
      stroke: { curve: 'smooth', width: 1.5 },
      fill: {
        type: 'gradient',
        gradient: { opacityFrom: 0.35, opacityTo: 0.05, stops: [0, 100] },
      },
      dataLabels: { enabled: false },
      grid: {
        borderColor: rule,
        strokeDashArray: 3,
        padding: { left: 8, right: 8, top: 0, bottom: 0 },
      },
      xaxis,
      yaxis: {
        labels: {
          style: { fontSize: '11px', colors: inkMuted },
          formatter: (v: number) => `$${v.toFixed(2)}`,
        },
      },
      legend: {
        position: 'top',
        horizontalAlign: 'left',
        fontSize: '12px',
        labels: { colors: ink },
        markers: { size: 6 },
      },
      tooltip: {
        theme: dark ? 'dark' : 'light',
        x: { format: 'MMM dd' },
        y: { formatter: (v: number) => `$${v.toFixed(4)}` },
      },
      noData: {
        text: 'no usage events in this range',
        style: { color: inkMuted, fontSize: '12px' },
      },
    } as ApexOptions;
  });

  protected formatUsd(n: number): string {
    if (!Number.isFinite(n)) return '$0.00';
    if (n < 0.01) return `$${n.toFixed(5)}`;
    if (n < 1) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
  }

  protected formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  protected openTask(taskId: string): void {
    this.router.navigate(['/home'], { queryParams: { task: taskId } });
  }

  constructor() {
    // 30s poll, plus an immediate refetch on range change. Three queries
    // run in parallel — they're cheap (single SQL each).
    merge(timer(0, 30_000), this.rangeChanged$)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => {
          this.loading.set(true);
          const r = this.range();
          return this.costApi.summary(r).pipe(
            catchError((e) => {
              this.error.set(e?.message ?? String(e));
              return of(null);
            }),
          );
        }),
      )
      .subscribe((s) => {
        this.summary.set(s);
        this.loading.set(false);
        if (s) this.error.set(null);
      });

    merge(timer(0, 30_000), this.rangeChanged$)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          this.costApi.byModel(this.range()).pipe(catchError(() => of({ by_model: [] }))),
        ),
      )
      .subscribe((r) => this.byModel.set(r.by_model));

    merge(timer(0, 30_000), this.rangeChanged$)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          this.costApi.topTasks(this.range(), 10).pipe(catchError(() => of({ tasks: [] }))),
        ),
      )
      .subscribe((r) => this.topTasks.set(r.tasks));

    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => this.darkMode.set(e.matches);
      mq.addEventListener('change', handler);
      this.destroy$.subscribe(() => mq.removeEventListener('change', handler));
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
