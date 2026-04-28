/**
 * Optional `data/user-settings.yaml` overlay. Loaded after seedDefaultSettings
 * — any key present in the file is upserted into the settings table on
 * every boot, so the YAML file is the source of truth for the keys it
 * specifies. Keys absent from the file keep whatever the user set via
 * the UI (or the seed default).
 *
 * Use this to keep machine-specific commands (IDE / emacs / magit) under
 * version-control-able config rather than burned into the SQLite db.
 * The file lives under `data/` which is gitignored, so it stays per-host.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { log } from "../log";

/**
 * Resolve the YAML path. Honors USER_SETTINGS_PATH env override, falls
 * back to `<cwd>/data/user-settings.yaml`. The cwd is the backend dir
 * during `bun run dev`, matching where SQLite lives.
 */
function resolvePath(): string {
  return (
    process.env.USER_SETTINGS_PATH ?? join(process.cwd(), "data", "user-settings.yaml")
  );
}

/**
 * If the YAML file exists, upsert every key into the settings table.
 * Values are serialized as strings (matching the rest of the schema).
 * Unknown keys are accepted — there's no schema check; the readers do
 * their own parsing. Missing/invalid YAML is logged but not fatal.
 */
export function loadUserSettingsOverlay(handle: Database): void {
  const path = resolvePath();
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log.warn("settings.user_yaml.read_failed", { path, error: String(err) });
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    log.warn("settings.user_yaml.parse_failed", { path, error: String(err) });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("settings.user_yaml.shape_invalid", {
      path,
      hint: "expected a top-level mapping",
    });
    return;
  }

  const upsert = handle.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  let count = 0;
  const tx = handle.transaction(() => {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      const value =
        typeof v === "boolean" ? (v ? "true" : "false") : String(v);
      upsert.run(k, value);
      count++;
    }
  });
  tx();
  log.info("settings.user_yaml.loaded", { path, applied: count });
}
