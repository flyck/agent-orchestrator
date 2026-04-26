import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface StreamEvent {
  type: string;
  ts: number;
  sessionId: string | null;
  raw: unknown;
}

/**
 * EventSource-backed SSE wrapper around `/api/tasks/:id/events`.
 *
 * EventSource auto-reconnects on transient drops (~3s) which matches the
 * backend's reconnecting EventBus, so a network blip recovers without UI
 * effort. Caller unsubscribes by completing the returned Observable's
 * teardown function — the EventSource is closed there.
 */
@Injectable({ providedIn: 'root' })
export class TaskStreamService {
  open(taskId: string): Observable<StreamEvent> {
    return new Observable<StreamEvent>((sub) => {
      const es = new EventSource(`/api/tasks/${taskId}/events`);
      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          sub.next(ev);
        } catch {
          /* ignore malformed line — heartbeat comments etc. */
        }
      };
      es.onerror = () => {
        // EventSource flips between OPEN and CONNECTING on transient errors;
        // the browser will auto-reconnect. We surface only hard close
        // (readyState === CLOSED) as a stream completion.
        if (es.readyState === EventSource.CLOSED) sub.complete();
      };
      return () => es.close();
    });
  }
}
