import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYAML } from "yaml";
import { upsertAgentBySlug } from "../db/agents";

const BUILTIN_ROOT = fileURLToPath(new URL("../../agents/builtin", import.meta.url));
const CUSTOM_ROOT = fileURLToPath(new URL("../../agents/custom", import.meta.url));

interface AgentFrontmatter {
  slug: string;
  name: string;
  icon: string;
  role: string;
  concurrency_class?: "foreground" | "background";
  enabled?: boolean;
  is_builtin?: boolean;
  model?: { providerID?: string; modelID?: string };
  cadence?: unknown;
  limits?: unknown;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

interface ParsedAgentFile {
  frontmatter: AgentFrontmatter;
  body: string;
  raw: string;
}

export function parseAgentFile(content: string): ParsedAgentFile {
  const m = content.match(FRONTMATTER_RE);
  if (!m) throw new Error("agent file missing frontmatter (--- ... ---)");
  const frontmatter = parseYAML(m[1]!) as AgentFrontmatter;
  if (!frontmatter || typeof frontmatter !== "object") {
    throw new Error("agent frontmatter did not parse to an object");
  }
  for (const key of ["slug", "name", "icon", "role"] as const) {
    if (!frontmatter[key] || typeof frontmatter[key] !== "string") {
      throw new Error(`agent frontmatter missing required '${key}'`);
    }
  }
  return { frontmatter, body: m[2]!, raw: content };
}

function* walkMarkdown(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // root doesn't exist — fine, custom/ may be missing on first run
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      yield* walkMarkdown(p);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      yield p;
    }
  }
}

export interface SyncReport {
  scanned: number;
  upserted: number;
  errors: Array<{ path: string; message: string }>;
}

function syncRoot(root: string, isBuiltinDefault: boolean): SyncReport {
  const report: SyncReport = { scanned: 0, upserted: 0, errors: [] };
  for (const path of walkMarkdown(root)) {
    report.scanned++;
    try {
      const raw = readFileSync(path, "utf8");
      const { frontmatter } = parseAgentFile(raw);
      const hash = createHash("sha256").update(raw).digest("hex");
      const cadence = frontmatter.cadence !== undefined ? JSON.stringify(frontmatter.cadence) : null;
      const limits = frontmatter.limits !== undefined ? JSON.stringify(frontmatter.limits) : null;
      upsertAgentBySlug({
        slug: frontmatter.slug,
        name: frontmatter.name,
        icon: frontmatter.icon,
        role: frontmatter.role,
        concurrency_class: frontmatter.concurrency_class ?? "foreground",
        file_path: path,
        prompt_hash: hash,
        model_provider_id: frontmatter.model?.providerID ?? null,
        model_id: frontmatter.model?.modelID ?? null,
        cadence_json: cadence,
        limits_json: limits,
        enabled: frontmatter.enabled ?? false,
        is_builtin: frontmatter.is_builtin ?? isBuiltinDefault,
      });
      report.upserted++;
    } catch (err) {
      report.errors.push({
        path: relative(process.cwd(), path),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

export function syncAgentsFromDisk(): SyncReport {
  const merged: SyncReport = { scanned: 0, upserted: 0, errors: [] };
  for (const [root, isBuiltin] of [[BUILTIN_ROOT, true], [CUSTOM_ROOT, false]] as const) {
    try {
      statSync(root);
    } catch {
      continue;
    }
    const r = syncRoot(root, isBuiltin);
    merged.scanned += r.scanned;
    merged.upserted += r.upserted;
    merged.errors.push(...r.errors);
  }
  return merged;
}
