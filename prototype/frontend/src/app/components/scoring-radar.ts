import { Component, computed, input } from '@angular/core';
import { NgApexchartsModule, type ApexOptions } from 'ng-apexcharts';
import type { TaskScoringRow } from '../services/tasks.service';

/**
 * Per-task radar chart. Five fixed axes, scored 1–10. Empty axes render
 * as 0 so the polygon collapses toward the center but the chart frame
 * stays consistent — that way the user can visually compare two tasks
 * side-by-side later. Color palette tracks prefers-color-scheme like the
 * usage chart on the home page.
 */
const AXES: { key: string; label: string }[] = [
  { key: 'complexity',      label: 'Complexity' },
  { key: 'involved_parts',  label: 'Parts' },
  { key: 'lines_of_code',   label: 'LoC' },
  { key: 'user_benefit',    label: 'Benefit' },
  { key: 'maintainability', label: 'Maintain' },
];

@Component({
  selector: 'app-scoring-radar',
  standalone: true,
  imports: [NgApexchartsModule],
  template: `
    <div class="radar-wrap">
      <header class="radar-head">
        <h3>Solution scoring</h3>
        <span class="meta">{{ summaryLine() }}</span>
      </header>
      @if (hasAnyScore()) {
        @let opts = options();
        <apx-chart
          [chart]="opts.chart!"
          [series]="opts.series!"
          [labels]="opts.labels!"
          [stroke]="opts.stroke!"
          [fill]="opts.fill!"
          [markers]="opts.markers!"
          [yaxis]="opts.yaxis!"
          [xaxis]="opts.xaxis!"
          [colors]="opts.colors!"
          [legend]="opts.legend!"
          [tooltip]="opts.tooltip!"
          [dataLabels]="opts.dataLabels!"
          [plotOptions]="opts.plotOptions!"
        />
        <ul class="radar-axes">
          @for (axis of AXES; track axis.key) {
            @let row = byKey()[axis.key];
            <li>
              <span class="axis-label">{{ axis.label }}</span>
              <span class="axis-score mono">{{ row ? row.score : '—' }}/10</span>
              @if (row?.rationale) {
                <span class="axis-rationale">{{ row?.rationale }}</span>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="muted small">
          No scoring yet — the reviewer agent posts axes when it finishes its pass.
        </p>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .radar-wrap {
        margin: 16px 0 0;
        padding: 12px 14px;
        border: 1px solid var(--rule);
        background: var(--paper);
      }
      .radar-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
        margin-bottom: 4px;
        h3 {
          margin: 0;
          font-family: var(--font-serif);
          font-size: 16px;
        }
      }
      .radar-axes {
        list-style: none;
        margin: 4px 0 0;
        padding: 0;
        display: grid;
        grid-template-columns: 1fr;
        gap: 4px;
      }
      .radar-axes li {
        display: grid;
        grid-template-columns: 110px 60px 1fr;
        gap: 10px;
        align-items: baseline;
        font-size: 12.5px;
      }
      .axis-label {
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-size: 11px;
        color: var(--ink-muted);
      }
      .axis-score { color: var(--ink); }
      .axis-rationale {
        color: var(--ink-muted);
        font-size: 12.5px;
        line-height: 1.45;
      }
      .small { font-size: 12.5px; }
      .muted { color: var(--ink-muted); margin: 4px 0 0; }
    `,
  ],
})
export class ScoringRadar {
  readonly scoring = input.required<TaskScoringRow[]>();
  readonly darkMode = input<boolean>(false);

  protected readonly AXES = AXES;

  protected readonly byKey = computed<Record<string, TaskScoringRow | undefined>>(() => {
    const map: Record<string, TaskScoringRow | undefined> = {};
    for (const row of this.scoring()) map[row.dimension] = row;
    return map;
  });

  protected readonly hasAnyScore = computed(() => this.scoring().length > 0);

  protected readonly summaryLine = computed(() => {
    const rows = this.scoring();
    if (rows.length === 0) return 'awaiting reviewer';
    const setBy = rows[0]?.set_by ?? 'agent';
    const ts = Math.max(...rows.map((r) => r.updated_at));
    const ago = secondsAgo(ts);
    return `set by ${setBy} · ${ago}`;
  });

  protected readonly options = computed<ApexOptions>(() => {
    const dark = this.darkMode();
    const ink = dark ? '#E8E6DF' : '#1A1A18';
    const inkMuted = dark ? '#9D9A93' : '#6E6E69';
    const rule = dark ? '#2C2E33' : '#D8D6CF';

    const data = AXES.map((a) => this.byKey()[a.key]?.score ?? 0);
    const labels = AXES.map((a) => a.label);

    return {
      chart: {
        type: 'radar',
        height: 260,
        toolbar: { show: false },
        animations: { enabled: false },
        background: 'transparent',
        foreColor: inkMuted,
        fontFamily: 'Inter, system-ui, sans-serif',
      },
      series: [{ name: 'Score', data }],
      labels,
      stroke: { width: 1.5, colors: [ink] },
      fill: { opacity: 0.18, colors: [ink] },
      markers: { size: 3, colors: [ink], strokeColors: ink, strokeWidth: 0 },
      yaxis: {
        min: 0,
        max: 10,
        tickAmount: 5,
        labels: { style: { fontSize: '10px', colors: inkMuted } },
      },
      xaxis: {
        labels: { style: { fontSize: '11px', colors: AXES.map(() => ink) } },
      },
      colors: [ink],
      legend: { show: false },
      tooltip: {
        theme: dark ? 'dark' : 'light',
        y: { formatter: (v: number) => `${v}/10` },
      },
      dataLabels: { enabled: false },
      plotOptions: {
        radar: {
          polygons: {
            strokeColors: rule,
            connectorColors: rule,
            fill: { colors: ['transparent', 'transparent'] },
          },
        },
      },
    };
  });
}

function secondsAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
