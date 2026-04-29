/**
 * Locate the `claude` binary and probe its version. We pin against a
 * tested version range — Claude Code's stream-json schema is unversioned,
 * so a major-version bump can break the event normalizer.
 */

import { spawnSync } from "node:child_process";

export interface ClaudeBinaryInfo {
  bin: string;
  version: string;
}

const TESTED_MAJOR = 2;

export function probeClaudeBinary(bin = process.env.CLAUDE_BIN ?? "claude"): ClaudeBinaryInfo {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`claude --version failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
  // Output: "2.1.121 (Claude Code)" — take the first whitespace-delimited token.
  const version = (r.stdout || "").trim().split(/\s+/)[0] ?? "";
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major !== TESTED_MAJOR) {
    console.warn(
      `[engine/claude] version ${version} differs from tested major ${TESTED_MAJOR}; ` +
        `stream-json schema may have shifted`,
    );
  }
  return { bin, version };
}
