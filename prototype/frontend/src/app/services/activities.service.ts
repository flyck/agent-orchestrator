import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/** Mirrors the backend enum in db/activities.ts. */
export const ActivityKind = {
  SpecCreate: 'spec_create',
  SpecEdit: 'spec_edit',
  ReviewSendback: 'review_sendback',
  ReviewRate: 'review_rate',
  Finalize: 'finalize',
  TaskRun: 'task_run',
  Abandon: 'abandon',
} as const;
export type ActivityKind = (typeof ActivityKind)[keyof typeof ActivityKind];

export const ActivityActor = { User: 'user', Agent: 'agent' } as const;
export type ActivityActor = (typeof ActivityActor)[keyof typeof ActivityActor];

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
