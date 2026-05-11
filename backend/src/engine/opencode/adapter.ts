import type {
  EngineAdapter,
  EngineSession,
  ModelRef,
  OpenSessionSpec,
} from "../types";
import { startOpenCodeServer, type OpenCodeServerHandle, type OpenCodeServerOptions } from "./server";
import { EventBus } from "./eventBus";
import { createSession } from "./session";
import { log } from "../../log";

export interface OpenCodeAdapterOptions extends OpenCodeServerOptions {
  /** Default model used when openSession() doesn't specify one. */
  defaultModel: ModelRef;
}

export class OpenCodeAdapter implements EngineAdapter {
  readonly engineId = "opencode" as const;

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

  /** Logged once per process when a budget is requested. opencode has no
   *  flag for this; we don't want to silently drop the setting. */
  private budgetWarned = false;

  async openSession(spec: OpenSessionSpec): Promise<EngineSession> {
    if (typeof spec.budgetUsd === "number" && spec.budgetUsd > 0 && !this.budgetWarned) {
      log.warn("opencode.openSession.budget_not_enforced", {
        requested: spec.budgetUsd,
        note: "opencode has no --max-budget-usd equivalent; setting is honored by the Claude engine only",
      });
      this.budgetWarned = true;
    }
    return createSession(
      this.server.client,
      {
        title: spec.title,
        defaultSystem: "",
        defaultModel: spec.model ?? this.defaultModel,
        cwd: spec.cwd,
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

  async getTranscript(sessionId: string, limit = 50): Promise<unknown[]> {
    return this.server.client.getJson<unknown[]>(
      `/session/${sessionId}/message?limit=${limit}`,
    );
  }

  async shutdown(): Promise<void> {
    await this.bus.shutdown();
    await this.server.shutdown();
  }
}
