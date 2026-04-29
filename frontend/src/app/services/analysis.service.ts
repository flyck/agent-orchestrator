import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export const AggregationKind = {
  Avg: 'avg',
  P90: 'p90',
  P95: 'p95',
  Min: 'min',
  Max: 'max',
} as const;
export type AggregationKind = (typeof AggregationKind)[keyof typeof AggregationKind];

export interface AggregationBlock {
  sample_size: number;
  aggregations: Record<AggregationKind, number>;
}

export interface AnalysisResponse {
  tokens_per_task: AggregationBlock;
  sendbacks_per_task: AggregationBlock;
  daily_sendbacks: {
    range: { from: number; to: number };
    data: Array<[number, number]>;
  };
  tasks_completed: number;
}

@Injectable({ providedIn: 'root' })
export class AnalysisService {
  private http = inject(HttpClient);

  get(): Observable<AnalysisResponse> {
    return this.http.get<AnalysisResponse>('/api/analysis');
  }
}
