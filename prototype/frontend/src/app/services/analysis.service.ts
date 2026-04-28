import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type AggregationKind = 'avg' | 'p90' | 'p95' | 'min' | 'max';

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
