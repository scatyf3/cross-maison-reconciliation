// src/core/agentTrace.js
//
// Agent-trace parser for the replay feature. Pure: no DOM, no storage.
//
// Accepts the transcript of an external AI agent that worked on the
// reconciliation through tool calls, and turns it into an ordered list of
// replayable steps. Supported shapes (all share Anthropic content blocks:
// `text`, `thinking`, `tool_use`, `tool_result`):
//
//   1. Messages array ............ [{ role, content }, ...]
//   2. Messages object ........... { messages: [...], system?, tools? }
//   3. JSONL event log ........... one JSON object per line, either
//                                   { role, content } or the Claude Agent SDK /
//                                   Claude Code shape { type, message: { role, content } }
//
// Each tool_use becomes an "action" step; the matching tool_result (by
// tool_use_id) is attached to it as `traceResult`, so the player can show what
// the agent saw originally next to what the replay produced.
//
// Tool names are mapped onto app operations by TOOL_ALIASES. MCP-prefixed
// names (mcp__server__tool) and camelCase / kebab-case variants are
// normalized first, so `mcp__p2p__approveMapping` and `approve-mapping` both
// resolve to approveMapping. Read-only tools map to an "observe" action that
// only navigates. Anything else is kept as an "unsupported" step: shown in the
// timeline, never executed.

/** Mutating tools -> controller operation. Keys are normalized snake_case. */
export const TOOL_ALIASES = Object.freeze({
  load_extract: "loadExtract",
  load_maison_extract: "loadExtract",
  ingest_extract: "loadExtract",
  upload_extract: "loadExtract",
  load_finance_extract: "loadFinanceExtract",
  load_finance_export: "loadFinanceExtract",
  ingest_finance_export: "loadFinanceExtract",
  approve_mapping: "approveMapping",
  approve_suggestion: "approveMapping",
  map_exception: "approveMapping",
  add_mapping: "addMapping",
  create_mapping: "addMapping",
  resolve_exception: "resolveException",
  override_exception: "resolveException",
  approve_exception: "resolveException",
  clear_exception: "resolveException",
  reject_resolution: "rejectResolution",
  reject_exception: "rejectResolution",
  hold_exception: "rejectResolution",
  put_on_hold: "rejectResolution",
  delete_mapping: "deleteMapping",
  remove_mapping: "deleteMapping",
  navigate: "navigate",
  open_view: "navigate",
  go_to_view: "navigate",
});

/** Read-only tools -> the view that shows what the agent looked at. */
export const OBSERVE_ALIASES = Object.freeze({
  get_exception_queue: "#exceptions",
  list_exceptions: "#exceptions",
  get_exception: "#exceptions",
  get_mapping_table: "#mappings",
  list_mappings: "#mappings",
  get_audit_trail: "#mappings",
  get_group_report: "#report",
  build_group_report: "#report",
  export_report: "#report",
  get_spend_summary: "#report",
  analyze_sourcing: "#sourcing",
  get_sourcing_analysis: "#sourcing",
  get_strategic_sourcing: "#sourcing",
});

// Keyword fallback for read-only tools not listed above. Only applied when the
// tool name starts with a read verb, so an unknown mutating tool is never
// mistaken for a harmless one.
const READ_VERB = /^(get|list|read|view|show|fetch|query|search|analy[sz]e|inspect|describe|export|summari[sz]e)_/;
const OBSERVE_KEYWORDS = [
  [/sourc/, "#sourcing"],
  [/report|spend/, "#report"],
  [/mapping|audit/, "#mappings"],
  [/exception|queue/, "#exceptions"],
  [/extract|load/, "#load"],
];

const VIEW_NAMES = Object.freeze({
  load: "#load", extracts: "#load", load_extracts: "#load",
  exceptions: "#exceptions", exception_queue: "#exceptions", queue: "#exceptions",
  mappings: "#mappings", mapping_table: "#mappings", audit: "#mappings",
  report: "#report", group_report: "#report",
  sourcing: "#sourcing", strategic_sourcing: "#sourcing",
});

/** Normalize a tool name: strip an MCP prefix, then snake_case it. */
export function normalizeToolName(name) {
  let s = String(name || "");
  if (s.startsWith("mcp__")) {
    const cut = s.lastIndexOf("__");
    s = s.slice(cut + 2);
  }
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toLowerCase();
}

/** Map a view name or hash ("report", "#report") to a route hash, or null. */
export function viewToRoute(view) {
  if (view == null) return null;
  const raw = String(view).trim();
  const key = normalizeToolName(raw.replace(/^#/, ""));
  return VIEW_NAMES[key] || null;
}

/**
 * Classify one tool call.
 * @returns {{ kind: "action"|"observe"|"unsupported", op?: string, route?: string }}
 */
export function classifyTool(name, input) {
  const n = normalizeToolName(name);
  if (TOOL_ALIASES[n]) {
    const op = TOOL_ALIASES[n];
    if (op === "navigate") {
      const args = camelizeKeys(input);
      const route = viewToRoute(args.view ?? args.route ?? args.hash ?? args.page);
      return route ? { kind: "observe", route } : { kind: "unsupported" };
    }
    return { kind: "action", op };
  }
  if (OBSERVE_ALIASES[n]) return { kind: "observe", route: OBSERVE_ALIASES[n] };
  if (READ_VERB.test(n)) {
    for (const [re, route] of OBSERVE_KEYWORDS) if (re.test(n)) return { kind: "observe", route };
  }
  return { kind: "unsupported" };
}

/** snake_case / kebab-case keys -> camelCase (shallow). */
export function camelizeKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/[_-]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing.
// ---------------------------------------------------------------------------

/**
 * Parse trace text into replay steps.
 *
 * @param {string} text  raw file contents (JSON or JSONL)
 * @returns {{ format: string, steps: Object[], warnings: string[],
 *            meta: { title: string|null, description: string|null, agent: string|null } }}
 * @throws {Error} when the text is neither a supported JSON nor JSONL trace
 */
export function parseTrace(text) {
  const src = String(text || "").replace(/^﻿/, "").trim();
  if (src === "") throw new Error("The trace is empty.");

  let messages = null;
  let format = "";
  const warnings = [];
  const meta = { title: null, description: null, agent: null };

  let whole;
  let wholeOk = false;
  try { whole = JSON.parse(src); wholeOk = true; } catch { wholeOk = false; }

  if (wholeOk && Array.isArray(whole)) {
    messages = whole.map(unwrapEvent).filter(Boolean);
    format = "messages-array";
  } else if (wholeOk && whole && Array.isArray(whole.messages)) {
    messages = whole.messages.map(unwrapEvent).filter(Boolean);
    format = "messages-object";
    for (const k of Object.keys(meta)) if (typeof whole[k] === "string") meta[k] = whole[k];
  } else if (wholeOk && whole && typeof whole === "object") {
    const one = unwrapEvent(whole);
    if (!one) throw new Error("Unrecognized trace: expected a messages array, { messages: [...] }, or JSONL.");
    messages = [one];
    format = "single-message";
  } else {
    messages = [];
    const lines = src.split(/\r?\n/);
    let bad = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "") continue;
      try {
        const msg = unwrapEvent(JSON.parse(line));
        if (msg) messages.push(msg);
      } catch {
        bad += 1;
        if (bad <= 3) warnings.push("Line " + (i + 1) + " is not valid JSON and was skipped.");
      }
    }
    if (messages.length === 0) throw new Error("Unrecognized trace: no messages with role/content found.");
    if (bad > 3) warnings.push((bad - 3) + " more invalid line(s) skipped.");
    format = "jsonl";
  }

  const steps = [];
  const byToolUseId = new Map();

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "agent" : "user";
    const blocks = typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : Array.isArray(msg.content) ? msg.content : [];

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        const t = cleanText(block.text);
        if (t) steps.push({ kind: "narration", role, text: t, timestamp: msg.timestamp || null });
      } else if (block.type === "thinking") {
        const t = cleanText(block.thinking);
        if (t) steps.push({ kind: "narration", role: "thinking", text: t, timestamp: msg.timestamp || null });
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        const input = block.input && typeof block.input === "object" ? block.input : {};
        const cls = classifyTool(block.name, input);
        const step = {
          kind: cls.kind,
          op: cls.op || null,
          route: cls.route || null,
          tool: String(block.name || ""),
          toolUseId: block.id || null,
          input,
          traceResult: null,
          timestamp: msg.timestamp || null,
        };
        steps.push(step);
        if (block.id) byToolUseId.set(block.id, step);
      } else if (block.type === "tool_result") {
        const step = byToolUseId.get(block.tool_use_id);
        const result = { text: resultText(block.content), isError: block.is_error === true };
        if (step) step.traceResult = result;
        else warnings.push("A tool_result references unknown tool_use_id " + block.tool_use_id + ".");
      }
    }
  }

  const unsupported = steps.filter((s) => s.kind === "unsupported");
  if (unsupported.length > 0) {
    const names = [...new Set(unsupported.map((s) => s.tool))].join(", ");
    warnings.push("Tool(s) with no app mapping will be shown but not executed: " + names + ".");
  }
  if (!steps.some((s) => s.kind === "action" || s.kind === "observe")) {
    warnings.push("The trace has no tool calls this app can replay; only the narration will be shown.");
  }

  return { format, steps, warnings, meta };
}

// Accept { role, content } directly, or an SDK/Claude Code event wrapping one
// in `message`. Non-conversation events (system, result, summary) are dropped.
function unwrapEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.message && typeof ev.message === "object" && ev.message.role) {
    return { role: ev.message.role, content: ev.message.content, timestamp: ev.timestamp || null };
  }
  if (ev.role === "user" || ev.role === "assistant") {
    return { role: ev.role, content: ev.content, timestamp: ev.timestamp || null };
  }
  return null;
}

// Drop harness noise injected into user turns (system reminders, slash-command
// wrappers) so only what the person actually said is narrated.
function cleanText(text) {
  return String(text || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(command-[a-z-]+|local-command-stdout)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

function resultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === "text" ? b.text : b && b.type ? "[" + b.type + "]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}
