import {
  Component,
  ElementRef,
  type WritableSignal,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { Subject, type Subscription, timer } from "rxjs";
import { takeUntil, catchError, switchMap } from "rxjs/operators";
import { of } from "rxjs";
import {
  TasksService,
  type ReviewFinding,
  type Task,
  type TaskAlternativeRow,
  type TaskPhaseOutputRow,
  type TaskPhaseSessionRow,
  type TaskReviewRow,
  type TaskScoringRow,
  type UsageEventRow,
} from "../services/tasks.service";
import {
  TaskStreamService,
  type StreamEvent,
} from "../services/task-stream.service";
import { RepoService, type DiffResponse } from "../services/repo.service";
import { SuggestionsService } from "../services/suggestions.service";
import {
  IssueLinksService,
  type TaskIssueLink,
} from "../services/issue-links.service";
import { ScoringRadar } from "./scoring-radar";
import { MermaidDiagram } from "./mermaid-diagram";
import { formatTs, relativeTs, clockTs } from "../util/time";

// ─── Stream / transcript types ────────────────────────────────────────

interface StreamLine {
  ts: number;
  tag: string;
  text: string;
  level: "info" | "tool" | "text" | "error" | "status" | "perm";
}

interface TranscriptLine {
  role: string;
  text: string;
  ts: number | null;
}

function formatStreamLine(ev: StreamEvent): StreamLine {
  const ts = ev.ts;
  const raw = ev.raw as { properties?: any };
  const props = raw?.properties ?? {};
  switch (ev.type) {
    case "message.part.updated": {
      const part = props.part;
      if (part?.type === "text" && typeof part.text === "string") {
        const text = part.text.trim();
        return { ts, tag: "text", text, level: "text" };
      }
      if (
        part?.type === "tool" ||
        part?.type === "tool-invocation" ||
        part?.type === "tool-result"
      ) {
        const name = part.tool ?? part.toolName ?? part.type;
        const id = part.id ? ` ${String(part.id).slice(0, 8)}` : "";
        return { ts, tag: "tool", text: `${name}${id}`, level: "tool" };
      }
      return { ts, tag: "part", text: part?.type ?? "?", level: "info" };
    }
    case "message.updated": {
      const info = props.info;
      if (info?.role === "assistant" && info?.finish) {
        const tokens = info.tokens ?? {};
        const cost =
          typeof info.cost === "number" ? `$${info.cost.toFixed(4)}` : "?";
        return {
          ts,
          tag: "asst-done",
          text: `finish=${info.finish} in=${tokens.input ?? 0} out=${tokens.output ?? 0} ${cost}`,
          level: "info",
        };
      }
      if (info?.error) {
        const msg =
          (info.error as { data?: { message?: string } })?.data?.message ??
          "error";
        return {
          ts,
          tag: "asst-error",
          text: String(msg).slice(0, 200),
          level: "error",
        };
      }
      return { ts, tag: "message", text: info?.role ?? "", level: "info" };
    }
    case "session.status":
      return { ts, tag: "status", text: props.status?.type ?? "", level: "status" };
    case "session.diff":
      return { ts, tag: "diff", text: "session emitted file diff", level: "info" };
    case "session.idle":
      return { ts, tag: "idle", text: "session idle", level: "status" };
    case "session.error":
      return { ts, tag: "error", text: "session error", level: "error" };
    case "permission.asked": {
      const perm = props.permission ?? props.tool?.toolName ?? "?";
      return { ts, tag: "perm", text: `${perm} (auto-granted)`, level: "perm" };
    }
    case "subscribed":
      return { ts, tag: "sse", text: "subscribed", level: "status" };
    default:
      return { ts, tag: ev.type, text: "", level: "info" };
  }
}

function parseFindings(rv: TaskReviewRow): ReviewFinding[] {
  if (!rv.findings_json) return [];
  try {
    const parsed = JSON.parse(rv.findings_json);
    return Array.isArray(parsed) ? (parsed as ReviewFinding[]) : [];
  } catch {
    return [];
  }
}

function extractMermaid(text: string): string | null {
  const match = text.match(
    /(?:^|\n)[ \t]*diagram_mermaid:[ \t]*\|[ \t]*\n([\s\S]*?)(?=\n[A-Za-z_][A-Za-z0-9_-]*:|$)/,
  );
  if (!match) return null;
  const block = match[1] ?? "";
  const lines = block.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const indents = lines.map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0);
  const minIndent = Math.min(...indents);
  return block
    .split("\n")
    .map((l) => l.slice(minIndent))
    .join("\n")
    .trim();
}

@Component({
  selector: "app-task-detail-panel",
  standalone: true,
  imports: [ScoringRadar, MermaidDiagram],
  templateUrl: "./task-detail-panel.html",
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }
      .detail {
        background: var(--paper);
        border: 1px solid var(--rule-strong);
        padding: 20px 22px;
        margin-top: 0;
      }
      .detail.attention {
        background: var(--ink-amber-bg);
        border-color: var(--ink-amber);
      }
      .detail-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        margin-bottom: 12px;
      }
      .detail-head h2 { margin: 4px 0 0; }
      .detail-close-btn {
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: transparent;
        border: 1px solid var(--rule-strong);
        color: var(--ink-muted);
        padding: 4px 12px;
        cursor: pointer;
        border-radius: 2px;
      }
      .detail-close-btn:hover {
        color: var(--ink);
        border-color: var(--ink);
      }
      .attention-block {
        background: var(--ink-amber-bg);
        border: 1px solid var(--ink-amber);
        padding: 12px 14px;
        margin: 0 0 14px;
      }
      .attention-question {
        font-family: var(--font-serif);
        font-size: 16px;
        line-height: 1.4;
        margin: 4px 0 8px;
        color: var(--ink);
      }
      .small { font-size: 13px; }
      .muted { color: var(--ink-muted); }
      .gate-block {
        background: var(--paper-soft);
        border-left: 3px solid var(--ink);
        padding: 12px 14px;
        margin: 0 0 14px;
      }
      .gate-question {
        font-family: var(--font-serif);
        font-size: 16px;
        line-height: 1.4;
        margin: 4px 0 10px;
        color: var(--ink);
      }
      .detail-tabs {
        display: flex;
        gap: 0;
        border-bottom: 1px solid var(--rule);
        margin: 8px 0 16px;
      }
      .detail-tab {
        background: transparent;
        border: 0;
        border-bottom: 1px solid transparent;
        margin-bottom: -1px;
        padding: 8px 14px;
        font-size: 13px;
        color: var(--ink-muted);
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        border-radius: 0;
      }
      .detail-tab:hover { color: var(--ink); background: transparent; }
      .detail-tab.active {
        color: var(--ink);
        border-bottom-color: var(--ink);
      }
      .detail-tab .meta { background: var(--paper-soft); padding: 1px 6px; }
      .detail-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0 0 14px;
        font-size: 13px;
      }
      .detail-meta code {
        background: var(--paper-soft);
        padding: 2px 6px;
        border-radius: 2px;
      }
      .time-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 4px 24px;
        margin: 0 0 14px;
        padding: 0;
      }
      .time-meta > div { display: contents; }
      .time-meta dt {
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--ink-muted);
      }
      .time-meta dd {
        margin: 0;
        font-family: var(--font-mono);
        font-size: 12px;
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .time-meta .rel { font-family: var(--font-sans); }
      .issue-links-section {
        margin: 16px 0;
        padding: 12px 14px;
        border: 1px dashed var(--rule);
        border-radius: 2px;
      }
      .issue-links-head { margin-bottom: 8px; }
      .issue-links-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .issue-link-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .issue-chip {
        display: inline-block;
        font-size: 11px;
        padding: 1px 6px;
        border: 1px solid var(--rule);
        border-radius: 999px;
        color: var(--ink);
        text-decoration: none;
        background: var(--paper-soft);
      }
      .issue-chip:hover { border-color: var(--ink); }
      .issue-link-title {
        flex: 1;
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .spec-section {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px dashed var(--rule);
      }
      .spec-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 8px;
      }
      .spec-head-spacer { flex: 1; }
      .spec-body {
        background: var(--paper-soft);
        border: 1px solid var(--rule);
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.55;
        margin: 0;
        max-height: 240px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .diagram-section {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px dashed var(--rule);
      }
      .diagram-head { margin-bottom: 8px; }
      .diagram-head .meta { margin: 0; }
      .notes-section { margin-top: 8px; }
      .notes-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 6px;
      }
      .notes-head .meta { margin: 0; }
      .notes-path { font-size: 11px; color: var(--ink-muted); }
      .notes-handoff {
        margin: 0 0 10px;
        max-width: 720px;
      }
      .transcript {
        display: flex;
        flex-direction: column;
        gap: 10px;
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 10px 12px;
        max-height: 360px;
        overflow: auto;
      }
      .transcript-line {
        border-bottom: 1px dashed var(--rule);
        padding-bottom: 8px;
      }
      .transcript-line:last-child { border-bottom: 0; padding-bottom: 0; }
      .transcript-line[data-role='user'] .transcript-head { color: var(--ink); }
      .transcript-line[data-role='assistant'] .transcript-head { color: var(--ink-muted); }
      .transcript-head { margin-bottom: 4px; }
      .transcript-text {
        margin: 0;
        font-family: var(--font-mono);
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.55;
      }
      .stream-section {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px dashed var(--rule);
      }
      .stream-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .stream-head h3 {
        margin: 0 8px 0 0;
        font-family: var(--font-serif);
        font-size: 16px;
      }
      .transcript-head-row {
        display: flex;
        align-items: baseline;
        gap: 12px;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .transcript-head-row p { margin: 0; }
      .meta-action {
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: transparent;
        border: 1px solid var(--rule-strong);
        color: var(--ink-muted);
        padding: 2px 8px;
        cursor: pointer;
      }
      .meta-action:hover { color: var(--ink); border-color: var(--ink); }
      .meta-action:disabled { opacity: 0.4; cursor: default; }
      .shell {
        background: #181816;
        color: #ECEAE2;
        font-family: var(--font-mono);
        font-size: 12.5px;
        line-height: 1.55;
        padding: 12px 14px;
        border-radius: 2px;
        max-height: 360px;
        overflow: auto;
        border: 1px solid var(--rule-strong);
      }
      .shell-line { white-space: pre-wrap; word-break: break-word; }
      .shell-line.muted { color: #8E8C84; }
      .shell-time { color: #6E6C66; margin-right: 8px; }
      .shell-tag { color: #8E8C84; margin-right: 8px; }
      .shell-line[data-level='text']   .shell-tag { color: #B8E0B8; }
      .shell-line[data-level='tool']   .shell-tag { color: #D9C68A; }
      .shell-line[data-level='error']  .shell-tag { color: #E08484; }
      .shell-line[data-level='perm']   .shell-tag { color: #D9C68A; }
      .shell-line[data-level='status'] .shell-tag { color: #9DA9C2; }
      .shell-line[data-level='error']  .shell-text { color: #F0CCCC; }
      .solution-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin: 12px 0 8px;
        border-bottom: 1px solid var(--rule);
      }
      .solution-tab {
        background: transparent;
        border: 0;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        padding: 6px 12px;
        font-size: 13px;
        color: var(--ink-muted);
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        border-radius: 0;
      }
      .solution-tab:hover { color: var(--ink); background: transparent; }
      .solution-tab.active {
        color: var(--ink);
        border-bottom-color: var(--ink);
      }
      .verdict-pill {
        font-size: 10.5px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-family: var(--font-mono);
        padding: 1px 6px;
        border: 1px solid var(--rule-strong);
        border-radius: 8px;
        line-height: 14px;
      }
      .verdict-pill[data-verdict='better'] { color: #4F7048; border-color: #4F7048; }
      .verdict-pill[data-verdict='worse'] { color: var(--ink-red); border-color: var(--ink-red); }
      .verdict-pill[data-verdict='equal'] { color: var(--ink-muted); }
      .alt-section { margin: 12px 0; }
      .alt-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 6px;
      }
      .alt-head h3 { margin: 0; font-family: var(--font-serif); font-size: 16px; }
      .alt-description {
        font-family: var(--font-serif);
        font-size: 14px;
        line-height: 1.5;
        margin: 4px 0 8px;
      }
      .alt-rationale { margin: 0 0 8px; font-style: italic; }
      .alt-diagram { margin-top: 12px; }
      .alt-diagram .meta { margin: 0 0 6px; }
      .review-section {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px dashed var(--rule);
      }
      .review-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 10px;
      }
      .review-head h3 { margin: 0; font-family: var(--font-serif); font-size: 16px; }
      .reviews {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .review-item {
        border: 1px solid var(--rule);
        background: var(--paper);
        padding: 10px 14px;
      }
      .review-item[data-decision='send_back'] { border-left: 3px solid var(--ink-amber); }
      .review-item[data-decision='accept'] { border-left: 3px solid var(--state-plan-edge); }
      .review-item-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
        margin-bottom: 6px;
      }
      .review-decision {
        font-size: 11.5px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-family: var(--font-mono);
      }
      .review-decision.accept { color: var(--ink); }
      .review-decision.send-back { color: var(--ink-amber); }
      .confidence-pill {
        font-size: 10.5px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-family: var(--font-mono);
        padding: 1px 6px;
        border: 1px solid var(--rule-strong);
        border-radius: 8px;
        line-height: 14px;
        color: var(--ink-muted);
      }
      .confidence-pill[data-confidence='high'] { color: var(--ink); border-color: var(--ink); }
      .confidence-pill[data-confidence='medium'] { color: var(--ink-muted); }
      .confidence-pill[data-confidence='low'] { color: var(--ink-faint); border-style: dashed; }
      .findings {
        list-style: none;
        padding: 0;
        margin: 8px 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .finding {
        border-left: 3px solid var(--rule-strong);
        padding: 6px 10px;
        background: var(--paper-soft);
      }
      .finding[data-severity='high'] { border-left-color: var(--ink-red); }
      .finding[data-severity='medium'] { border-left-color: var(--ink-amber); }
      .finding[data-severity='low'] { border-left-color: var(--ink-muted); }
      .finding[data-severity='info'] { border-left-color: var(--rule-strong); }
      .finding-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .finding-severity {
        font-size: 10.5px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        font-family: var(--font-mono);
        color: var(--ink-muted);
      }
      .finding-title { flex: 1; font-size: 13.5px; }
      .finding-loc { font-size: 11.5px; color: var(--ink-muted); margin: 4px 0 0; }
      .finding-detail { font-size: 13px; margin: 4px 0 0; white-space: pre-wrap; }
      .review-notes {
        margin: 4px 0 6px;
        font-family: var(--font-serif);
        font-size: 14px;
        line-height: 1.5;
        color: var(--ink);
        white-space: pre-wrap;
      }
      .review-raw {
        margin-top: 4px;
      }
      .review-raw summary { cursor: pointer; user-select: none; padding: 2px 0; }
      .review-raw pre {
        margin: 4px 0 0;
        background: var(--paper-soft);
        border: 1px solid var(--rule);
        padding: 8px 10px;
        font-size: 11.5px;
        line-height: 1.5;
        max-height: 320px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .tokens-section { margin: 8px 0 4px; display: flex; flex-direction: column; gap: 10px; }
      .tokens-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
      }
      .tokens-head h3 { margin: 0; font-family: var(--font-serif); font-size: 16px; }
      .tokens-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .tokens-table th, .tokens-table td {
        padding: 6px 10px;
        border-bottom: 1px solid var(--rule);
        text-align: left;
      }
      .tokens-table th { color: var(--ink-muted); font-weight: 500; font-size: 11px; letter-spacing: 0.04em; text-transform: lowercase; }
      .tokens-table td.num, .tokens-table th.num { text-align: right; }
      .tokens-table tfoot td { border-bottom: none; border-top: 1px solid var(--rule-strong); padding-top: 8px; }
      .diff-section {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px dashed var(--rule);
      }
      .diff-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 10px;
      }
      .diff-head h3 { margin: 0; font-family: var(--font-serif); font-size: 16px; }
      .diff-spacer { flex: 1; }
      .diff-toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .diff-files {
        list-style: none;
        padding: 0;
        margin: 0 0 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        border: 1px solid var(--rule);
        background: var(--paper);
      }
      .diff-files li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 12px;
        padding: 6px 12px;
        align-items: baseline;
        border-bottom: 1px solid var(--rule);
      }
      .diff-files li:last-child { border-bottom: 0; }
      .diff-status { font-family: var(--font-mono); font-size: 11px; min-width: 24px; }
      .diff-path { font-family: var(--font-mono); font-size: 12px; }
      .diff-counts { font-family: var(--font-mono); font-size: 11px; }
      .diff-patch {
        background: var(--paper-soft);
        border: 1px solid var(--rule);
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.45;
        margin: 0;
        max-height: 500px;
        overflow: auto;
        white-space: pre;
      }
      .diff-patch code { display: block; }
      .diff-error { color: var(--ink-red); font-size: 13px; margin-top: 4px; }
      .loading { color: var(--ink-muted); font-size: 14px; padding: 20px; text-align: center; }
      .error-banner {
        color: var(--ink-red);
        border: 1px solid var(--ink-red);
        padding: 12px 14px;
        margin: 0 0 14px;
      }
      .mono { font-family: var(--font-mono); }
      .detail-head .rating-bad {
        color: var(--ink-red);
        font-weight: 500;
      }
    `,
  ],
})
export class TaskDetailPanelComponent {
  private tasksApi = inject(TasksService);
  private streamApi = inject(TaskStreamService);
  private repoApi = inject(RepoService);
  private suggestionsApi = inject(SuggestionsService);
  private issueLinksApi = inject(IssueLinksService);

  readonly taskId = input<string | null>(null);
  readonly close = output<void>();
  readonly taskChanged = output<void>();

  protected readonly formatTs = formatTs;
  protected readonly relativeTs = relativeTs;
  protected readonly clockTs = clockTs;

  protected readonly task = signal<Task | null>(null);
  protected readonly taskLoading = signal(false);
  protected readonly taskError = signal<string | null>(null);

  protected readonly terminalStatuses = new Set(["done", "failed", "canceled"]);

  protected readonly phaseSessions = signal<TaskPhaseSessionRow[]>([]);
  protected readonly detailTab = signal<string>("live");

  protected readonly detailTabs = computed<
    Array<{ id: string; label: string; badge?: string }>
  >(() => {
    const sessions = this.phaseSessions();
    const counts = new Map<string, number>();
    const total = new Map<string, number>();
    for (const s of sessions) total.set(s.agent_slug, (total.get(s.agent_slug) ?? 0) + 1);
    const tabs: Array<{ id: string; label: string; badge?: string }> = [
      { id: "spec", label: "Spec" },
    ];
    for (const s of sessions) {
      const n = (counts.get(s.agent_slug) ?? 0) + 1;
      counts.set(s.agent_slug, n);
      const baseLabel = this.agentLabel[s.agent_slug] ?? s.agent_slug;
      const label = (total.get(s.agent_slug) ?? 1) > 1 ? `${baseLabel} #${n}` : baseLabel;
      tabs.push({
        id: `session:${s.session_id}`,
        label,
        badge: s.ended_at === null ? "live" : undefined,
      });
    }
    tabs.push({ id: "live", label: "Live" });
    tabs.push({ id: "review", label: "Review" });
    tabs.push({ id: "tokens", label: "Tokens" });
    tabs.push({ id: "files", label: "Files" });
    return tabs;
  });

  protected readonly selectedPhaseSession = computed<TaskPhaseSessionRow | null>(() => {
    const id = this.detailTab();
    if (!id.startsWith("session:")) return null;
    const sid = id.slice("session:".length);
    return this.phaseSessions().find((s) => s.session_id === sid) ?? null;
  });

  private agentLabel: Record<string, string> = {
    "plan-coder": "Planner",
    coder: "Coder",
    "reviewer-coder": "Reviewer",
    "review-planner": "Review Planner",
    "pr-spec-intake": "PR Intake",
    "solution-explorer": "Explorer",
    "review-security": "Security",
    "review-performance": "Performance",
    "review-architecture": "Architecture",
    "review-synthesizer": "Synthesizer",
    "pr-triage": "Triage",
  };

  setDetailTab(tab: string) {
    this.detailTab.set(tab);
    if (tab.startsWith("session:")) {
      this.loadSessionTranscript(tab.slice("session:".length));
    }
  }

  // ─── Per-session transcript cache ────────────────────────────────────
  protected readonly sessionTranscripts = signal<Map<string, TranscriptLine[]>>(new Map());
  protected readonly sessionTranscriptLoading = signal<Set<string>>(new Set());

  loadSessionTranscript(sessionId: string) {
    const tid = this.taskId();
    if (!tid) return;
    if (this.sessionTranscripts().has(sessionId)) return;
    const loading = new Set(this.sessionTranscriptLoading());
    loading.add(sessionId);
    this.sessionTranscriptLoading.set(loading);
    this.tasksApi.transcript(tid, sessionId).subscribe({
      next: (r) => {
        const lines: TranscriptLine[] = [];
        for (const m of (r.messages ?? []) as Array<{
          info?: { role?: string; time?: { created?: number } };
          parts?: Array<{ type?: string; text?: string }>;
        }>) {
          const role = m.info?.role ?? "unknown";
          const text = (m.parts ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("")
            .trim();
          if (!text) continue;
          lines.push({ role, text, ts: m.info?.time?.created ?? null });
        }
        const next = new Map(this.sessionTranscripts());
        next.set(sessionId, lines);
        this.sessionTranscripts.set(next);
        const stillLoading = new Set(this.sessionTranscriptLoading());
        stillLoading.delete(sessionId);
        this.sessionTranscriptLoading.set(stillLoading);
      },
      error: () => {
        const next = new Map(this.sessionTranscripts());
        next.set(sessionId, []);
        this.sessionTranscripts.set(next);
        const stillLoading = new Set(this.sessionTranscriptLoading());
        stillLoading.delete(sessionId);
        this.sessionTranscriptLoading.set(stillLoading);
      },
    });
  }

  // ─── Live stream ──────────────────────────────────────────────────────
  protected readonly streamEvents = signal<StreamEvent[]>([]);
  protected readonly streamConnected = signal(false);
  protected readonly streamStatus = signal<
    | { state: "connecting" }
    | { state: "attached" }
    | { state: "unavailable"; reason: string }
    | { state: "disconnected" }
  >({ state: "disconnected" });

  protected readonly transcriptTail = signal<TranscriptLine[]>([]);
  protected readonly transcriptLoading = signal(false);

  private partTexts = new Map<string, string>();
  private streamSub: Subscription | null = null;
  private static readonly STREAM_BUFFER_LIMIT = 250;

  protected readonly streamLines = computed(() =>
    this.streamEvents().map((ev) => formatStreamLine(ev)),
  );

  private openStream(taskId: string) {
    this.closeStream();
    this.streamEvents.set([]);
    this.partTexts.clear();
    this.streamConnected.set(false);
    this.streamStatus.set({ state: "connecting" });
    this.streamSub = this.streamApi.open(taskId).subscribe({
      next: (ev) => {
        if (ev.type === "subscribed") return;
        if (ev.type === "stream.attached") {
          this.streamConnected.set(true);
          this.streamStatus.set({ state: "attached" });
          return;
        }
        if (ev.type === "stream.unavailable") {
          const reason = String(
            (ev as unknown as { reason?: string }).reason ?? "not_running",
          );
          this.streamConnected.set(false);
          this.streamStatus.set({ state: "unavailable", reason });
          return;
        }
        this.streamConnected.set(true);
        if (this.streamStatus().state !== "attached") {
          this.streamStatus.set({ state: "attached" });
        }
        this.streamEvents.update((arr) => {
          const next =
            arr.length >= TaskDetailPanelComponent.STREAM_BUFFER_LIMIT
              ? arr.slice(1)
              : arr.slice();
          next.push(ev);
          return next;
        });
      },
      complete: () => {
        this.streamConnected.set(false);
        if (this.streamStatus().state !== "unavailable") {
          this.streamStatus.set({ state: "disconnected" });
        }
      },
      error: () => {
        this.streamConnected.set(false);
        if (this.streamStatus().state !== "unavailable") {
          this.streamStatus.set({ state: "disconnected" });
        }
      },
    });
  }

  private closeStream() {
    this.streamSub?.unsubscribe();
    this.streamSub = null;
    this.streamConnected.set(false);
    this.streamStatus.set({ state: "disconnected" });
  }

  refreshTranscript(taskId: string) {
    this.transcriptLoading.set(true);
    this.tasksApi.transcript(taskId).subscribe({
      next: (r) => {
        const lines: TranscriptLine[] = [];
        for (const m of (r.messages ?? []) as Array<{
          info?: { role?: string; time?: { created?: number } };
          parts?: Array<{ type?: string; text?: string }>;
        }>) {
          const role = m.info?.role ?? "unknown";
          const text = (m.parts ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("")
            .trim();
          if (!text) continue;
          lines.push({ role, text, ts: m.info?.time?.created ?? null });
        }
        this.transcriptTail.set(lines.slice(-6));
        this.transcriptLoading.set(false);
      },
      error: () => {
        this.transcriptTail.set([]);
        this.transcriptLoading.set(false);
      },
    });
  }

  protected streamReasonLabel(s: { state: string; reason?: string }): string {
    if (s.state !== "unavailable") return "disconnected";
    switch (s.reason) {
      case "awaiting_gate":
        return "paused — awaiting your gate decision";
      case "awaiting_feedback":
        return "paused — awaiting your feedback";
      case "closed":
        return "task is closed — showing transcript";
      case "attach_timeout":
        return "engine did not pick this up — retry the run";
      case "not_running":
        return "not running";
      case "not_found":
        return "task not found";
      default:
        return `unavailable (${s.reason ?? "unknown"})`;
    }
  }

  protected transcriptHeaderNote(
    s: { state: string; reason?: string },
    count: number,
    sessionId: string | null | undefined,
  ): string {
    const sid = sessionId ? sessionId.slice(0, 12) + "…" : "none";
    if (s.state === "unavailable")
      return `${this.streamReasonLabel(s)} · last ${count} message(s) for session ${sid}`;
    if (s.state === "connecting")
      return `connecting… · last ${count} message(s) persisted for session ${sid}`;
    return `last ${count} message(s) for session ${sid}`;
  }

  // ─── Scoring / reviews / alternatives ─────────────────────────────────
  protected readonly scoring = signal<TaskScoringRow[]>([]);
  protected readonly reviews = signal<TaskReviewRow[]>([]);
  protected readonly alternatives = signal<TaskAlternativeRow[]>([]);
  protected readonly altTabIndex = signal<number>(-1);
  protected readonly scoringVisible = computed(() => this.scoring().length > 0);

  setAltTab(idx: number) {
    this.altTabIndex.set(idx);
  }

  protected parseFindings(rv: TaskReviewRow): ReviewFinding[] {
    return parseFindings(rv);
  }

  protected scoringForAlt(alt: TaskAlternativeRow): TaskScoringRow[] {
    let scores: Record<string, number> = {};
    let rationales: Record<string, string> = {};
    try {
      scores = JSON.parse(alt.scores_json) ?? {};
    } catch {
      scores = {};
    }
    try {
      rationales = alt.rationales_json ? JSON.parse(alt.rationales_json) : {};
    } catch {}
    return Object.entries(scores).map(([dimension, score]) => ({
      task_id: alt.task_id,
      dimension,
      score,
      rationale: rationales[dimension] ?? null,
      set_by: alt.set_by,
      updated_at: alt.created_at,
    }));
  }

  // ─── Phase outputs / intake diagram ───────────────────────────────────
  protected readonly phaseOutputs = signal<TaskPhaseOutputRow[]>([]);
  protected readonly intakeDiagram = computed<string | null>(() => {
    const intake = this.phaseOutputs().find((p) => p.phase_id === "intake");
    if (!intake) return null;
    return extractMermaid(intake.output_md);
  });

  // ─── Usage events (Tokens tab) ────────────────────────────────────────
  protected readonly usageEvents = signal<UsageEventRow[]>([]);
  protected readonly tokensTotalIn = computed(() =>
    this.usageEvents().reduce((acc, e) => acc + (e.input_tokens || 0), 0),
  );
  protected readonly tokensTotalOut = computed(() =>
    this.usageEvents().reduce((acc, e) => acc + (e.output_tokens || 0), 0),
  );
  protected readonly tokensTotalCost = computed(() =>
    this.usageEvents().reduce((acc, e) => acc + (e.cost_usd || 0), 0),
  );

  // ─── Diff ─────────────────────────────────────────────────────────────
  protected readonly diff = signal<DiffResponse | null>(null);
  protected readonly diffLoading = signal(false);
  protected readonly diffError = signal<string | null>(null);
  protected readonly showPatch = signal(false);

  togglePatch() {
    this.showPatch.update((v) => !v);
  }

  // ─── Suggestions (read-only display) ──────────────────────────────────
  protected readonly suggestions = signal<
    import("../services/suggestions.service").Suggestion[]
  >([]);

  // ─── Issue links (read-only display) ──────────────────────────────────
  protected readonly issueLinks = signal<TaskIssueLink[]>([]);

  // ─── Dark mode for mermaid ───────────────────────────────────────────
  protected readonly darkMode = signal(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true,
  );

  private destroy$ = new Subject<void>();

  // ─── Scroll container ──────────────────────────────────────────────────
  private readonly scrollContainer =
    viewChild<ElementRef<HTMLElement>>("scrollContainer");
  private autoScrollPinned = true;

  protected onStreamScroll(ev: Event): void {
    const el = ev.target as HTMLElement;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.autoScrollPinned = distanceFromBottom < 24;
  }

  constructor() {
    effect(() => {
      this.streamLines();
      this.transcriptTail();
      if (!this.autoScrollPinned) return;
      queueMicrotask(() => {
        const el = this.scrollContainer()?.nativeElement;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      });
    });

    effect(() => {
      const id = this.taskId();
      if (!id) {
        this.resetAll();
        return;
      }
      this.loadAll(id);
    });

    // Poll sub-resources every 5s while a task is selected — picks up
    // new scoring, reviews, usage events, and phase outputs as the
    // agents produce them.
    timer(0, 5000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => {
          const id = this.taskId();
          if (!id) return of(null);
          return of(id);
        }),
      )
      .subscribe((id) => {
        if (!id) return;
        this.refreshScoring(id);
        this.refreshReviews(id);
        this.refreshAlternatives(id);
        this.refreshPhaseOutputs(id);
        this.refreshPhaseSessions(id);
        this.refreshUsageEvents(id);
      });

    if (typeof window !== "undefined" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (e: MediaQueryListEvent) => this.darkMode.set(e.matches);
      mq.addEventListener?.("change", onChange);
      this.destroy$.subscribe(() =>
        mq.removeEventListener?.("change", onChange),
      );
    }
  }

  private resetAll() {
    this.task.set(null);
    this.taskLoading.set(false);
    this.taskError.set(null);
    this.phaseSessions.set([]);
    this.detailTab.set("live");
    this.scoring.set([]);
    this.reviews.set([]);
    this.alternatives.set([]);
    this.altTabIndex.set(-1);
    this.phaseOutputs.set([]);
    this.usageEvents.set([]);
    this.diff.set(null);
    this.diffLoading.set(false);
    this.diffError.set(null);
    this.showPatch.set(false);
    this.suggestions.set([]);
    this.issueLinks.set([]);
    this.transcriptTail.set([]);
    this.transcriptLoading.set(false);
    this.sessionTranscripts.set(new Map());
    this.sessionTranscriptLoading.set(new Set());
    this.closeStream();
  }

  private loadAll(taskId: string) {
    this.taskLoading.set(true);
    this.taskError.set(null);

    this.tasksApi.get(taskId).subscribe({
      next: (t) => {
        this.task.set(t);
        this.taskLoading.set(false);
        this.taskError.set(null);
        if (t.last_session_id) {
          this.refreshTranscript(taskId);
        } else {
          this.transcriptTail.set([]);
        }
      },
      error: (e) => {
        this.task.set(null);
        this.taskLoading.set(false);
        this.taskError.set(e?.error?.message ?? e?.message ?? "Failed to load task");
      },
    });

    this.loadPhaseSessions(taskId);
    this.refreshDiff(taskId);
    this.refreshScoring(taskId);
    this.refreshReviews(taskId);
    this.refreshAlternatives(taskId);
    this.refreshPhaseOutputs(taskId);
    this.refreshSuggestions(taskId);
    this.refreshIssueLinks(taskId);
    this.refreshUsageEvents(taskId);
    this.openStream(taskId);
    this.altTabIndex.set(-1);
    this.sessionTranscripts.set(new Map());
    this.sessionTranscriptLoading.set(new Set());
    this.detailTab.set("live");
  }

  private loadPhaseSessions(taskId: string) {
    this.tasksApi.getPhaseSessions(taskId).subscribe({
      next: (r) => this.phaseSessions.set(r.phase_sessions),
      error: () => this.phaseSessions.set([]),
    });
  }

  private refreshDiff(taskId: string) {
    this.diffLoading.set(true);
    this.diffError.set(null);
    const t = this.task();
    this.tasksApi.diff(taskId).subscribe({
      next: (d) => {
        this.diff.set(d as unknown as DiffResponse);
        this.diffLoading.set(false);
      },
      error: () => {
        this.repoApi.diff({ base: t?.worktree_base_ref ?? null }).subscribe({
          next: (d) => {
            this.diff.set(d);
            this.diffLoading.set(false);
          },
          error: (e) => {
            this.diffError.set(e?.message ?? String(e));
            this.diffLoading.set(false);
          },
        });
      },
    });
  }

  protected refreshDiffAction() {
    const id = this.taskId();
    if (!id) return;
    this.refreshDiff(id);
  }

  private refreshScoring(taskId: string) {
    this.tasksApi.getScoring(taskId).subscribe({
      next: (r) => this.scoring.set(r.scoring),
      error: () => this.scoring.set([]),
    });
  }

  private refreshReviews(taskId: string) {
    this.tasksApi.getReviews(taskId).subscribe({
      next: (r) => this.reviews.set(r.reviews),
      error: () => this.reviews.set([]),
    });
  }

  private refreshAlternatives(taskId: string) {
    this.tasksApi.getAlternatives(taskId).subscribe({
      next: (r) => {
        this.alternatives.set(r.alternatives);
        if (this.altTabIndex() >= r.alternatives.length) this.altTabIndex.set(-1);
      },
      error: () => this.alternatives.set([]),
    });
  }

  private refreshPhaseOutputs(taskId: string) {
    this.tasksApi.getPhaseOutputs(taskId).subscribe({
      next: (r) => this.phaseOutputs.set(r.phase_outputs),
      error: () => this.phaseOutputs.set([]),
    });
  }

  private refreshSuggestions(taskId: string) {
    this.suggestionsApi.listForTask(taskId).subscribe({
      next: (r) => this.suggestions.set(r.suggestions),
      error: () => this.suggestions.set([]),
    });
  }

  private refreshIssueLinks(taskId: string) {
    this.issueLinksApi.list(taskId).subscribe({
      next: (r) => this.issueLinks.set(r.links),
      error: () => this.issueLinks.set([]),
    });
  }

  private refreshUsageEvents(taskId: string) {
    this.tasksApi.getUsageEvents(taskId).subscribe({
      next: (r) => this.usageEvents.set(r.events),
      error: () => this.usageEvents.set([]),
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.closeStream();
  }
}
