import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { AlternativeVerdict, TaskWorkspace } from './tasks.service';

export const ArchitectureDiagramKind = {
  Intake: 'intake',
  Alternative: 'alternative',
} as const;
export type ArchitectureDiagramKind =
  (typeof ArchitectureDiagramKind)[keyof typeof ArchitectureDiagramKind];

export interface ArchitectureDiagram {
  kind: ArchitectureDiagramKind;
  label: string;
  source: string;
  verdict?: AlternativeVerdict;
}

export interface ArchitectureTask {
  id: string;
  title: string;
  workspace: TaskWorkspace;
  repo_path: string | null;
  completed_at: number;
  state: string | null;
  diagrams: ArchitectureDiagram[];
}

export interface ArchitectureResponse {
  tasks: ArchitectureTask[];
}

@Injectable({ providedIn: 'root' })
export class ArchitectureService {
  private http = inject(HttpClient);

  list(): Observable<ArchitectureResponse> {
    return this.http.get<ArchitectureResponse>('/api/architecture/diagrams');
  }
}
