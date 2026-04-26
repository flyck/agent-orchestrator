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

  async shutdown(): Promise<void> {
    await this.bus.shutdown();
    await this.server.shutdown();
  }
}
