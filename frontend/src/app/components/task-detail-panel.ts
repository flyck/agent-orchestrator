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
  untracked,
  viewChild,
} from "@angular/core";
import { Subject, type Subscription, timer } from "rxjs";
import { takeUntil } from "rxjs/operators";
import {
  TasksService,
  parseTaskPrMeta,
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
import { SettingsService } from "../services/settings.service";
import { SuggestionsService } from "../services/suggestions.service";
import {
  IssueLinksService,
  type TaskIssueLink,
} from "../services/issue-links.service";
import { FormsModule } from "@angular/forms";
import { ScoringRadar } from "./scoring-radar";
import { MermaidDiagram } from "./mermaid-diagram";
import { MarkdownView } from "./markdown-view";
import { formatTs, relativeTs, clockTs } from "../util/time";
import {
  parseSynthesisOutput,
  renderCommentBody,
  type ParsedSynthesis,
} from "../pages/review/synthesis";
import { IntegrationsService } from "../services/integrations.service";

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
  imports: [FormsModule, ScoringRadar, MermaidDiagram, MarkdownView],
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
      .detail-title-link {
        color: inherit;
        text-decoration: none;
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
      }
      .detail-title-link:hover {
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 3px;
      }
      .detail-title-icon {
        flex-shrink: 0;
        align-self: center;
        color: var(--ink-muted);
        transition: color 120ms ease;
      }
      .detail-title-link:hover .detail-title-icon { color: var(--ink); }
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
      .detail-head-actions {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .detail-delete-btn {
        color: var(--ink-red, #b34c4c);
        border-color: var(--ink-red, #b34c4c);
      }
      .detail-delete-btn:hover {
        background: var(--ink-red, #b34c4c);
        color: var(--paper);
      }
      .detail-delete-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .detail-done-btn {
        color: #2e8b57;
        border-color: #2e8b57;
      }
      .detail-done-btn:hover {
        background: #2e8b57;
        color: var(--paper);
      }
      .detail-done-btn:disabled {
        opacity: 0.5;
        cursor: default;
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
      .detail-meta .meta-spacer { flex: 1; }
      .detail-meta .open-msg { color: var(--ink-red); }
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
      .direction-section {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px dashed var(--rule);
      }
      .direction-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 10px;
      }
      .direction-head h3 { margin: 0; font-family: var(--font-serif); font-size: 16px; }
      .direction-validation-warn {
        margin: 12px 0;
        padding: 10px 12px;
        background: var(--ink-amber-bg);
        border: 1px solid var(--ink-amber);
        border-radius: 2px;
      }
      .direction-validation-warn p { margin: 4px 0; }
      .validation-errors {
        margin: 6px 0 0 18px;
        padding: 0;
        font-size: 12px;
        color: var(--ink);
      }
      .direction-evidence {
        margin: 14px 0;
        padding: 12px 14px;
        border: 1px solid var(--rule);
        background: var(--paper-soft);
      }
      .direction-evidence h4 {
        margin: 0 0 8px;
        font-family: var(--font-serif);
        font-size: 14px;
      }
      .alt-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
      .alt-item {
        border-left: 3px solid var(--rule-strong);
        background: var(--paper);
        padding: 8px 12px;
      }
      .alt-item[data-verdict='better'] { border-left-color: #4F7048; }
      .alt-item[data-verdict='worse']  { border-left-color: var(--ink-red); }
      .alt-item[data-verdict='equal']  { border-left-color: var(--ink-muted); }
      .alt-item-head { display: flex; align-items: baseline; gap: 10px; }
      .alt-item-label { font-family: var(--font-serif); font-size: 14px; flex: 1; }
      .alt-item-desc { margin: 4px 0 0; font-size: 13px; line-height: 1.5; }
      .direction-row { margin: 12px 0; }
      .direction-label {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .direction-label.stretch textarea { width: 100%; resize: vertical; min-height: 100px; }
      .direction-label .meta { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
      .direction-label select { font-size: 13px; padding: 4px 6px; }
      .direction-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 12px;
      }
      .direction-actions .error { color: var(--ink-red); }

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

      /* ─── Synthesis selector ────────────────────────────── */
      .synthesis-section {
        border: 1px solid var(--rule-strong);
        padding: 14px 16px;
        margin: 0 0 20px;
        background: var(--paper);
      }
      .synth-controls {
        display: flex;
        gap: 6px;
        margin: 10px 0 8px;
        flex-wrap: wrap;
      }
      .synth-controls .meta-action {
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: transparent;
        border: 1px solid var(--rule-strong);
        padding: 3px 8px;
        cursor: pointer;
        color: var(--ink-muted);
      }
      .synth-controls .meta-action:hover {
        color: var(--ink);
        border-color: var(--ink);
      }
      .findings-select .finding {
        padding: 0;
      }
      .findings-select .finding-pick {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 8px 10px;
        cursor: pointer;
      }
      .findings-select .finding-pick input[type='checkbox'] {
        margin-top: 3px;
        flex-shrink: 0;
      }
      .findings-select .finding-body {
        display: flex;
        flex-direction: column;
        gap: 3px;
        flex: 1;
        min-width: 0;
      }
      .finding-attribution { font-size: 11px; }
      .finding-dissent { font-size: 12px; color: var(--ink-amber); }
      .finding-tags {
        display: inline-flex;
        gap: 4px;
        flex-wrap: wrap;
        margin-top: 2px;
      }
      .tag-pill {
        font-size: 10px;
        font-family: var(--font-mono);
        letter-spacing: 0.04em;
        padding: 1px 6px;
        border: 1px dashed var(--rule-strong);
        border-radius: 8px;
        color: var(--ink-muted);
      }
      .synth-noise {
        margin-top: 10px;
        border-top: 1px solid var(--rule);
        padding-top: 8px;
      }
      .synth-noise summary { cursor: pointer; padding: 4px 0; }
      .synth-observations { margin-top: 12px; }
      .synth-post {
        margin-top: 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-start;
      }
      .finding-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 10px;
      }
      .finding-row .finding-pick {
        flex: 1;
        padding: 0;
      }
      .doubt-toggle {
        font-size: 10.5px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: transparent;
        border: 1px solid var(--rule-strong);
        color: var(--ink-muted);
        padding: 3px 8px;
        cursor: pointer;
        border-radius: 2px;
        flex-shrink: 0;
        align-self: center;
      }
      .doubt-toggle:hover {
        color: var(--ink-amber);
        border-color: var(--ink-amber);
      }
      .doubt-toggle.active {
        background: var(--ink-amber);
        color: var(--paper);
        border-color: var(--ink-amber);
      }
      .finding.doubted {
        background: var(--ink-amber-bg, rgba(255, 200, 100, 0.08));
      }
      .doubt-note {
        width: calc(100% - 20px);
        margin: 4px 10px 10px;
        font-family: inherit;
        font-size: 12.5px;
        padding: 6px 8px;
        border: 1px solid var(--rule-strong);
        background: var(--paper);
        resize: vertical;
      }
      .synth-doubt-block {
        margin-top: 16px;
        padding: 12px 14px;
        border: 1px dashed var(--ink-amber);
        background: var(--ink-amber-bg, rgba(255, 200, 100, 0.05));
      }
      .doubt-global-note {
        width: 100%;
        font-family: inherit;
        font-size: 13px;
        padding: 8px 10px;
        border: 1px solid var(--rule-strong);
        background: var(--paper);
        margin: 8px 0 10px;
        resize: vertical;
      }
      .synth-doubt-actions {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
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
      /* Filename behaves like a button — enabled when ide_open_command is
         configured, disabled otherwise. Underline on hover hints at the
         link affordance without making it look pre-selected. */
      .link-button {
        background: transparent;
        border: 0;
        padding: 0;
        margin: 0;
        font: inherit;
        text-align: left;
        color: var(--ink);
        cursor: pointer;
      }
      .link-button:hover { text-decoration: underline; }
      .link-button:disabled {
        color: var(--ink-muted);
        cursor: default;
        text-decoration: none;
      }
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
  private settingsApi = inject(SettingsService);
  private suggestionsApi = inject(SuggestionsService);
  private issueLinksApi = inject(IssueLinksService);
  private integrationsApi = inject(IntegrationsService);

  readonly taskId = input<string | null>(null);
  readonly close = output<void>();
  readonly taskChanged = output<void>();

  protected readonly formatTs = formatTs;
  protected readonly relativeTs = relativeTs;
  protected readonly clockTs = clockTs;

  protected readonly task = signal<Task | null>(null);
  protected readonly taskLoading = signal(false);
  protected readonly taskError = signal<string | null>(null);
  protected readonly deleting = signal(false);
  protected readonly finishing = signal(false);

  /** PR coordinates parsed out of the task's metadata blob. Drives the
   *  title-as-link affordance + the post-comment routing. Null for
   *  non-review tasks (or review tasks created before metadata existed). */
  protected readonly prMeta = computed(() => {
    const t = this.task();
    return t ? parseTaskPrMeta(t) : null;
  });

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
    // Direction tab — only when the task is paused at the direction
    // gate. The runner sets awaiting_gate_id="direction-gate" so the
    // tab appears for review tasks at the right phase, and disappears
    // again once the user approves or sends back.
    if (this.task()?.awaiting_gate_id === "direction-gate") {
      tabs.push({ id: "direction", label: "Direction", badge: "decide" });
    }
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
          // Hide the agent's input — it's the spec + diff, identical on
          // every cycle and already shown in the Spec / Files tabs. The
          // transcript becomes "what the agent said" only.
          if (role === "user") continue;
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
          this.closeStream();
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
          if (role === "user") continue;
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

  // ─── Direction-gate decision (only meaningful when paused at the gate)
  // The dropdown chooses between three actions:
  //   accept_implementation — approve the gate as-is.
  //   accept_alternative    — approve, intent to use alt #N (today the
  //     backend doesn't accept the alt id, so this is informational
  //     only — same wire effect as accept_implementation).
  //   send_back             — fire /continue with feedback so the
  //     explorer revises.
  protected readonly directionAction = signal<
    "accept_implementation" | "accept_alternative" | "send_back"
  >("accept_implementation");
  protected readonly directionFeedback = signal<string>("");
  protected readonly directionAltIndex = signal<number>(0);
  protected readonly directionBusy = signal<boolean>(false);
  protected readonly directionError = signal<string | null>(null);

  setDirectionAction(value: string) {
    if (value === "accept_implementation" || value === "accept_alternative" || value === "send_back") {
      this.directionAction.set(value);
    }
  }

  submitDirection() {
    const id = this.taskId();
    if (!id) return;
    const action = this.directionAction();
    this.directionBusy.set(true);
    this.directionError.set(null);
    if (action === "send_back") {
      const feedback = this.directionFeedback().trim();
      if (!feedback) {
        this.directionBusy.set(false);
        this.directionError.set("Feedback is required when sending back.");
        return;
      }
      this.tasksApi.sendBackGate(id, feedback).subscribe({
        next: () => {
          this.directionBusy.set(false);
          this.directionFeedback.set("");
          this.taskChanged.emit();
        },
        error: (e) => {
          this.directionBusy.set(false);
          this.directionError.set(e?.error?.message ?? e?.message ?? String(e));
        },
      });
      return;
    }
    // Both accept paths approve the gate. The alternative selection is
    // captured client-side for now; backend extension can carry it once
    // /gate/approve accepts a body.
    this.tasksApi.approveGate(id).subscribe({
      next: () => {
        this.directionBusy.set(false);
        this.taskChanged.emit();
      },
      error: (e) => {
        this.directionBusy.set(false);
        this.directionError.set(e?.error?.message ?? e?.message ?? String(e));
      },
    });
  }

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
  /** Latest phase output for a given phase_id — used to surface
   *  validation status (e.g. "explorer reply didn't validate") in
   *  the Direction tab. */
  protected readonly explorePhaseOutput = computed<TaskPhaseOutputRow | null>(() => {
    const explores = this.phaseOutputs().filter((p) => p.phase_id === "explore");
    return explores.length > 0 ? explores[explores.length - 1]! : null;
  });
  protected readonly explorerValidationFailed = computed<boolean>(() => {
    return this.explorePhaseOutput()?.validation_status === "failed";
  });
  protected readonly explorerValidationErrors = computed<string[]>(() => {
    const raw = this.explorePhaseOutput()?.validation_errors_json;
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as string[]) : [];
    } catch {
      return [];
    }
  });
  protected readonly intakeDiagram = computed<string | null>(() => {
    const intake = this.phaseOutputs().find((p) => p.phase_id === "intake");
    if (!intake) return null;
    return extractMermaid(intake.output_md);
  });

  // ─── Synthesized findings (PR-review Ready stage) ────────────────────
  //
  // Parsed from the latest synthesis phase_output. When parsing succeeds
  // the Reviews tab shows the per-finding checkbox list above the per-
  // cycle reviewer history. The user trims the list, clicks "Post
  // selected to PR", and only the checked findings ride the comment.
  protected readonly synthesisFindings = computed<ParsedSynthesis | null>(() => {
    const synths = this.phaseOutputs().filter((p) => p.phase_id === "synthesis");
    if (synths.length === 0) return null;
    // Newest first — there might be multiple if the agent re-ran.
    const latest = synths[synths.length - 1]!;
    return parseSynthesisOutput(latest.output_md);
  });

  /** Set of finding ids the user has KEPT checked. We seed all-checked on
   *  first parse, then track explicit unchecks. New findings emitted by
   *  a re-run come in default-checked because they won't be in the set
   *  of explicit unchecks. */
  private readonly uncheckedFindingIds = signal<Set<string>>(new Set());
  private readonly uncheckedObservationIdx = signal<Set<number>>(new Set());

  /** Per-finding "doubt" state. Independent of the post-checkbox: the
   *  user can simultaneously want to post some findings AND doubt others
   *  on the same Ready review. The Map values hold the per-finding note
   *  textarea contents so they survive re-renders. */
  protected readonly doubtNotes = signal<Map<string, string>>(new Map());
  protected readonly doubtGlobalNote = signal<string>("");

  protected isFindingDoubted(id: string): boolean {
    return this.doubtNotes().has(id);
  }
  protected getDoubtNote(id: string): string {
    return this.doubtNotes().get(id) ?? "";
  }
  protected toggleDoubt(id: string): void {
    this.doubtNotes.update((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, "");
      return next;
    });
  }
  protected setDoubtNote(id: string, value: string): void {
    this.doubtNotes.update((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.set(id, value);
      return next;
    });
  }
  protected clearDoubts(): void {
    this.doubtNotes.set(new Map());
    this.doubtGlobalNote.set("");
  }
  protected readonly doubtCount = computed<number>(() => this.doubtNotes().size);

  protected isFindingChecked(id: string): boolean {
    return !this.uncheckedFindingIds().has(id);
  }
  protected isObservationChecked(i: number): boolean {
    return !this.uncheckedObservationIdx().has(i);
  }
  protected toggleFinding(id: string): void {
    this.uncheckedFindingIds.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  protected toggleObservation(i: number): void {
    this.uncheckedObservationIdx.update((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  protected selectAllFindings(): void {
    this.uncheckedFindingIds.set(new Set());
    this.uncheckedObservationIdx.set(new Set());
  }
  protected selectNoFindings(): void {
    const synth = this.synthesisFindings();
    if (!synth) return;
    const allIds = new Set<string>();
    for (const f of synth.ranked) allIds.add(f.id);
    for (const f of synth.noise) allIds.add(f.id);
    const allObs = new Set<number>();
    for (let i = 0; i < synth.observations.length; i++) allObs.add(i);
    this.uncheckedFindingIds.set(allIds);
    this.uncheckedObservationIdx.set(allObs);
  }
  /** Uncheck the noise bucket + observations, keep ranked. */
  protected selectRankedOnly(): void {
    const synth = this.synthesisFindings();
    if (!synth) return;
    const drop = new Set<string>();
    for (const f of synth.noise) drop.add(f.id);
    const allObs = new Set<number>();
    for (let i = 0; i < synth.observations.length; i++) allObs.add(i);
    this.uncheckedFindingIds.set(drop);
    this.uncheckedObservationIdx.set(allObs);
  }

  protected readonly checkedCount = computed<number>(() => {
    const synth = this.synthesisFindings();
    if (!synth) return 0;
    const unchecked = this.uncheckedFindingIds();
    const uncheckedObs = this.uncheckedObservationIdx();
    let n = 0;
    for (const f of synth.ranked) if (!unchecked.has(f.id)) n++;
    for (const f of synth.noise) if (!unchecked.has(f.id)) n++;
    for (let i = 0; i < synth.observations.length; i++) {
      if (!uncheckedObs.has(i)) n++;
    }
    return n;
  });

  protected readonly posting = signal(false);
  protected readonly postError = signal<string | null>(null);
  protected readonly postedHtmlUrl = signal<string | null>(null);

  protected readonly sendingBack = signal(false);
  protected readonly sendBackError = signal<string | null>(null);

  protected sendBackWithDoubts(): void {
    const task = this.task();
    const synth = this.synthesisFindings();
    if (!task || !synth) return;
    const doubts = this.doubtNotes();
    if (doubts.size === 0) {
      this.sendBackError.set("Toggle 'doubt' on at least one finding first.");
      return;
    }
    // Resolve each doubted id back to its full finding so we can ship
    // the title + severity along (helps the synthesizer talk about it
    // without re-resolving from the prior phase output).
    const all = [...synth.ranked, ...synth.noise];
    const payload: Array<{
      finding_id: string;
      title: string;
      severity: string;
      reason: string;
    }> = [];
    for (const [id, reason] of doubts.entries()) {
      const f = all.find((x) => x.id === id);
      if (!f) continue;
      payload.push({
        finding_id: f.id,
        title: f.title,
        severity: f.severity,
        reason,
      });
    }
    if (payload.length === 0) {
      this.sendBackError.set("Couldn't resolve any doubted findings — try refreshing.");
      return;
    }
    if (
      !confirm(
        `Send ${payload.length} doubt(s) back to the synthesizer? This will re-run the synthesis phase with your notes.`,
      )
    ) {
      return;
    }
    this.sendingBack.set(true);
    this.sendBackError.set(null);
    this.tasksApi
      .sendBackReviewWithDoubts(task.id, payload, this.doubtGlobalNote().trim())
      .subscribe({
        next: () => {
          this.sendingBack.set(false);
          this.clearDoubts();
          this.taskChanged.emit();
        },
        error: (e) => {
          this.sendingBack.set(false);
          this.sendBackError.set(e?.error?.message ?? e?.message ?? String(e));
        },
      });
  }

  protected postSelectedFindings(): void {
    const task = this.task();
    const synth = this.synthesisFindings();
    if (!task || !synth) return;
    const unchecked = this.uncheckedFindingIds();
    const uncheckedObs = this.uncheckedObservationIdx();
    const keptFindings = [...synth.ranked, ...synth.noise].filter(
      (f) => !unchecked.has(f.id),
    );
    const obsIdx = new Set<number>();
    for (let i = 0; i < synth.observations.length; i++) {
      if (!uncheckedObs.has(i)) obsIdx.add(i);
    }
    const body = renderCommentBody(keptFindings, synth.observations, obsIdx);
    if (!body) {
      this.postError.set("Select at least one finding to post.");
      return;
    }
    if (!confirm(`Post this review comment to the PR?\n\nThis can't be undone.`)) return;
    this.posting.set(true);
    this.postError.set(null);
    this.postedHtmlUrl.set(null);
    this.integrationsApi.postReviewComment(task.id, body).subscribe({
      next: (r) => {
        this.posting.set(false);
        this.postedHtmlUrl.set(r.html_url ?? null);
      },
      error: (e) => {
        this.posting.set(false);
        this.postError.set(e?.error?.message ?? e?.message ?? String(e));
      },
    });
  }

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

  // ─── IDE / emacs / magit open ───────────────────────────────────────
  // Tracks whether the corresponding *_open_command is configured so the
  // top-of-panel buttons + the file links in the Files-changed list can
  // disable themselves cleanly when there's nothing to open with.
  protected readonly hasIdeCommand = signal(false);
  protected readonly hasEmacsCommand = signal(false);
  protected readonly hasMagitCommand = signal(false);
  protected readonly openMessage = signal<string | null>(null);

  private resolveTarget(path?: string): string | undefined {
    const wt = this.task()?.worktree_path;
    return path ? (wt ? `${wt}/${path}` : path) : (wt ?? undefined);
  }

  /** Open `path` (repo-relative) in the user's configured IDE. Targets
   *  the task's worktree when one exists so the link points at the
   *  agent's checkout, not the parent repo. Mirrors the behavior of
   *  the same control on the Home page. */
  protected openInIde(path?: string): void {
    this.openMessage.set(null);
    this.repoApi.open("ide", this.resolveTarget(path)).subscribe({
      error: (e) =>
        this.openMessage.set(e?.error?.message ?? `error: ${e?.message ?? e}`),
    });
  }

  protected openInEmacs(path?: string): void {
    this.openMessage.set(null);
    this.repoApi.open("emacs", this.resolveTarget(path)).subscribe({
      error: (e) =>
        this.openMessage.set(e?.error?.message ?? `error: ${e?.message ?? e}`),
    });
  }

  protected openInMagit(): void {
    this.openMessage.set(null);
    const wt = this.task()?.worktree_path ?? undefined;
    this.repoApi.open("magit", wt).subscribe({
      error: (e) =>
        this.openMessage.set(e?.error?.message ?? `error: ${e?.message ?? e}`),
    });
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
  // Per-session transcript view — separate from the live tail. Scrolls
  // to the bottom whenever the session changes or its lines load so
  // the most recent agent text is visible without manual scrolling.
  private readonly sessionTranscriptContainer =
    viewChild<ElementRef<HTMLElement>>("sessionTranscriptContainer");
  private autoScrollPinned = true;

  protected onStreamScroll(ev: Event): void {
    const el = ev.target as HTMLElement;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.autoScrollPinned = distanceFromBottom < 24;
  }

  constructor() {
    // One-shot settings load — drives the open-in-X buttons in the
    // header meta row + the file links in the Files-changed list.
    this.settingsApi.get().subscribe({
      next: (s) => {
        this.hasIdeCommand.set(!!s.ide_open_command?.trim());
        this.hasEmacsCommand.set(!!s.emacs_open_command?.trim());
        this.hasMagitCommand.set(!!s.magit_open_command?.trim());
      },
      error: () => {
        this.hasIdeCommand.set(false);
        this.hasEmacsCommand.set(false);
        this.hasMagitCommand.set(false);
      },
    });

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

    // Auto-scroll the per-session transcript to the bottom when the
    // user opens an agent tab — the latest assistant text is what they
    // care about. Triggers on tab change + when the lines for that
    // session arrive (transcripts load asynchronously).
    effect(() => {
      const sess = this.selectedPhaseSession();
      if (!sess) return;
      this.sessionTranscripts().get(sess.session_id);
      queueMicrotask(() => {
        const el = this.sessionTranscriptContainer()?.nativeElement;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      });
    });

    effect(() => {
      const id = this.taskId();
      untracked(() => {
        if (!id) {
          this.resetAll();
          return;
        }
        this.loadAll(id);
      });
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
    this.uncheckedFindingIds.set(new Set());
    this.uncheckedObservationIdx.set(new Set());
    this.doubtNotes.set(new Map());
    this.doubtGlobalNote.set("");
    this.posting.set(false);
    this.postError.set(null);
    this.postedHtmlUrl.set(null);
    this.sendingBack.set(false);
    this.sendBackError.set(null);
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
    this.tasksApi.diff(taskId).subscribe({
      next: (d) => {
        this.diff.set(d as unknown as DiffResponse);
        this.diffLoading.set(false);
      },
      error: () => {
        const t = this.task();
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

  protected deleteReviewTask(): void {
    const t = this.task();
    if (!t || t.workspace !== "review") return;
    if (!confirm(`Delete review task "${t.title}"?\nThis removes the task and all its agent transcripts so the next review starts fresh.`)) {
      return;
    }
    this.deleting.set(true);
    this.tasksApi.delete(t.id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.taskChanged.emit();
        this.close.emit();
      },
      error: (e) => {
        this.deleting.set(false);
        this.taskError.set(e?.error?.message ?? e?.message ?? String(e));
      },
    });
  }

  protected finishReviewTask(): void {
    const t = this.task();
    if (!t || t.workspace !== "review") return;
    this.finishing.set(true);
    // Re-use abandon — stamps abandoned_at, which the Review-page
    // classifier reads to move the card from Ready to History. The
    // task row + transcripts stay (vs Delete) so the user can revisit.
    this.tasksApi.abandon(t.id).subscribe({
      next: () => {
        this.finishing.set(false);
        this.taskChanged.emit();
        this.close.emit();
      },
      error: (e) => {
        this.finishing.set(false);
        this.taskError.set(e?.error?.message ?? e?.message ?? String(e));
      },
    });
  }
}
