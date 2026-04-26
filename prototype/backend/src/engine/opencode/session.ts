import type {
  EngineEvent,
  EngineSession,
  ModelRef,
  SendMessageOptions,
} from "../types";
import type { OpenCodeClient } from "./client";
import type { EventBus } from "./eventBus";

interface CreateSessionResponse {
  id: string;
  // The opencode response includes more fields (title, parentID, etc.) — we
  // only consume `id` for now.
}

export interface OpenCodeSessionInternal {
  /** External (opencode) session id, prefixed `ses_`. */
  id: string;
  /** Default system prompt sent on each turn unless overridden in send(). */
  defaultSystem: string;
  /** Default model — required for OpenAI/Anthropic providers. */
  defaultModel: ModelRef;
}

/**
 * Wraps one opencode session. send() POSTs prompt_async; events come from
 * the shared EventBus, scoped by sessionID.
 */
export class OpenCodeSession implements EngineSession {
  private closed = false;
  private cachedEvents: AsyncIterable<EngineEvent> | null = null;

  constructor(
    private readonly internal: OpenCodeSessionInternal,
    private readonly client: OpenCodeClient,
    private readonly bus: EventBus,
  ) {}

  get id(): string {
    return this.internal.id;
  }

  get events(): AsyncIterable<EngineEvent> {
    if (!this.cachedEvents) {
      this.cachedEvents = this.bus.subscribe(this.internal.id);
    }
    return this.cachedEvents;
  }

  async send(text: string, opts: SendMessageOptions = {}): Promise<void> {
    if (this.closed) throw new Error("session is closed");
    const model = opts.model ?? this.internal.defaultModel;
    const body: Record<string, unknown> = {
      model: { providerID: model.providerID, modelID: model.modelID },
      parts: [{ type: "text", text }],
    };
    const system = opts.system ?? this.internal.defaultSystem;
    if (system) body.system = system;
    await this.client.postJson(`/session/${this.internal.id}/prompt_async`, body);
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    try {
      await this.client.postJson(`/session/${this.internal.id}/abort`, {});
    } catch {
      /* idempotent */
    }
  }

  /**
   * Respond to a `permission.asked` event. opencode accepts response values:
   *   - "once"    grant just this request
   *   - "always"  grant + remember for the session
   *   - "reject"  deny
   */
  async respondToPermission(
    permissionId: string,
    response: "once" | "always" | "reject" = "always",
  ): Promise<void> {
    if (this.closed) return;
    await this.client.postJson(
      `/session/${this.internal.id}/permissions/${permissionId}`,
      { response },
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.bus.unsubscribe(this.internal.id);
    try {
      await this.client.del(`/session/${this.internal.id}`);
    } catch {
      /* idempotent */
    }
  }
}

export async function createSession(
  client: OpenCodeClient,
  spec: { title?: string; defaultSystem: string; defaultModel: ModelRef },
  bus: EventBus,
): Promise<OpenCodeSession> {
  // Auto-allow all permissions for orchestrator-driven sessions. The user
  // already authorized this work by creating the task; opencode's per-tool
  // permission gates would otherwise block tool use silently. If we ever
  // want a stricter mode, this becomes an opt-in toggle in OpenSessionSpec.
  const created = (await client.postJson<CreateSessionResponse>("/session", {
    title: spec.title,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })) as CreateSessionResponse;
  // Subscribe to the bus before sending any messages so we don't miss the
  // first events.
  bus.subscribe(created.id);
  return new OpenCodeSession(
    {
      id: created.id,
      defaultSystem: spec.defaultSystem,
      defaultModel: spec.defaultModel,
    },
    client,
    bus,
  );
}
