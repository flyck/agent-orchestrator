import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface IntegrationStatus {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  enabled: boolean;
  last_synced_at: number | null;
  last_error: string | null;
}

export interface IntegrationsResponse {
  integrations: IntegrationStatus[];
  any_enabled: boolean;
}

@Injectable({ providedIn: 'root' })
export class IntegrationsService {
  private http = inject(HttpClient);

  list(): Observable<IntegrationsResponse> {
    return this.http.get<IntegrationsResponse>('/api/integrations');
  }
}
