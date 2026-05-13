import { describe, expect, test } from 'vitest';
import { parseSynthesisOutput, renderCommentBody, type SynthesisFinding } from './synthesis';

const SAMPLE = `Some preamble.

\`\`\`yaml
synthesis:
  ranked:
    - id: sec-001
      severity: high
      location: src/api/auth.ts:42-58
      title: "Token comparison is timing-unsafe"
      detail: "Direct === lets an attacker measure response timing."
      confidence: high
      confirmed_by: [security, performance]
    - id: perf-007
      severity: medium
      location: src/handler.ts:120
      title: "N+1 query in batch path"
      detail: "Each row fires a separate fetchUser call."
      confidence: medium
      confirmed_by: [performance]
      dissent: "Architecture says cache should hide this; performance disagrees on cold start."
      tags: [prompted-by-user]
  noise:
    - id: arch-022
      severity: low
      location: general
      title: "Module name is plural"
      detail: "Minor nit."
      confidence: low
      confirmed_by: [architecture]
  synthesizer_observations:
    - title: "License header missing"
      detail: "New files lack the SPDX header."
      reasoning: "Repo convention; no reviewer raised it."
\`\`\`

Trailing prose.`;

describe('parseSynthesisOutput', () => {
  test('extracts ranked + noise + observations from a fenced YAML block', () => {
    const out = parseSynthesisOutput(SAMPLE)!;
    expect(out).not.toBeNull();
    expect(out.ranked).toHaveLength(2);
    expect(out.noise).toHaveLength(1);
    expect(out.observations).toHaveLength(1);
  });

  test('preserves finding fields with normalization', () => {
    const out = parseSynthesisOutput(SAMPLE)!;
    const sec = out.ranked.find((f) => f.id === 'sec-001')!;
    expect(sec.severity).toBe('high');
    expect(sec.confidence).toBe('high');
    expect(sec.confirmed_by).toEqual(['security', 'performance']);
    expect(sec.bucket).toBe('ranked');
    expect(sec.dissent).toBeNull();
  });

  test('captures dissent + tags when present', () => {
    const out = parseSynthesisOutput(SAMPLE)!;
    const perf = out.ranked.find((f) => f.id === 'perf-007')!;
    expect(perf.dissent).toMatch(/architecture/i);
    expect(perf.tags).toEqual(['prompted-by-user']);
  });

  test('noise bucket is tagged correctly', () => {
    const out = parseSynthesisOutput(SAMPLE)!;
    expect(out.noise[0]!.bucket).toBe('noise');
  });

  test('null / empty / malformed input → null', () => {
    expect(parseSynthesisOutput(null)).toBeNull();
    expect(parseSynthesisOutput('')).toBeNull();
    expect(parseSynthesisOutput('not yaml at all')).toBeNull();
    expect(parseSynthesisOutput('```yaml\n: : :\n```')).toBeNull();
  });

  test('falls back to whole body when no fenced block', () => {
    const bare = `synthesis:
  ranked:
    - id: only-one
      severity: medium
      title: "fallback"
      detail: "no fence"
      confidence: medium
  noise: []
  synthesizer_observations: []`;
    const out = parseSynthesisOutput(bare)!;
    expect(out.ranked).toHaveLength(1);
    expect(out.ranked[0]!.id).toBe('only-one');
  });

  test('finding without an id gets a synthetic stable key', () => {
    const noId = `\`\`\`yaml
synthesis:
  ranked:
    - severity: medium
      title: "anon"
      detail: ""
      confidence: low
  noise: []
  synthesizer_observations: []
\`\`\``;
    const out = parseSynthesisOutput(noId)!;
    expect(out.ranked[0]!.id).toBe('ranked-0');
  });
});

describe('renderCommentBody', () => {
  const sample: SynthesisFinding[] = parseSynthesisOutput(SAMPLE)!.ranked;
  const observations = parseSynthesisOutput(SAMPLE)!.observations;

  test('null when nothing selected', () => {
    expect(renderCommentBody([], [], new Set())).toBeNull();
  });

  test('groups by severity, high first', () => {
    const out = renderCommentBody(sample, [], new Set())!;
    const highIdx = out.indexOf('### High');
    const medIdx = out.indexOf('### Medium');
    expect(highIdx).toBeGreaterThan(-1);
    expect(medIdx).toBeGreaterThan(highIdx);
  });

  test('omits unchecked findings entirely', () => {
    const onlyMed = sample.filter((f) => f.severity === 'medium');
    const out = renderCommentBody(onlyMed, [], new Set())!;
    expect(out).not.toContain('Timing-unsafe');
    expect(out).toContain('N+1 query');
    expect(out).not.toContain('### High');
  });

  test('includes confirmed_by + dissent when present', () => {
    const out = renderCommentBody(sample, [], new Set())!;
    expect(out).toContain('confirmed by: performance');
    expect(out).toMatch(/dissent.*architecture/i);
  });

  test('includes only checked observations', () => {
    const out = renderCommentBody([], observations, new Set([0]))!;
    expect(out).toContain('Synthesizer observations');
    expect(out).toContain('License header missing');
  });
});
