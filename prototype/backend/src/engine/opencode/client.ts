/**
 * Tiny HTTP client for the opencode HTTP server. Adds Basic auth on every
 * request and decodes JSON. No retries — caller decides on retry policy.
 */

export interface OpenCodeClientConfig {
  baseUrl: string;          // e.g. "http://127.0.0.1:14096"
  username?: string;        // defaults to "opencode"
  password: string;
}

export class OpenCodeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`opencode ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = "OpenCodeHttpError";
  }
}

export class OpenCodeClient {
  private readonly authHeader: string;

  constructor(private readonly cfg: OpenCodeClientConfig) {
    const user = cfg.username ?? "opencode";
    this.authHeader = "Basic " + btoa(`${user}:${cfg.password}`);
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", this.authHeader);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const res = await fetch(`${this.cfg.baseUrl}${path}`, { ...init, headers });
    return res;
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new OpenCodeHttpError(res.status, await res.text(), path);
    return res.json() as Promise<T>;
  }

  async postJson<T = unknown>(path: string, body: unknown): Promise<T | null> {
    const res = await this.request(path, { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw new OpenCodeHttpError(res.status, await res.text(), path);
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  async del(path: string): Promise<void> {
    const res = await this.request(path, { method: "DELETE" });
    if (!res.ok) throw new OpenCodeHttpError(res.status, await res.text(), path);
  }

  /** Open the SSE event stream. Caller is responsible for reading the body. */
  async openEventStream(): Promise<Response> {
    const res = await this.request("/event", { headers: { accept: "text/event-stream" } });
    if (!res.ok) throw new OpenCodeHttpError(res.status, await res.text(), "/event");
    return res;
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    return this.getJson("/global/health");
  }
}
