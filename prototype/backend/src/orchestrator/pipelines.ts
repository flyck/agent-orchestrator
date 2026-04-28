/**
 * Pipeline configuration. Defines the phase list each task workspace
 * walks through. Two pipelines today; multi-phase runner that consumes
 * them lands in Phase 16 (see docs/17-pr-review-pipeline.md).
 *
 * Why a typed config instead of branches in runLifecycle:
 *   - Per-repo overrides ("this PR repo uses the gate-driven pipeline")
 *     become a single field swap rather than new code.
 *   - Adding a phase = adding a row, not editing the lifecycle.
 *   - The pipeline doc + the code stay in sync — the doc cites these
 *     phase IDs.
 *
 * The runner is intentionally not implemented here yet. Wiring it up
 * means rewriting runLifecycle in `index.ts` to walk phases instead of
 * its current hard-coded plan→code→review branches; that refactor is
 * the bulk of Phase 16.
 */

export type PhaseKind = "agent" | "parallel" | "gate";

export interface PhaseDef {
  /** Stable ID — task.current_state aligns to this for the agent and
   *  gate kinds. Parallel phases pick an aggregate ID (e.g. "review"). */
  id: string;
  /** UI label for pipeline columns. */
  label: string;
  kind: PhaseKind;
  /** Agent slug(s). One for `agent`, one or more for `parallel`,
   *  none for `gate`. */
  agents?: string[];
  /** Free-form key the runner uses to pick the right message+system
   *  prompt builder. Examples: "planner", "coder", "reviewer",
   *  "pr-intake", "pr-explorer", "pr-bug-finder", "synthesizer". */
  builder?: string;
  /** Human-friendly text shown when a `gate` phase is awaiting user
   *  decision. */
  prompt?: string;
}

export interface PipelineDef {
  id: string;
  label: string;
  phases: PhaseDef[];
}

/**
 * Local code-task pipeline. Mirrors the hard-coded lifecycle that
 * `runLifecycle` currently implements; defining it here is a no-op
 * until the runner switches to phase-driven walking.
 */
export const CODE_TASK_PIPELINE: PipelineDef = {
  id: "code-task",
  label: "Code task",
  phases: [
    { id: "spec",     label: "Spec",     kind: "gate", prompt: "Author the spec, then submit." },
    { id: "plan",     label: "Plan",     kind: "agent", agents: ["plan-coder"], builder: "planner" },
    { id: "code",     label: "Code",     kind: "agent", agents: ["coder"],      builder: "coder" },
    { id: "review",   label: "Review",   kind: "agent", agents: ["reviewer-coder"], builder: "reviewer" },
    { id: "ready",    label: "Ready",    kind: "gate",  prompt: "Inspect the diff. Commit, send back with feedback, or finish." },
    { id: "finalize", label: "Finalize", kind: "gate",  prompt: "Committed — close out the task." },
  ],
};

/**
 * Triage-first PR-review pipeline (Design B in docs/17). Triage tags
 * the depth, intake + map run in parallel, the depth-gated reviewer
 * panel runs in parallel, then synthesis.
 *
 * The runner has to honor depth tagging when expanding the
 * `parallel-reviewers` phase: at runtime it picks the subset of
 * agents based on the triage agent's `depth` output. Encoded here as
 * the full agent list; the runner filters by `depth`.
 */
export const PR_REVIEW_TRIAGE_PIPELINE: PipelineDef = {
  id: "pr-review-triage",
  label: "PR review (triage)",
  phases: [
    {
      id: "triage",
      label: "Triage",
      kind: "agent",
      agents: ["pr-triage"],
      builder: "pr-triage",
    },
    {
      id: "intake-and-map",
      label: "Intake + Map",
      kind: "parallel",
      agents: ["pr-spec-intake", "review-planner"],
      builder: "pr-intake",
    },
    {
      id: "review-panel",
      label: "Review",
      kind: "parallel",
      agents: [
        "reviewer-bug-finder",
        "reviewer-security",
        "reviewer-performance",
        "reviewer-architecture",
        "solution-explorer",
      ],
      builder: "pr-reviewer",
    },
    {
      id: "synthesis",
      label: "Synthesis",
      kind: "agent",
      agents: ["synthesizer"],
      builder: "synthesizer",
    },
    {
      id: "ready",
      label: "Ready",
      kind: "gate",
      prompt: "Read the synthesis. Copy as a PR comment, send back, or close.",
    },
  ],
};

/**
 * Gate-driven PR-review pipeline (Design A in docs/17). The
 * solution-explorer runs first as a standalone phase, gated by user
 * approval before deep reviewers fire. Heavier-weight; opt-in per
 * repo.
 */
export const PR_REVIEW_GATED_PIPELINE: PipelineDef = {
  id: "pr-review-gated",
  label: "PR review (gated)",
  phases: [
    {
      id: "intake",
      label: "Intake",
      kind: "agent",
      agents: ["pr-spec-intake"],
      builder: "pr-intake",
    },
    {
      id: "explore",
      label: "Explore",
      kind: "agent",
      agents: ["solution-explorer"],
      builder: "pr-explorer",
    },
    {
      id: "direction-gate",
      label: "Direction OK?",
      kind: "gate",
      prompt:
        "Read the explorer's verdict + alternatives. Approve to start the deep review, or send back with direction feedback.",
    },
    {
      id: "deep-review",
      label: "Deep Review",
      kind: "parallel",
      agents: [
        "reviewer-bug-finder",
        "reviewer-security",
        "reviewer-performance",
      ],
      builder: "pr-reviewer",
    },
    {
      id: "synthesis",
      label: "Synthesis",
      kind: "agent",
      agents: ["synthesizer"],
      builder: "synthesizer",
    },
    {
      id: "ready",
      label: "Ready",
      kind: "gate",
      prompt: "Read the synthesis. Copy as a PR comment, send back, or close.",
    },
  ],
};

const REGISTRY: Record<string, PipelineDef> = {
  [CODE_TASK_PIPELINE.id]: CODE_TASK_PIPELINE,
  [PR_REVIEW_TRIAGE_PIPELINE.id]: PR_REVIEW_TRIAGE_PIPELINE,
  [PR_REVIEW_GATED_PIPELINE.id]: PR_REVIEW_GATED_PIPELINE,
};

export function getPipeline(id: string): PipelineDef | undefined {
  return REGISTRY[id];
}

export function listPipelines(): PipelineDef[] {
  return Object.values(REGISTRY);
}
