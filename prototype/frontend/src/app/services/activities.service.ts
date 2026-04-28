import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type ActivityKind =
  | 'spec_create'
  | 'spec_edit'
  | 'review_sendback'
  | 'review_rate'
  | 'finalize'
  | 'task_run'
  | 'abandon';

export type ActivityActor = 'user' | 'agent';

export interface Activity {
  id: number;
  ts: number;
  kind: ActivityKind;
  actor: ActivityActor;
  task_id: string | null;
  detail: string | null;
  task_title: string | null;
  task_workspace: string | null;
}

@Injectable({ providedIn: 'root' })
export class ActivitiesService {
  private http = inject(HttpClient);

  list(limit = 100): Observable<{ activities: Activity[] }> {
    return this.http.get<{ activities: Activity[] }>(`/api/activities`, {
      params: { limit: String(limit) },
    });
  }
}
