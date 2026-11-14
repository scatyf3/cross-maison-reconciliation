// v2/live.js — a live Claude agent working on the governed data.
//
// The agent gets read-only SQL plus the governed tools. Every tool call it
// makes is turned into an engine step and goes through the same policy
// gateway as a replayed trace (always in Enforce mode): G1–G4 can block it
// before it reaches the data, G5/G6 check what it read and claims, and G7
// writes what it did to the Audit Trail as "agent:claude". A blocked call is
// returned to the agent as an error so it can ask the reviewer instead.
//
// Calls go from the browser straight to api.anthropic.com with the
// reviewer's own key (kept only in this tab's sessionStorage, if they opt
// in). The SDK is loaded from the CDN on first use; the rest of the app
// works without it.

import * as controller from "../src/ui/appController.js";
import { classifyTool } from "../src/core/agentTrace.js";
import { POLICIES } from "../src/core/agentPolicy.js";
import { TABLES } from "../src/core/sqlView.js";
import { createReplayEngine } from "../src/ui/replay/replayEngine.js";
import { h, clear, session, toast } from "./dom.js";
import { emit, on, shell, fetchText, runSql } from "./bus.js";
import { renderOutcome, focusOutcome } from "./feed.js";
import { afterApprove } from "./data.js";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
const ACTOR = "agent:claude";
const MAX_TURNS = 14;
const MAX_ROWS_TO_AGENT = 100;

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
// Server-side refusal fallback is available on Opus/Sonnet, not Haiku.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

const SUGGESTIONS = [
  "What's blocking the Group view right now?",
  "Reconcile what you safely can, and tell me what needs my decision.",
  "Where do we have cross-Maison sourcing leverage?",
];

// ---------------------------------------------------------------------------
// Prompt and tools (kept byte-stable so the prefix caches).
// ---------------------------------------------------------------------------

const SCHEMA = Object.entries(TABLES).map(([t, cols]) => "- " + t + "(" + cols.join(", ") + ")").join("\n");

const SYSTEM = `You are a reconciliation agent inside LVMH's governed procure-to-pay information layer. Louis Vuitton (LV), Dior (DIOR) and Fendi (FENDI) keep their own ERP supplier and account codes; the layer maps them to LVMH supplier ids and account codes so spend is comparable in one Group view, in EUR.

You work with a finance reviewer who is chatting with you. You read data with query_sql (SQLite, read-only) and change it only through the governed tools. Every call passes a policy gateway before it touches the data:
- G1 Tool scope: read with a single SELECT; you cannot load data, delete mappings or change settings.
- G2 Evidence for mappings: approve_mapping is allowed only when the recommender suggested exactly those LVMH codes (exception_queue.recommendation_status = 'SUGGESTED', with suggested_lvmh_supplier_id and suggested_lvmh_account_code), or when the reviewer confirmed that exact pairing, naming the LVMH supplier id and the local supplier code, in this conversation. Otherwise propose the mapping in plain words, name both codes and your evidence, and ask.
- G3 Override authority: resolve_exception clears a validation exception (duplicate PO, missing goods receipt, price or quantity variance) as-is. It needs a written reason and the reviewer's explicit sign-off naming that invoice or PO. When a record needs correction, use hold_exception.
- G4 Hard controls: the app rejects conflicting mappings and overrides of records with no mapping, whoever asks.
- G5/G6: what you report is checked against the data. Quote figures only from query results you received in this conversation.
- G7: every action you take is recorded in the audit trail as ${ACTOR}.
A blocked call comes back as an error that says why. Do not retry it unchanged; tell the reviewer what is missing.

Tables:
${SCHEMA}

How to work: query before you act. Approving one mapping re-normalizes every queued record with the same local codes, so afterwards check what was consolidated and what went back to the queue for validation. Keep messages short: a few sentences or a compact list. Refer to records by invoice ref and exception id, amounts in EUR.`;

const str = (description) => ({ type: "string", description });

const TOOLS = [
  {
    name: "query_sql",
    description: "Run one read-only SQLite SELECT (or WITH ... SELECT) against a fresh copy of the governed data and get the rows back as JSON. Up to 100 rows are returned.",
    input_schema: { type: "object", properties: { query: str("A single SELECT statement.") }, required: ["query"] },
  },
  {
    name: "approve_mapping",
    description: "Approve a mapping from a NO_MAPPING exception's local supplier/account codes to LVMH codes. All queued records with the same local codes are then re-normalized, validated and consolidated. Subject to policy G2.",
    input_schema: {
      type: "object",
      properties: {
        exception_id: str("exception_queue.exception_id of a NO_MAPPING record."),
        lvmh_supplier_id: str("Target LVMH supplier id, e.g. LVMH-SUP-000457."),
        lvmh_account_code: str("Target LVMH account code, e.g. ACCT-6110."),
      },
      required: ["exception_id", "lvmh_supplier_id", "lvmh_account_code"],
    },
  },
  {
    name: "hold_exception",
    description: "Put an exception on hold for correction with a reason. It stays in the queue (moved to the back) until someone fixes the source data.",
    input_schema: { type: "object", properties: { exception_id: str("exception_queue.exception_id"), reason: str("Why it is held and what needs correcting.") }, required: ["exception_id", "reason"] },
  },
  {
    name: "resolve_exception",
    description: "Clear a validation exception by override: the record is accepted as-is and consolidated. Subject to policy G3 (needs the reviewer's sign-off for that invoice or PO in this conversation).",
    input_schema: { type: "object", properties: { exception_id: str("exception_queue.exception_id"), reason: str("What was verified, in a full sentence.") }, required: ["exception_id", "reason"] },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

const REQUIRED = Object.fromEntries(TOOLS.map((t) => [t.name, t.input_schema.required]));

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

const live = {
  key: session.get("v2.apiKey") || "",
  model: session.get("v2.model") || MODELS[0].id,
  client: null,
  sdk: null,
  messages: [],
  steps: [],
  engine: null,
  running: false,
  abort: null,
  notes: [], // reviewer actions taken in the app, mentioned on the next turn
};

let root = null;
let ui = null;

export function mountLive(container) {
  root = container;
  on("ask", ({ text }) => {
    if (!ui || !ui.input) return;
    ui.input.value = text;
    ui.input.focus();
  });
  on("mode", () => syncComposer());
  render();
}

function render() {
  if (!live.key) renderSetup();
  else renderChat();
}

// ---------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------

function renderSetup() {
  ui = null;
  const key = h("input.input.is-mono", { type: "password", placeholder: "sk-ant-…", autocomplete: "off", "aria-label": "Anthropic API key" });
  const remember = h("input", { type: "checkbox" });
  const model = modelSelect();
  const go = () => {
    const v = key.value.trim();
    if (!v) { key.focus(); return; }
    live.key = v;
    live.client = null;
    if (remember.checked) session.set("v2.apiKey", v);
    render();
  };
  key.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  clear(root).append(h("div.setup",
    h("h3.setup__h", "Work with a live agent"),
    h("p", "Claude reads the governed data through read-only SQL and acts through the governed tools. Every call passes the G1–G7 policy first; blocked calls never reach the data, and everything it does lands in the audit trail as ", h("code", ACTOR), "."),
    h("label.field", h("span", "Anthropic API key"), key),
    h("label.check", remember, " Remember for this browser tab"),
    h("label.field", h("span", "Model"), model),
    h("button.btn.btn--primary.btn--block", { type: "button", onclick: go }, "Start"),
    h("p.muted.small", "The key goes from this page straight to api.anthropic.com and is never stored beyond this tab. Fine for a demo; production would proxy calls through a server that holds the key."),
    h("p.muted.small", "No key? The Replay tab shows recorded agents going through the same gateway.")));
}

function modelSelect() {
  const sel = h("select.select", { "aria-label": "Model" }, ...MODELS.map((m) => h("option", { value: m.id, selected: m.id === live.model }, m.label)));
  sel.addEventListener("change", () => { live.model = sel.value; session.set("v2.model", sel.value); });
  return sel;
}

// ---------------------------------------------------------------------------
// Chat.
// ---------------------------------------------------------------------------

function renderChat() {
  ui = {};
  ui.feed = h("div.feed", { "aria-live": "polite" });
  ui.input = h("textarea.composer__input", { rows: "2", placeholder: "Ask the agent… (Enter to send, Shift+Enter for a new line)" });
  ui.send = h("button.btn.btn--primary", { type: "button", onclick: () => send() }, "Send");
  ui.stop = h("button.btn", { type: "button", hidden: true, onclick: () => live.abort && live.abort.abort() }, "Stop");
  ui.status = h("span.live-status");
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  clear(root).append(h("div.chat",
    h("div.chat__bar", modelSelect(), ui.status,
      h("button.linkbtn", { type: "button", onclick: newChat, title: "Start a new conversation (the data stays as it is)" }, "New chat"),
      h("button.linkbtn", { type: "button", onclick: forgetKey }, "Change key")),
    ui.feed,
    h("div.composer", ui.input, h("div.composer__btns", ui.stop, ui.send))));
  redrawFeed();
  syncComposer();
}

function newChat() {
  if (live.running) return;
  live.messages = [];
  live.steps = [];
  live.engine = null;
  live.notes = [];
  extras.clear();
  redrawFeed();
}

function forgetKey() {
  if (live.running) return;
  session.del("v2.apiKey");
  live.key = "";
  live.client = null;
  render();
}

function syncComposer() {
  if (!ui || !ui.send) return;
  const locked = shell.replaying;
  ui.input.disabled = locked;
  ui.send.disabled = locked || live.running;
  ui.send.hidden = live.running;
  ui.stop.hidden = !live.running;
  ui.status.textContent = locked ? "Paused while a replay owns the data" : live.running ? "Working…" : "";
  ui.status.dataset.state = live.running ? "busy" : "";
}

/** Rendered outcomes, keyed by step index, so reviewer buttons survive redraws. */
const extras = new Map();

function redrawFeed() {
  if (!ui) return;
  clear(ui.feed);
  const outcomes = live.engine ? live.engine.outcomes.filter(Boolean) : [];
  if (outcomes.length === 0) {
    ui.feed.append(h("div.empty",
      h("p.empty__lead", "Ask about the data, or let the agent work the queue. You decide anything the policy reserves for a person."),
      h("div.suggest", ...SUGGESTIONS.map((t) => h("button.suggest__btn", { type: "button", onclick: () => send(t) }, t)))));
    return;
  }
  for (const o of outcomes) ui.feed.append(renderOutcome(o, { extra: extras.get(o.index) }));
  scrollFeed();
}

function scrollFeed() {
  ui.feed.scrollTop = ui.feed.scrollHeight;
}

function appendOutcome(o) {
  if (!ui) return;
  const empty = ui.feed.querySelector(".empty");
  if (empty) empty.remove();
  ui.feed.append(renderOutcome(o, { extra: extras.get(o.index) }));
  scrollFeed();
}

function ensureEngine() {
  if (live.engine) return live.engine;
  live.steps = [];
  live.engine = createReplayEngine({
    steps: live.steps,
    ops: controller,
    reset: async () => {}, // never seeks: a live session only moves forward
    getState: controller.getState,
    fetchText,
    sql: runSql,
    enforce: true,
    actor: ACTOR,
  });
  return live.engine;
}

/** Push one step and run it through the gateway. */
async function runStep(step) {
  const engine = ensureEngine();
  live.steps.push(step);
  const plan = await engine.prepare();
  const o = await engine.commit(plan);
  return { o, plan };
}

// ---------------------------------------------------------------------------
// Agent loop.
// ---------------------------------------------------------------------------

async function getClient() {
  if (live.client) return live.client;
  if (!live.sdk) {
    try { live.sdk = await import(SDK_URL); }
    catch (err) { throw new Error("Could not load the Anthropic SDK from the CDN (offline?): " + err.message); }
  }
  const Anthropic = live.sdk.default;
  live.client = new Anthropic({ apiKey: live.key, dangerouslyAllowBrowser: true });
  return live.client;
}

async function send(textArg) {
  if (live.running || shell.replaying) return;
  const text = String(textArg ?? (ui && ui.input.value) ?? "").trim();
  if (!text) return;
  if (ui) ui.input.value = "";

  live.running = true;
  live.abort = new AbortController();
  syncComposer();

  try {
    const { o } = await runStep({ kind: "narration", role: "user", text });
    appendOutcome(o);
    const notes = live.notes.splice(0);
    const content = notes.length ? "[In the app, the reviewer: " + notes.join(" ") + "]\n\n" + text : text;
    live.messages.push({ role: "user", content });
    await agentLoop();
  } catch (err) {
    showError(err);
  } finally {
    live.running = false;
    live.abort = null;
    removeStreaming();
    syncComposer();
  }
}

async function agentLoop() {
  const client = await getClient();
  const Anthropic = live.sdk.default;
  let jsonRetries = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const params = {
      model: live.model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages: live.messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
    };
    const withFallback = FALLBACK_MODELS.has(live.model);
    const stream = withFallback
      ? client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal: live.abort.signal })
      : client.messages.stream(params, { signal: live.abort.signal });

    const bubble = streamingBubble();
    stream.on("text", (delta) => { bubble.text.textContent += delta; bubble.node.hidden = false; scrollFeed(); });

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      removeStreaming();
      // With eager input streaming an unparseable tool input rejects here;
      // only that is retried. API errors (and aborts) go up.
      if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIUserAbortError || jsonRetries++ >= 2) throw err;
      continue;
    }
    removeStreaming();

    // Keep the full content (thinking, fallback blocks) so the next request
    // replays the conversation exactly.
    live.messages.push({ role: "assistant", content: message.content });

    const toolUses = [];
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
        appendOutcome((await runStep({ kind: "narration", role: "thinking", text: block.thinking.trim() })).o);
      } else if (block.type === "text" && block.text.trim()) {
        const { o } = await runStep({ kind: "narration", role: "agent", text: block.text.trim() });
        appendOutcome(o);
        emit("changed");
      } else if (block.type === "tool_use") {
        toolUses.push(block);
      }
    }

    if (message.stop_reason === "refusal") {
      notice("The model declined to continue (" + ((message.stop_details && message.stop_details.category) || "refusal") + ").");
      closeToolUses(toolUses, "Turn ended by refusal; not executed.");
      return;
    }
    if (toolUses.length === 0) return;
    if (message.stop_reason === "max_tokens") {
      notice("The response hit the length limit while writing a tool call; nothing was executed.");
      closeToolUses(toolUses, "Tool input was cut off at max_tokens; not executed.");
      return;
    }

    const results = [];
    for (const block of toolUses) results.push(await runTool(block));
    live.messages.push({ role: "user", content: results });
  }
  notice("Stopped after " + MAX_TURNS + " model turns. Send a message to continue.");
}

/** Answer tool_use blocks that will not run, so the history stays valid. */
function closeToolUses(blocks, why) {
  if (!blocks.length) return;
  live.messages.push({ role: "user", content: blocks.map((b) => ({ type: "tool_result", tool_use_id: b.id, is_error: true, content: why })) });
}

async function runTool(block) {
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const missing = (REQUIRED[block.name] || []).filter((k) => typeof input[k] !== "string" || input[k].trim() === "");
  if (missing.length) {
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: "Invalid input: missing " + missing.join(", ") + ". Received " + JSON.stringify(input) };
  }

  const cls = classifyTool(block.name, input);
  const step = { kind: cls.kind, op: cls.op || null, route: cls.route || null, tool: block.name, toolUseId: block.id, input, traceResult: null, timestamp: new Date().toISOString() };
  const { o, plan } = await runStep(step);

  const extra = reviewerActions(o, plan);
  if (extra) extras.set(o.index, extra);
  appendOutcome(o);
  emit("changed");
  focusOutcome(o);

  const text = resultText(o);
  live.engine.ground(text);
  return { type: "tool_result", tool_use_id: block.id, is_error: o.status !== "ok", content: text };
}

function resultText(o) {
  if (o.status === "blocked") {
    const blocks = o.findings.filter((f) => f.severity === "block");
    const why = blocks.map((f) => "BLOCKED by policy " + f.policy + " (" + (POLICIES[f.policy] ? POLICIES[f.policy].name : "") + "): " + f.message).join("\n");
    return why + "\nThe call did not reach the governed data.";
  }
  if (o.status !== "ok") return "ERROR: " + (o.message || o.status);
  const r = o.result;
  if (o.step.op === "querySql" && r && Array.isArray(r.rows)) {
    const rows = r.rows.slice(0, MAX_ROWS_TO_AGENT);
    const more = r.rows.length > rows.length || r.truncated ? "\n(" + r.rows.length + (r.truncated ? "+" : "") + " rows; showing the first " + rows.length + ". Aggregate or filter for the rest.)" : "";
    return JSON.stringify(rows) + more;
  }
  const out = { ok: true, message: o.message, data_now: o.after };
  if (r && typeof r === "object") {
    for (const k of ["resolvedCount", "requeuedCount", "requeued", "failedCount"]) if (r[k] !== undefined) out[k] = r[k];
  }
  return JSON.stringify(out);
}

/** On a blocked or flagged call, give the reviewer a one-click way to decide. */
function reviewerActions(o, plan) {
  if (o.status !== "blocked" || !plan || !plan.subject) return null;
  const subj = plan.subject;
  const exc = subj.exception;
  const row = h("div.tool__actions");
  if ((subj.op === "approveMapping" || subj.op === "addMapping") && subj.draft) {
    const d = subj.draft;
    const btn = h("button.btn.btn--small.btn--primary", {
      type: "button",
      onclick: () => {
        if (shell.replaying) { toast("Exit the replay first.", "error"); return; }
        const res = exc ? controller.approveMapping(exc.id, { ...d, origin: "manual" }, shell.reviewer()) : controller.addMapping({ ...d, origin: "manual" }, shell.reviewer());
        if (afterApprove(res)) {
          live.notes.push("approved mapping " + d.maisonId + " " + d.localSupplierCode + "/" + d.localAccountCode + " → " + d.lvmhSupplierId + "/" + d.lvmhAccountCode + " themselves (" + res.resolvedCount + " consolidated, " + (res.requeuedCount || 0) + " re-queued).");
          btn.disabled = true;
          btn.textContent = "Approved by you";
        }
      },
    }, "Approve " + d.localSupplierCode + " → " + d.lvmhSupplierId + " as reviewer");
    row.append(btn);
  }
  if (exc) row.append(h("button.btn.btn--small", { type: "button", onclick: () => emit("select", { table: "exception_queue", key: exc.id }) }, "Open record"));
  return row.childElementCount ? row : null;
}

// ---------------------------------------------------------------------------
// Feed helpers.
// ---------------------------------------------------------------------------

function streamingBubble() {
  removeStreaming();
  const text = h("div.msg__text");
  const node = h("div.msg.msg--agent.is-streaming", { hidden: true }, h("div.msg__who", "Agent"), text);
  const dots = h("div.typing", { "aria-label": "Agent is working" }, h("span"), h("span"), h("span"));
  if (ui) { ui.feed.append(node, dots); scrollFeed(); }
  return { node, text };
}

function removeStreaming() {
  if (!ui) return;
  for (const n of ui.feed.querySelectorAll(".is-streaming, .typing")) n.remove();
}

function notice(text, tone = "warn") {
  if (!ui) return;
  ui.feed.append(h("div.sysline", { "data-tone": tone }, text));
  scrollFeed();
}

function showError(err) {
  const A = live.sdk && live.sdk.default;
  let msg = (err && err.message) || String(err);
  if (A && err instanceof A.APIUserAbortError) { notice("Stopped.", "info"); return; }
  if (A && err instanceof A.AuthenticationError) msg = "The API key was rejected. Use “Change key” to enter another.";
  else if (A && err instanceof A.PermissionDeniedError) msg = "This key can't use " + live.model + ": " + err.message;
  else if (A && err instanceof A.RateLimitError) msg = "Rate limited. Wait a moment and send again.";
  else if (A && err instanceof A.APIConnectionError) msg = "Couldn't reach api.anthropic.com: " + err.message;
  else if (A && err instanceof A.APIError) msg = "API error " + (err.status || "") + ": " + err.message;
  notice(msg, "error");
}
