// v2/feed.js — renders replay-engine outcomes as a conversation: messages,
// thinking, and tool-call cards with the policy verdict, findings, a preview
// of what the call returned, and the before/after deltas on the data.
// Replay and the live agent both produce engine outcomes, so they share this.

import { POLICIES } from "../src/core/agentPolicy.js";
import { h, fmt, humanize } from "./dom.js";
import { emit } from "./bus.js";

const ROUTE_TABLE = { "#exceptions": "exception_queue", "#mappings": "mapping_table", "#report": "consolidated_records", "#sourcing": "consolidated_records" };

const VERDICT = {
  blocked: { label: "Blocked", icon: "⛔" },
  "would-block": { label: "Would be blocked", icon: "⚠" },
  rejected: { label: "Rejected by app", icon: "✋" },
  flagged: { label: "Flagged", icon: "⚑" },
  passed: { label: "Passed policy", icon: "✓" },
  ok: { label: "Executed", icon: "✓" },
  error: { label: "Error", icon: "!" },
  skipped: { label: "Not run", icon: "–" },
};

const OP_LABEL = {
  querySql: "query_sql",
  describeSchema: "describe_schema",
  approveMapping: "approve_mapping",
  addMapping: "add_mapping",
  resolveException: "override_exception",
  rejectResolution: "hold_exception",
  deleteMapping: "delete_mapping",
  loadExtract: "load_extract",
  loadFinanceExtract: "load_finance_extract",
};

/**
 * @param {Object} o        an engine outcome
 * @param {Object} [opts]
 * @param {Node}   [opts.extra]   appended to the card (e.g. reviewer actions)
 * @param {boolean} [opts.active] current replay step
 */
export function renderOutcome(o, opts = {}) {
  const step = o.step;
  let node;
  if (step.kind === "narration") node = narration(o);
  else if (step.kind === "setup") node = setupLine(o);
  else node = toolCard(o, opts);
  node.dataset.index = String(o.index);
  if (opts.active) node.classList.add("is-active");
  return node;
}

function narration(o) {
  const { role, text } = o.step;
  if (role === "thinking") {
    return h("details.thinking", h("summary", "Thinking"), h("div.thinking__text", text));
  }
  const flags = o.findings.filter((f) => f.severity !== "pass" && f.severity !== "info");
  return h("div.msg", { class: role === "user" ? "msg--user" : "msg--agent" },
    h("div.msg__who", role === "user" ? "You" : "Agent"),
    h("div.msg__text", text),
    flags.length ? findingsList(flags) : null);
}

function setupLine(o) {
  return h("div.sysline", h("span.sysline__tag", "Reviewer"), " ", o.message || "Setup step", o.status === "error" ? h("span.is-error", " (failed)") : null);
}

function toolCard(o, opts) {
  const step = o.step;
  const gov = o.status === "blocked" ? "blocked" : o.governance || (o.status === "ok" ? "ok" : o.status);
  const verdict = VERDICT[gov] || VERDICT[o.status] || { label: o.status, icon: "·" };
  const name = OP_LABEL[step.op] || humanize(step.tool) || "tool";
  const input = step.input || {};
  const sql = step.op === "querySql" ? String(input.query ?? input.sql ?? input.statement ?? "") : null;

  const card = h("article.tool", { "data-gov": gov, tabindex: "0" },
    h("header.tool__head",
      h("span.tool__icon", { "aria-hidden": "true" }, step.op === "querySql" ? "⌕" : step.kind === "observe" ? "◉" : "⚙"),
      h("span.tool__name", name),
      step.kind === "unsupported" ? h("span.tool__raw", humanize(step.tool)) : null,
      h("span.verdict", { "data-gov": gov }, verdict.icon + " " + verdict.label)),
    sql ? h("pre.code.tool__sql", sql) : argList(input),
    o.message ? h("p.tool__msg", o.message) : null,
    o.findings.length ? findingsList(o.findings) : null,
    o.notes && o.notes.length ? h("ul.notes", ...o.notes.map((n) => h("li", n))) : null,
    o.diverged ? h("p.tool__diverge", "↯ " + o.diverged) : null,
    resultPreview(o),
    deltaRow(o.delta),
    step.traceResult && step.traceResult.text ? h("details.saw", h("summary", "What the agent saw in its original run"), h("pre.code", clip(step.traceResult.text, 1600))) : null,
    opts.extra || null);

  const focus = () => focusOutcome(o);
  card.addEventListener("click", (e) => { if (!e.target.closest("button, a, summary, input, textarea")) focus(); });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === card) focus(); });
  return card;
}

function argList(input) {
  const entries = Object.entries(input || {});
  if (!entries.length) return null;
  return h("dl.args", ...entries.map(([k, v]) => [h("dt", humanize(k)), h("dd", typeof v === "object" ? JSON.stringify(v) : String(v))]));
}

function findingsList(findings) {
  return h("ul.findings", ...findings.map((f) => h("li.finding", { "data-sev": f.severity },
    h("span.pchip", { "data-policy": f.policy, title: POLICIES[f.policy] ? POLICIES[f.policy].name + ": " + POLICIES[f.policy].rule : "" }, f.policy),
    h("span.finding__sev", sevLabel(f.severity)),
    h("span.finding__msg", f.message))));
}

function sevLabel(s) {
  return { block: "blocked", "would-block": "would block", flag: "flag", pass: "pass", info: "note" }[s] || s;
}

function resultPreview(o) {
  const r = o.result;
  if (!r || !Array.isArray(r.rows) || !Array.isArray(r.columns)) return null;
  const cols = r.columns.slice(0, 5);
  const rows = r.rows.slice(0, 5);
  return h("div.preview",
    h("table.mini", h("thead", h("tr", ...cols.map((c) => h("th", humanize(c))))),
      h("tbody", ...rows.map((row) => h("tr", ...cols.map((c) => {
        const v = row[c];
        return h("td", { class: typeof v === "number" ? "is-num" : "" }, v == null ? "—" : typeof v === "number" ? fmt.num(v) : clip(String(v), 28));
      }))))),
    h("button.linkbtn", { type: "button", onclick: () => focusOutcome(o) },
      r.rows.length > rows.length ? "Open all " + r.rows.length + " rows in the grid →" : "Open in the grid →"));
}

function deltaRow(d) {
  if (!d) return null;
  const items = [];
  const add = (k, label, f = fmt.num) => { if (d[k]) items.push(h("span.delta", { "data-sign": d[k] > 0 ? "up" : "down", "data-k": k }, fmt.signed(d[k], f) + " " + label)); };
  add("consolidated", "consolidated");
  add("exceptions", "exceptions");
  add("mappings", "mappings");
  add("audit", "audit");
  add("spendEur", "spend", (x) => fmt.eur(x));
  return items.length ? h("div.deltas", ...items) : null;
}

/** Show where a step landed in the data grid. */
export function focusOutcome(o) {
  const step = o.step;
  const r = o.result;
  if (step.op === "querySql" && r && Array.isArray(r.rows)) {
    emit("show", { sql: String((step.input || {}).query ?? (step.input || {}).sql ?? ""), result: r, by: "agent", label: "step " + (o.index + 1), focus: tag(o.focusAfter, "focus") });
    return;
  }
  const blocked = o.status === "blocked" || o.governance === "would-block";
  const route = blocked ? o.beforeRoute : o.afterRoute || o.beforeRoute;
  const table = ROUTE_TABLE[route];
  if (!table) return;
  const focus = blocked ? tag(o.focusBefore, "blocked") : (o.focusAfter && o.focusAfter.length ? tag(o.focusAfter, "changed") : tag(o.focusBefore, "focus"));
  emit("show", { table, focus });
}

function tag(list, tone) {
  return (list || []).map((f) => ({ id: f.id, tone }));
}

/** Governance summary card (replay end, or on demand). */
export function renderReport(rep, onJump) {
  const stat = (n, label, tone) => h("div.rstat", { "data-tone": tone }, h("span.rstat__n", String(n)), h("span.rstat__l", label));
  const items = rep.findings.map((f) => h("li.finding", { "data-sev": f.severity },
    h("button.linkbtn", { type: "button", onclick: () => onJump && onJump(f.index) }, "#" + (f.index + 1)),
    h("span.pchip", { "data-policy": f.policy }, f.policy),
    h("span.finding__msg", f.message)));
  return h("section.report",
    h("h3.report__h", "Governance report", h("span.mode-pill", { "data-mode": rep.enforce ? "enforce" : "observe" }, rep.enforce ? "Enforce" : "Observe")),
    h("div.rstats",
      stat(rep.executed, "executed", "ok"),
      stat(rep.blocked, "blocked", "block"),
      stat(rep.rejectedByApp, "rejected by app", "warn"),
      stat(rep.wouldBlock, "would block", "warn"),
      stat(rep.flagged, "flagged", "flag")),
    h("p.report__final", "Data now: " + rep.final.consolidated + " consolidated · " + rep.final.exceptions + " exceptions · " + rep.final.mappings + " mappings · " + fmt.eur(rep.final.spendEur) + " Group spend"),
    items.length ? h("ul.findings", ...items) : h("p.muted", "No policy findings: nothing blocked or flagged."));
}

function clip(s, n) {
  const t = String(s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
