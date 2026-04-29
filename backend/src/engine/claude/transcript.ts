/**
 * Read a Claude Code session transcript from disk and reshape it to the
 * OpenCode-style `{info, parts}` records the watchdog and
 * /api/tasks/:id/transcript expect.
 *
 * On-disk path: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 * The encoded-cwd is the absolute working directory with `/` replaced
 * by `-` (matches what `claude` writes — verified locally).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface JsonlLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: Record<string, number>;
    stop_reason?: string | null;
  };
  is_error?: boolean;
  total_cost_usd?: number;
}

export interface TranscriptMessage {
  info: {
    role?: string;
    finish?: string;
    error?: unknown;
    cost?: number;
    tokens?: { input?: number; output?: number };
    modelID?: string;
    providerID?: string;
  };
  parts: Array<{ type: string; text?: string }>;
}

/** All possible transcript locations for a session id, newest first. */
function findTranscriptPaths(sessionId: string): string[] {
  const root = join(homedir(), ".claude", "projects");
  let projects: string[] = [];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  const hits: Array<{ path: string; mtime: number }> = [];
  for (const p of projects) {
    const candidate = join(root, p, `${sessionId}.jsonl`);
    try {
      const st = statSync(candidate);
      if (st.isFile()) hits.push({ path: candidate, mtime: st.mtimeMs });
    } catch {
      /* not present in this project dir */
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits.map((h) => h.path);
}

export function readTranscript(sessionId: string, limit = 50): TranscriptMessage[] {
  const paths = findTranscriptPaths(sessionId);
  if (paths.length === 0) return [];
  const raw = readFileSync(paths[0]!, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out: TranscriptMessage[] = [];
  let pendingCost = 0;
  // Walk forward; each `assistant` line is one message. The matching
  // `result` line (if present) carries final cost/usage for the turn.
  // Pair them by order — Claude alternates assistant → result.
  for (const ln of lines) {
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(ln);
    } catch {
      continue;
    }
    if (parsed.type === "result") {
      pendingCost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0;
      // Backfill cost into the most recent assistant message.
      const last = out.at(-1);
      if (last && last.info.role === "assistant" && last.info.cost === 0) {
        last.info.cost = pendingCost;
        if (parsed.is_error) {
          last.info.finish = undefined;
          last.info.error = { message: "claude result reported error", data: parsed };
        }
      }
      continue;
    }
    if (parsed.type === "assistant" && parsed.message) {
      const u = parsed.message.usage ?? {};
      const inputTotal =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      out.push({
        info: {
          role: "assistant",
          finish: parsed.message.stop_reason ?? "stop",
          cost: 0, // filled in by the matching result line
          tokens: { input: inputTotal, output: u.output_tokens ?? 0 },
          modelID: parsed.message.model ?? "",
          providerID: "anthropic",
        },
        parts: (parsed.message.content ?? []).map((c) => ({
          type: c.type ?? "text",
          text: c.text,
        })),
      });
    } else if (parsed.type === "user" && parsed.message) {
      out.push({
        info: { role: "user" },
        parts: (Array.isArray(parsed.message.content)
          ? parsed.message.content
          : [{ type: "text", text: String(parsed.message.content ?? "") }]
        ).map((c) =>
          typeof c === "string"
            ? { type: "text", text: c }
            : { type: c.type ?? "text", text: c.text },
        ),
      });
    }
  }
  return out.slice(-limit);
}
