import { parse as parseYaml } from 'yaml';

export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';
export type FindingConfidence = 'high' | 'medium' | 'low';

export interface SynthesisFinding {
  id: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  location: string;
  title: string;
  detail: string;
  confirmed_by: string[];
  dissent: string | null;
  tags: string[];
  /** "ranked" or "noise" — drives default-checked + visual grouping. */
  bucket: 'ranked' | 'noise';
}

export interface SynthesizerObservation {
  title: string;
  detail: string;
  reasoning: string;
}

export interface ParsedSynthesis {
  ranked: SynthesisFinding[];
  noise: SynthesisFinding[];
  observations: SynthesizerObservation[];
}

/**
 * Pull the synthesizer's structured YAML out of the phase_output's
 * markdown blob. The agent prompt enforces a fenced ```yaml block —
 * if it's missing, fall back to parsing the whole body so a stripped
 * reply still has a chance. Returns null on unrecoverable failure.
 */
export function parseSynthesisOutput(output_md: string | null | undefined): ParsedSynthesis | null {
  if (!output_md) return null;
  const yaml = extractYamlBlock(output_md) ?? output_md;
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const root = (raw as { synthesis?: unknown }).synthesis;
  if (!root || typeof root !== 'object') return null;
  const r = root as { ranked?: unknown; noise?: unknown; synthesizer_observations?: unknown };

  const ranked = toFindings(r.ranked, 'ranked');
  const noise = toFindings(r.noise, 'noise');
  const observations = toObservations(r.synthesizer_observations);
  return { ranked, noise, observations };
}

function extractYamlBlock(md: string): string | null {
  const m = md.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
  return m ? m[1]! : null;
}

function toFindings(raw: unknown, bucket: 'ranked' | 'noise'): SynthesisFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: SynthesisFinding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const rawId = o['id'];
    const id =
      typeof rawId === 'string' && rawId.length > 0
        ? rawId
        : `${bucket}-${i}`; // fall back so per-row keys stay stable when the agent forgot to emit one
    const confirmedBy = o['confirmed_by'];
    const tagsRaw = o['tags'];
    const dissent = o['dissent'];
    out.push({
      id,
      severity: normSeverity(o['severity']),
      confidence: normConfidence(o['confidence']),
      location: typeof o['location'] === 'string' ? (o['location'] as string) : '',
      title: typeof o['title'] === 'string' ? (o['title'] as string) : '(untitled)',
      detail: typeof o['detail'] === 'string' ? (o['detail'] as string) : '',
      confirmed_by: Array.isArray(confirmedBy)
        ? confirmedBy.filter((s): s is string => typeof s === 'string')
        : [],
      dissent: typeof dissent === 'string' && dissent.trim() ? dissent : null,
      tags: Array.isArray(tagsRaw)
        ? tagsRaw.filter((s): s is string => typeof s === 'string')
        : [],
      bucket,
    });
  }
  return out;
}

function toObservations(raw: unknown): SynthesizerObservation[] {
  if (!Array.isArray(raw)) return [];
  const out: SynthesizerObservation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    out.push({
      title: typeof o['title'] === 'string' ? (o['title'] as string) : '(untitled)',
      detail: typeof o['detail'] === 'string' ? (o['detail'] as string) : '',
      reasoning: typeof o['reasoning'] === 'string' ? (o['reasoning'] as string) : '',
    });
  }
  return out;
}

function normSeverity(v: unknown): FindingSeverity {
  return v === 'high' || v === 'medium' || v === 'low' || v === 'info' ? v : 'info';
}

function normConfidence(v: unknown): FindingConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

/**
 * Build a markdown PR comment from the findings the user kept checked.
 * Groups by severity, ordered high → info. Includes location + detail +
 * confirmed-by attribution. Returns null when the user has unchecked
 * everything — caller surfaces "select at least one".
 */
export function renderCommentBody(
  selected: SynthesisFinding[],
  observations: SynthesizerObservation[],
  selectedObservationIndices: Set<number>,
): string | null {
  const findings = [...selected];
  const obs = observations.filter((_, i) => selectedObservationIndices.has(i));
  if (findings.length === 0 && obs.length === 0) return null;

  const lines: string[] = ['## Review findings', ''];
  const order: FindingSeverity[] = ['high', 'medium', 'low', 'info'];
  for (const sev of order) {
    const inSev = findings.filter((f) => f.severity === sev);
    if (inSev.length === 0) continue;
    lines.push(`### ${sevLabel(sev)} (${inSev.length})`);
    lines.push('');
    for (const f of inSev) {
      const loc = f.location && f.location !== 'general' ? ` — \`${f.location}\`` : '';
      lines.push(`- **${f.title}**${loc} _(confidence: ${f.confidence})_`);
      if (f.detail) {
        for (const line of f.detail.trim().split('\n')) {
          lines.push(`  ${line}`);
        }
      }
      if (f.confirmed_by.length > 0) {
        lines.push(`  _confirmed by: ${f.confirmed_by.join(', ')}_`);
      }
      if (f.dissent) {
        lines.push(`  ⚠ _dissent: ${f.dissent}_`);
      }
      lines.push('');
    }
  }

  if (obs.length > 0) {
    lines.push('### Synthesizer observations');
    lines.push('');
    for (const o of obs) {
      lines.push(`- **${o.title}**`);
      if (o.detail) {
        for (const line of o.detail.trim().split('\n')) lines.push(`  ${line}`);
      }
      if (o.reasoning) lines.push(`  _reasoning: ${o.reasoning}_`);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

function sevLabel(s: FindingSeverity): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
