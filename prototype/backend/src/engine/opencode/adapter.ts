import type {
  EngineAdapter,
  EngineSession,
  ModelRef,
  OpenSessionSpec,
} from "../types";
import { startOpenCodeServer, type OpenCodeServerHandle, type OpenCodeServerOptions } from "./server";
import { EventBus } from "./eventBus";
import { createSession } from "./session";

export interface OpenCodeAdapterOptions extends OpenCodeServerOptions {
  /** Default model used when openSession() doesn't specify one. */
  defaultModel: ModelRef;
}

export class OpenCodeAdapter implements EngineAdapter {
  private constructor(
    private readonly server: OpenCodeServerHandle,
    private readonly bus: EventBus,
    private readonly defaultModel: ModelRef,
  ) {}

  static async start(opts: OpenCodeAdapterOptions): Promise<OpenCodeAdapter> {
    const server = await startOpenCodeServer(opts);
    const bus = new EventBus(server.client, {
      onError: (e) => console.error("[engine] event bus error:", e),
    });
    return new OpenCodeAdapter(server, bus, opts.defaultModel);
  }

  async openSession(spec: OpenSessionSpec): Promise<EngineSession> {
    return createSession(
      this.server.client,
      {
        title: spec.title,
        defaultSystem: "",
        defaultModel: spec.model ?? this.defaultModel,
      },
      this.bus,
    );
  }

  async health(): Promise<boolean> {
    try {
      const h = await this.server.client.health();
      return h.healthy === true;
    } catch {
      return false;
    }
  }

  /**
   * Backfill helper: fetch persisted messages for a session that may have
   * already idled. Used by GET /api/tasks/:id/transcript so the user can
   * see the tail of an agent's output even after the live stream is gone.
   */
  async getSessionMessages(sessionId: string, limit = 50): Promise<unknown[]> {
    return this.server.client.getJson<unknown[]>(
      `/session/${sessionId}/message?limit=${limit}`,
    );
  }

  async shutdown(): Promise<void> {
    await this.bus.shutdown();
    await this.server.shutdown();
  }
}
