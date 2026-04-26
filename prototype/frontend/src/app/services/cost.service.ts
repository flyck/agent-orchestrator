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

@Injectable({ providedIn: 'root' })
export class CostService {
  private http = inject(HttpClient);

  summary(range: 'today' | '7d' | '30d' = '7d'): Observable<CostSummary> {
    return this.http.get<CostSummary>(`/api/cost/summary?range=${range}`);
  }
}
