import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface ProviderUsageSeries {
  provider_id: string;
  /** [unixMs, usd] points, daily-bucketed. */
  data: Array<[number, number]>;
}

export interface ProviderTotal {
  provider_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CostSummary {
  range: { from: number; to: number };
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  series: ProviderUsageSeries[];
  by_provider: ProviderTotal[];
}

export type CostRange = 'today' | '7d' | '30d';

export interface ModelCostRow {
  provider_id: string;
  model_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
}

export interface TaskCostRow {
  task_id: string;
  task_title: string | null;
  task_status: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
  last_event_ts: number;
}

@Injectable({ providedIn: 'root' })
export class CostService {
  private http = inject(HttpClient);

  summary(range: CostRange = '7d'): Observable<CostSummary> {
    return this.http.get<CostSummary>(`/api/cost/summary?range=${range}`);
  }

  byModel(range: CostRange = '7d'): Observable<{ by_model: ModelCostRow[] }> {
    return this.http.get<{ by_model: ModelCostRow[] }>(`/api/cost/by-model?range=${range}`);
  }

  topTasks(range: CostRange = '7d', limit = 10): Observable<{ tasks: TaskCostRow[] }> {
    return this.http.get<{ tasks: TaskCostRow[] }>(
      `/api/cost/top-tasks?range=${range}&limit=${limit}`,
    );
  }
}
