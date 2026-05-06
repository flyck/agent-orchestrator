/**
 * Solution-explorer YAML parser. The explorer prompt asks for the same
 * scoring + alternatives YAML shape the reviewer uses; we share the
 * field-level parsers from reviewer.ts and add a thin wrapper that
 * extracts what we care about (scoring + alternatives).
 *
 * Fail-open like the reviewer: parse errors → no DB write, raw output
 * is still preserved in task_phase_outputs so the user can inspect it.
 */

import { parse as parseYaml } from "yaml";
import {
  parseReviewerAlternatives,
  parseReviewerScoring,
  type ReviewAlternative,
  type ReviewScoring,
} from "./reviewer";
import { log } from "../log";

export interface ExplorerOutput {
  scoring?: ReviewScoring;
  alternatives?: ReviewAlternative[];
  /** Top-level architecture diagram for the shipped implementation
   *  (per-alternative diagrams live on each alt). Reused by the
   *  Review tab's mermaid panel when no alt is selected. */
  diagramMermaid?: string;
  verdict?: "ship" | "rework" | "direction_unclear";
  summary?: string;
}

export function parseExplorerOutput(rawText: string): ExplorerOutput | null {
  const text = rawText.trim();
  if (!text) return null;

  // Pull out the first ```yaml ... ``` block; fall back to whole text.
  const fenceMatch = text.match(/```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i);
  const yamlBody = (fenceMatch?.[1] ?? text).trim();

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody);
  } catch (err) {
    log.warn("orchestrator.explorer.yaml_parse_failed", {
      error: String(err),
      head: yamlBody.slice(0, 200),
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const scoring = parseReviewerScoring(obj["scoring"]);
  // The explorer prompt also defines per-alternative diagram_mermaid;
  // the existing parseReviewerAlternatives ignores that field. Read it
  // here from the raw object to thread through.
  const altsBase = parseReviewerAlternatives(obj["alternatives"]);
  let alternatives: ReviewAlternative[] | undefined;
  if (altsBase !== undefined) {
    const rawAlts = Array.isArray(obj["alternatives"]) ? obj["alternatives"] : [];
    alternatives = altsBase.map((alt, i) => {
      const raw = rawAlts[i] as Record<string, unknown> | undefined;
      const dm = typeof raw?.["diagram_mermaid"] === "string" ? (raw["diagram_mermaid"] as string) : null;
      return {
        ...alt,
        // Tack the diagram on as an optional field; replaceForTask reads
        // it through the AlternativeInput shape (see db/alternatives.ts).
        ...(dm ? { diagram_mermaid: dm } : {}),
      } as ReviewAlternative & { diagram_mermaid?: string };
    });
  }

  const diagramMermaid =
    typeof obj["diagram_mermaid"] === "string" ? (obj["diagram_mermaid"] as string) : undefined;
  const verdictRaw = String(obj["verdict"] ?? "").toLowerCase().trim();
  const verdict =
    verdictRaw === "ship" || verdictRaw === "rework" || verdictRaw === "direction_unclear"
      ? (verdictRaw as ExplorerOutput["verdict"])
      : undefined;
  const summary = typeof obj["summary"] === "string" ? (obj["summary"] as string).trim() : undefined;

  return { scoring, alternatives, diagramMermaid, verdict, summary };
}
