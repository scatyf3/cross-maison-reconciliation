// v2/data.js — the data workspace: KPI strip, table rail, SQL console,
// result grid and row inspector. Reviewer actions (approve, hold, override,
// delete, load) go through the same controller operations as v1, so they
// are validated and written to the Audit Trail exactly the same way.

import * as controller from "../src/ui/appController.js";
import { buildTables, TABLES, NUMERIC, checkReadOnly } from "../src/core/sqlView.js";
import { POLICIES } from "../src/core/agentPolicy.js";
import { detectFinanceFormat } from "../src/core/financeAdapter.js";
import { h, clear, fmt, humanize, toast } from "./dom.js";
import { emit, on, shell, runSql } from "./bus.js";

// ---------------------------------------------------------------------------
// Static config.
// ---------------------------------------------------------------------------

const TABLE_META = {
  exception_queue: { label: "Exception queue", key: "exception_id", hint: "Records that need a decision" },
  consolidated_records: { label: "Consolidated records", key: "processing_id", hint: "In the Group view, in EUR" },
  mapping_table: { label: "Mapping table", key: "mapping_id", hint: "Governed local → LVMH codes" },
  audit_trail: { label: "Audit trail", key: "seq", hint: "Every governed change" },
};

const DEFAULT_COLUMNS = {
  exception_queue: ["exception_id", "maison", "invoice_ref", "local_supplier_code", "local_account_code", "reason", "status", "recommendation_status", "recommendation_confidence", "suggested_lvmh_supplier_id"],
  consolidated_records: ["maison", "invoice_ref", "lvmh_supplier_id", "lvmh_account_code", "local_supplier_code", "quantity", "unit_price", "currency", "spend_eur", "resolved_via"],
  mapping_table: ["mapping_id", "maison", "local_supplier_code", "local_account_code", "lvmh_supplier_id", "lvmh_account_code", "origin", "approved_by", "approved_at"],
  audit_trail: ["seq", "actor", "action", "prompted_by_processing_id", "timestamp"],
};

export const SAVED_VIEWS = [
  { label: "Queue by Maison & reason", sql: "SELECT maison, reason, status, COUNT(*) AS n\nFROM exception_queue\nGROUP BY maison, reason, status\nORDER BY maison, n DESC" },
  { label: "Recommender near-misses", sql: "SELECT exception_id, maison, local_supplier_code, local_account_code,\n       recommendation_status, recommendation_confidence, suggested_lvmh_supplier_id\nFROM exception_queue\nWHERE reason = 'NO_MAPPING'\nORDER BY recommendation_confidence DESC" },
  { label: "Spend by LVMH supplier", sql: "SELECT lvmh_supplier_id,\n       COUNT(DISTINCT maison) AS maisons,\n       COUNT(*) AS lines,\n       ROUND(SUM(spend_eur), 2) AS spend_eur\nFROM consolidated_records\nGROUP BY lvmh_supplier_id\nORDER BY spend_eur DESC" },
  { label: "Cross-Maison leverage", sql: "SELECT lvmh_supplier_id,\n       GROUP_CONCAT(DISTINCT maison) AS maisons,\n       ROUND(SUM(spend_eur), 2) AS spend_eur\nFROM consolidated_records\nGROUP BY lvmh_supplier_id\nHAVING COUNT(DISTINCT maison) > 1\nORDER BY spend_eur DESC" },
  { label: "Spend by Maison", sql: "SELECT maison, COUNT(*) AS lines, ROUND(SUM(spend_eur), 2) AS spend_eur\nFROM consolidated_records\nGROUP BY maison\nORDER BY spend_eur DESC" },
  { label: "Who changed what", sql: "SELECT actor, action, COUNT(*) AS n\nFROM audit_trail\nGROUP BY actor, action\nORDER BY n DESC" },
];

const CHIP_COLUMNS = new Set(["maison", "reason", "status", "recommendation_status", "resolved_via", "action", "origin", "currency"]);
const BAR_COLUMNS = /^(recommendation_confidence|n|lines)$|spend/;
const MONO_COLUMNS = /(_id|_ref|_code|^seq$)/;

// ---------------------------------------------------------------------------
// Workspace state.
// ---------------------------------------------------------------------------

const view = {
  // { kind: "table", table } | { kind: "sql", sql, result, by: "you"|"agent", label }
  source: { kind: "table", table: "exception_queue" },
  allColumns: false,
  sort: null, // { col, dir: 1|-1 }
  filter: "",
  focus: new Map(), // key -> "focus" | "blocked" | "changed"
  selected: null, // { table, key }
  error: null,
  running: false,
};

let els = null;
let prevKpis = null;

export function mountData(root) {
  els = {
    kpis: root.querySelector("#kpis"),
    rail: root.querySelector("#rail"),
    editor: root.querySelector("#sql-editor"),
    runBtn: root.querySelector("#sql-run"),
    sourceLabel: root.querySelector("#source-label"),
    status: root.querySelector("#grid-status"),
    filter: root.querySelector("#grid-filter"),
    colsToggle: root.querySelector("#grid-cols"),
    grid: root.querySelector("#grid"),
    inspector: root.querySelector("#inspector"),
  };

  els.runBtn.addEventListener("click", () => runEditor());
  els.editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runEditor(); }
  });
  els.filter.addEventListener("input", () => { view.filter = els.filter.value; renderGrid(); });
  els.colsToggle.addEventListener("click", () => { view.allColumns = !view.allColumns; renderGrid(); });

  on("changed", () => { renderKpis(); renderRail(); refreshSource(); renderInspector(); });
  on("show", (d) => show(d));
  on("select", (d) => { view.selected = d; renderGrid(); renderInspector(); });
  on("mode", () => { renderRail(); renderInspector(); });

  showTable("exception_queue");
  renderKpis();
  renderRail();
  renderInspector();
}

// ---------------------------------------------------------------------------
// KPIs.
// ---------------------------------------------------------------------------

function kpiValues() {
  const s = controller.getState();
  const report = controller.buildCurrentReport();
  const queue = s.exceptionQueue || [];
  return {
    spend: report.totalSpendEur || 0,
    consolidated: (s.consolidated || []).length,
    open: queue.length,
    held: queue.filter((e) => e && e.status === "on_hold_for_correction").length,
    mappings: (s.mappingTable || []).filter((m) => m && m.status === "approved").length,
    audit: (s.auditTrail || []).length,
    agent: (s.auditTrail || []).filter((a) => /^agent/i.test(a.actor || "")).length,
  };
}

function renderKpis() {
  const v = kpiValues();
  const prev = prevKpis;
  prevKpis = v;
  const tile = (key, label, value, sub, opts = {}) => {
    const delta = prev && prev[key] !== v[key] ? v[key] - prev[key] : 0;
    return h("button.kpi", {
      type: "button",
      title: opts.title || "",
      onclick: opts.onclick,
      class: delta ? "is-changed" : "",
    },
    h("span.kpi__label", label),
    h("span.kpi__value", value),
    sub ? h("span.kpi__sub", sub) : null,
    delta ? h("span.kpi__delta", { "data-sign": (key === "open" ? -delta : delta) > 0 ? "up" : "down" }, key === "spend" ? fmt.signed(delta, (x) => fmt.eur(x)) : fmt.signed(delta)) : null);
  };
  clear(els.kpis).append(
    tile("spend", "Group spend", fmt.eur(v.spend), "consolidated, EUR", { onclick: () => runSaved(SAVED_VIEWS[2]) }),
    tile("consolidated", "Consolidated", fmt.num(v.consolidated), "lines in Group view", { onclick: () => showTable("consolidated_records") }),
    tile("open", "Exceptions", fmt.num(v.open), v.held ? v.held + " on hold" : "need a decision", { onclick: () => showTable("exception_queue") }),
    tile("mappings", "Mappings", fmt.num(v.mappings), "approved", { onclick: () => showTable("mapping_table") }),
    tile("audit", "Audit entries", fmt.num(v.audit), v.agent ? v.agent + " by an agent" : "governed changes", { onclick: () => showTable("audit_trail") }),
  );
}

// ---------------------------------------------------------------------------
// Rail: tables, saved views, sources, policies.
// ---------------------------------------------------------------------------

function renderRail() {
  const tables = buildTables(controller.getState());
  const current = view.source.kind === "table" ? view.source.table : null;

  const tableList = h("ul.rail__list");
  for (const [name, meta] of Object.entries(TABLE_META)) {
    tableList.append(h("li", h("button.rail__item", {
      type: "button",
      class: current === name ? "is-active" : "",
      title: meta.hint,
      onclick: () => showTable(name),
    }, h("span.rail__icon", { "aria-hidden": "true" }, "▦"), h("span.rail__name", name), h("span.rail__count", String(tables[name].length)))));
  }

  const views = h("ul.rail__list");
  for (const v of SAVED_VIEWS) {
    views.append(h("li", h("button.rail__item", {
      type: "button",
      class: view.source.kind === "sql" && view.source.sql === v.sql ? "is-active" : "",
      onclick: () => runSaved(v),
    }, h("span.rail__icon", { "aria-hidden": "true" }, "ƒ"), h("span.rail__name.is-plain", v.label))));
  }

  const policies = h("ul.policy-list");
  for (const p of Object.values(POLICIES)) {
    policies.append(h("li.policy-list__item", { title: p.rule },
      h("span.pchip", { "data-policy": p.id }, p.id),
      h("span", p.name),
      h("span.policy-list__layer", p.layer)));
  }

  clear(els.rail).append(
    h("section.rail__section", h("h2.rail__h", "Tables"), tableList),
    h("section.rail__section", h("h2.rail__h", "Saved queries"), views),
    sourcesSection(),
    h("section.rail__section", h("h2.rail__h", "Agent policy"), policies,
      h("p.rail__note", "Every agent tool call passes G1–G4 before it reaches the data; G5–G6 check what it saw and said; G7 attributes it.")),
  );
}

function sourcesSection() {
  const s = controller.getState();
  const present = new Set([...(s.consolidated || []).map((r) => r.maisonId), ...(s.exceptionQueue || []).map((e) => e.maisonId)]);
  const list = h("ul.rail__list");
  for (const meta of s.seedExtractMeta || []) {
    const loaded = present.has(meta.id);
    list.append(h("li.srcitem", h("span.mchip", { "data-maison": meta.id }, meta.id), h("span.srcitem__name", meta.label || meta.id),
      loaded ? h("span.srcitem__state", "loaded") : h("button.linkbtn", {
        type: "button",
        disabled: shell.replaying,
        onclick: () => {
          const res = controller.loadExtract(meta.id, s.seedExtracts[meta.id]);
          emit("changed");
          toast("Loaded " + meta.id + ": " + res.consolidatedAdded + " consolidated, " + res.exceptionsAdded + " queued.");
        },
      }, "load")));
  }
  const file = h("input", { type: "file", accept: ".csv,text/csv,text/plain", hidden: true });
  const maison = h("select.select", { "aria-label": "Maison for a nine-column extract" },
    ...["LV", "DIOR", "FENDI"].map((m) => h("option", { value: m }, m)));
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const text = await f.text();
    file.value = "";
    let res;
    if (detectFinanceFormat(text)) {
      res = controller.loadFinanceExtract(text);
      if (res && res.ok === false) { toast(res.error, "error"); return; }
    } else {
      res = controller.loadExtract(maison.value, text);
    }
    emit("changed");
    const errs = res.parseErrors && res.parseErrors.length ? ", " + res.parseErrors.length + " rows rejected" : "";
    toast("Loaded " + f.name + ": " + (res.consolidatedAdded || 0) + " consolidated, " + (res.exceptionsAdded || 0) + " queued" + errs + ".");
  });
  return h("section.rail__section", h("h2.rail__h", "Sources"), list,
    h("div.source-load", maison, h("button.btn.btn--small", { type: "button", disabled: shell.replaying, onclick: () => file.click(), title: "Nine-column extract for the chosen Maison, or the 30-column finance export (detected)" }, "Load CSV…"), file),
    h("p.rail__note", "Loading data is a reviewer step; agents never load extracts (G1)."));
}

// ---------------------------------------------------------------------------
// Sources of the grid.
// ---------------------------------------------------------------------------

export function showTable(table, focus) {
  view.source = { kind: "table", table };
  view.sort = null;
  view.error = null;
  setFocus(focus);
  els.editor.value = "SELECT * FROM " + table;
  renderRail();
  renderGrid();
}

function show(d) {
  if (!d) return;
  if (d.table) { showTable(d.table, d.focus); return; }
  view.source = { kind: "sql", sql: d.sql, result: d.result, by: d.by || "you", label: d.label || null };
  view.sort = null;
  view.error = d.error || null;
  setFocus(d.focus);
  els.editor.value = d.sql || "";
  renderRail();
  renderGrid();
}

function setFocus(focus) {
  view.focus = new Map();
  for (const f of focus || []) if (f && f.id != null) view.focus.set(String(f.id), f.tone || "focus");
}

function runSaved(v) {
  els.editor.value = v.sql;
  runEditor(v.label);
}

async function runEditor(label) {
  const sql = els.editor.value.trim();
  if (!sql) return;
  const simple = /^select\s+\*\s+from\s+(\w+)\s*;?$/i.exec(sql);
  if (simple && TABLE_META[simple[1]]) { showTable(simple[1]); return; }
  const ro = checkReadOnly(sql);
  if (!ro.ok) {
    show({ sql, result: null, error: "Read-only console. " + ro.reason + " Change data through the inspector's governed actions instead.", label });
    return;
  }
  view.running = true;
  renderStatus();
  try {
    const t0 = performance.now();
    const result = await runSql(controller.getState(), sql);
    result.ms = Math.round(performance.now() - t0);
    show({ sql, result, by: "you", label });
  } catch (err) {
    show({ sql, result: null, error: (err && err.message) || String(err), label });
  } finally {
    view.running = false;
    renderStatus();
  }
}

/** Re-render after data changed: tables are live; your own query re-runs. */
async function refreshSource() {
  if (view.source.kind === "table") { renderGrid(); return; }
  if (view.source.by === "you" && view.source.result) {
    try {
      const result = await runSql(controller.getState(), view.source.sql);
      view.source = { ...view.source, result };
    } catch { /* keep the old result */ }
  }
  renderGrid();
}

// ---------------------------------------------------------------------------
// Grid.
// ---------------------------------------------------------------------------

function currentData() {
  if (view.source.kind === "table") {
    const t = view.source.table;
    const rows = buildTables(controller.getState())[t];
    const columns = view.allColumns ? TABLES[t] : DEFAULT_COLUMNS[t];
    return { columns, rows, table: t, curated: !view.allColumns };
  }
  const r = view.source.result;
  return { columns: r ? r.columns : [], rows: r ? r.rows : [], table: null, truncated: r && r.truncated };
}

function rowKey(row, table) {
  if (table) return String(row[TABLE_META[table].key]);
  for (const k of ["exception_id", "mapping_id", "processing_id"]) if (row[k] != null) return String(row[k]);
  return null;
}

function rowTarget(row, table) {
  if (table) return { table, key: String(row[TABLE_META[table].key]) };
  if (row.exception_id) return { table: "exception_queue", key: String(row.exception_id) };
  if (row.mapping_id) return { table: "mapping_table", key: String(row.mapping_id) };
  if (row.processing_id) {
    const s = controller.getState();
    if ((s.consolidated || []).some((r) => r.processingId === row.processing_id)) return { table: "consolidated_records", key: String(row.processing_id) };
    const exc = (s.exceptionQueue || []).find((e) => e.record && e.record.processingId === row.processing_id);
    if (exc) return { table: "exception_queue", key: exc.id };
  }
  return null;
}

function renderGrid() {
  const { columns, rows, table } = currentData();
  renderSourceLabel();
  els.colsToggle.hidden = !table;
  els.colsToggle.textContent = view.allColumns ? "Fewer columns" : "All columns";

  if (view.error) {
    clear(els.grid).append(h("div.grid-msg.is-error", view.error));
    renderStatus(0, 0);
    return;
  }

  let shown = rows.slice();
  const q = view.filter.trim().toLowerCase();
  if (q) shown = shown.filter((r) => columns.some((c) => String(r[c] ?? "").toLowerCase().includes(q)));
  if (view.sort) {
    const { col, dir } = view.sort;
    shown.sort((a, b) => {
      const x = a[col], y = b[col];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }

  // Per-column max for inline bars.
  const max = {};
  for (const c of columns) {
    if (!BAR_COLUMNS.test(c)) continue;
    const m = Math.max(0, ...rows.map((r) => (typeof r[c] === "number" ? Math.abs(r[c]) : 0)));
    if (m > 0) max[c] = m;
  }

  const thead = h("thead", h("tr", ...columns.map((c) => {
    const sorted = view.sort && view.sort.col === c ? (view.sort.dir > 0 ? " ↑" : " ↓") : "";
    const numeric = NUMERIC.has(c) || rows.some((r) => typeof r[c] === "number");
    return h("th", { class: numeric ? "is-num" : "", scope: "col" }, h("button.th-btn", {
      type: "button",
      onclick: () => {
        view.sort = view.sort && view.sort.col === c ? (view.sort.dir > 0 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 };
        renderGrid();
      },
    }, humanize(c) + sorted));
  })));

  const tbody = h("tbody");
  const sel = view.selected;
  for (const row of shown) {
    const key = rowKey(row, table);
    const target = rowTarget(row, table);
    const tone = key ? view.focus.get(key) : null;
    const tr = h("tr", {
      class: [target ? "is-clickable" : "", tone ? "is-" + tone : "", sel && target && sel.table === target.table && sel.key === target.key ? "is-selected" : ""].filter(Boolean).join(" "),
      tabindex: target ? "0" : null,
      onclick: target ? () => emit("select", target) : null,
      onkeydown: target ? (e) => { if (e.key === "Enter") emit("select", target); } : null,
    });
    for (const c of columns) tr.append(cell(c, row[c], max[c]));
    tbody.append(tr);
  }

  const tableEl = h("table.grid", thead, tbody);
  if (shown.length === 0) {
    clear(els.grid).append(tableEl, h("div.grid-msg", rows.length === 0 ? (table ? "This table is empty." : "The query returned no rows.") : "No rows match the filter."));
  } else {
    clear(els.grid).append(tableEl);
  }
  renderStatus(shown.length, rows.length);

  const first = els.grid.querySelector("tr.is-focus, tr.is-blocked, tr.is-changed");
  if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function cell(col, value, max) {
  if (value == null) return h("td.is-null", "—");
  if (typeof value === "number") {
    const text = /spend|price/.test(col) ? fmt.eur2(value) : col === "recommendation_confidence" ? value.toFixed(2) : fmt.num(value);
    const td = h("td.is-num", text);
    if (max) td.append(h("span.bar", { style: { width: Math.max(2, Math.round((Math.abs(value) / max) * 100)) + "%" }, "aria-hidden": "true" }));
    return td;
  }
  if (col === "maison") return h("td", h("span.mchip", { "data-maison": String(value) }, String(value)));
  if (CHIP_COLUMNS.has(col)) return h("td", h("span.chip", { "data-v": String(value) }, humanize(String(value).toLowerCase())));
  if (/_at$|timestamp/.test(col)) return h("td.is-dim", fmt.time(value));
  if (col === "actor" && /^agent/i.test(value)) return h("td", h("span.chip", { "data-v": "agent" }, String(value)));
  const text = String(value);
  return h("td", { class: MONO_COLUMNS.test(col) ? "is-mono" : "", title: text.length > 40 ? text : null }, text.length > 60 ? text.slice(0, 57) + "…" : text);
}

function renderSourceLabel() {
  const s = view.source;
  let node;
  if (s.kind === "table") node = [h("span.src.src--table", "Table"), " ", h("strong", s.table)];
  else if (s.by === "agent") node = [h("span.src.src--agent", "Agent query"), " ", s.label ? h("span", s.label) : null];
  else node = [h("span.src.src--you", "Your query"), " ", s.label ? h("span", s.label) : null];
  clear(els.sourceLabel).append(...node.filter(Boolean));
}

let lastCounts = [0, 0];
function renderStatus(shown, total) {
  if (!els) return;
  if (shown == null) [shown, total] = lastCounts;
  lastCounts = [shown, total];
  if (view.running) { els.status.textContent = "Running…"; return; }
  const r = view.source.kind === "sql" ? view.source.result : null;
  const parts = [shown === total ? total + " rows" : shown + " of " + total + " rows"];
  if (r && r.truncated) parts.push("truncated at 500");
  if (r && r.ms != null) parts.push(r.ms + " ms");
  if (view.focus.size) parts.push(view.focus.size + " highlighted");
  els.status.textContent = parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Inspector.
// ---------------------------------------------------------------------------

function renderInspector() {
  const sel = view.selected;
  const box = els.inspector;
  if (!sel) { box.hidden = true; clear(box); return; }
  const s = controller.getState();
  let body = null;
  if (sel.table === "exception_queue") {
    const exc = (s.exceptionQueue || []).find((e) => e.id === sel.key);
    // A resolved exception lives on as a consolidated record (same processing id).
    const done = exc ? null : (s.consolidated || []).find((r) => "exc-" + r.processingId === sel.key);
    body = exc ? exceptionPanel(exc) : done ? recordPanel(done, "Resolved: this record left the queue and is now in the Group view.") : gone("This exception has left the queue.");
  } else if (sel.table === "mapping_table") {
    const m = (s.mappingTable || []).find((x) => x.id === sel.key);
    body = m ? mappingPanel(m) : gone("This mapping no longer exists.");
  } else if (sel.table === "consolidated_records") {
    const r = (s.consolidated || []).find((x) => x.processingId === sel.key);
    body = r ? recordPanel(r) : gone("Record not found.");
  } else if (sel.table === "audit_trail") {
    const a = (s.auditTrail || [])[Number(sel.key) - 1];
    body = a ? auditPanel(a, Number(sel.key)) : gone("Entry not found.");
  }
  box.hidden = false;
  clear(box).append(
    h("div.insp__bar", h("span.insp__kind", TABLE_META[sel.table] ? TABLE_META[sel.table].label : sel.table),
      h("button.iconbtn", { type: "button", "aria-label": "Close inspector", onclick: () => { view.selected = null; renderGrid(); renderInspector(); } }, "✕")),
    body,
  );
}

function gone(text) {
  return h("div.insp__body", h("p.muted", text));
}

function fields(pairs) {
  return h("dl.fields", ...pairs.filter(([, v]) => v !== undefined).map(([k, v]) => [h("dt", k), h("dd", { class: v == null || v === "" ? "is-null" : "" }, v == null || v === "" ? "—" : v)]));
}

function exceptionPanel(exc) {
  const r = exc.record || {};
  const reco = exc.recommendation || null;
  const advice = exc.advice || null;
  const held = exc.status === "on_hold_for_correction";
  const noMapping = exc.reason === "NO_MAPPING";

  const head = h("div.insp__head",
    h("div.insp__title", h("span.mchip", { "data-maison": exc.maisonId }, exc.maisonId), " ", h("span.is-mono", r.invoiceRef || exc.id)),
    h("div.insp__chips", h("span.chip", { "data-v": exc.reason }, humanize(exc.reason.toLowerCase())), held ? h("span.chip", { "data-v": "on_hold_for_correction" }, "on hold") : null),
    h("p.insp__id.is-mono", exc.id));

  const adviceBox = advice && !noMapping ? h("div.advice", h("strong", advice.headline), h("p", advice.detail), h("p.muted", advice.action)) : null;
  const heldBox = held ? h("div.advice.is-held", h("strong", "Held by " + (exc.heldBy || "reviewer")), h("p", exc.rejectionReason || "(no reason given)")) : null;

  const rec = fields([
    ["Local supplier", h("span.is-mono", r.supplierCode)],
    ["Local account", h("span.is-mono", r.accountCode)],
    ["Cost center", r.costCenter],
    ["PO", r.poRef], ["Goods receipt", r.receiptRef], ["Invoice", r.invoiceRef],
    ["Quantity", fmt.num(r.quantity)], ["Unit price", r.price != null ? fmt.num(r.price) + " " + (r.currency || "") : null],
  ]);

  return h("div.insp__body", head, heldBox, adviceBox,
    h("h3.insp__h", "Record"), rec,
    noMapping ? recommendationBox(reco) : null,
    h("h3.insp__h", "Decide"),
    shell.replaying ? h("p.muted", "A replay owns the data right now. Exit the replay to act.") : exceptionActions(exc, reco),
    h("button.btn.btn--ghost.btn--block", {
      type: "button",
      onclick: () => emit("ask", { text: "Look at exception " + exc.id + " (" + exc.maisonId + " invoice " + (r.invoiceRef || "?") + ", " + exc.reason + "). What do you recommend, and why?" }),
    }, "Ask the agent about this record"));
}

function recommendationBox(reco) {
  if (!reco) return null;
  const ev = reco.evidence || {};
  const threshold = typeof ev.threshold === "number" ? ev.threshold : 0.7;
  const conf = typeof reco.confidence === "number" ? reco.confidence : 0;
  const status = reco.status === "SUGGESTED" ? "Suggested" : reco.status === "ERROR" ? "Recommender error" : "No suggestion met the threshold";
  const terms = (ev.matchedTerms || []).map((t) => h("div.term",
    h("span.term__field", humanize(t.field)),
    h("span.is-mono", String(t.recordValue ?? "—")), h("span.muted", "vs"), h("span.is-mono", String(t.candidateValue ?? "—")),
    meter(t.similarity, null)));
  const hist = (ev.historyUsed || [])[0];
  const candidate = nearestCandidate(reco);
  return h("div.reco",
    h("h3.insp__h", "Recommender"),
    h("div.reco__head", h("span.chip", { "data-v": reco.status }, status), h("span.reco__conf", "confidence " + conf.toFixed(2))),
    meter(conf, threshold),
    reco.suggestion ? h("p.reco__sugg", "→ ", h("strong.is-mono", reco.suggestion.lvmhSupplierId), " / ", h("span.is-mono", reco.suggestion.lvmhAccountCode)) : null,
    !reco.suggestion && candidate ? h("p.reco__sugg.muted", "Nearest: ", h("span.is-mono", candidate.lvmhSupplierId), " / ", h("span.is-mono", candidate.lvmhAccountCode), " (from ", h("span.is-mono", candidate.id), ")") : null,
    terms.length ? h("div.terms", ...terms) : null,
    hist ? h("p.reco__meta", "History: " + (hist.mappingEntryId || "—") + " used " + (hist.timesUsed ?? 0) + "× · " + (ev.method || "")) : null,
    reco.error ? h("p.is-error", reco.error) : null);
}

function meter(value, threshold) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  return h("div.meter", { title: threshold != null ? "threshold " + threshold : null },
    h("span.meter__fill", { style: { width: Math.round(v * 100) + "%" }, class: threshold != null && v < threshold ? "is-below" : "" }),
    threshold != null ? h("span.meter__mark", { style: { left: Math.round(threshold * 100) + "%" } }) : null);
}

function nearestCandidate(reco) {
  const id = reco && reco.evidence && reco.evidence.historyUsed && reco.evidence.historyUsed[0] && reco.evidence.historyUsed[0].mappingEntryId;
  if (!id) return null;
  return (controller.getState().mappingTable || []).find((m) => m.id === id) || null;
}

function exceptionActions(exc, reco) {
  const wrap = h("div.actions");
  if (exc.reason === "NO_MAPPING") {
    const sugg = reco && reco.status === "SUGGESTED" ? reco.suggestion : null;
    const near = nearestCandidate(reco);
    const known = [...new Set((controller.getState().mappingTable || []).map((m) => m.lvmhSupplierId).filter(Boolean))];
    const listId = "lvmh-ids-" + Math.random().toString(36).slice(2, 8);
    const sup = h("input.input.is-mono", { value: (sugg || near || {}).lvmhSupplierId || "", list: listId, "aria-label": "LVMH supplier id", placeholder: "LVMH-SUP-…" });
    const acct = h("input.input.is-mono", { value: (sugg || near || {}).lvmhAccountCode || "", "aria-label": "LVMH account code", placeholder: "ACCT-…" });
    wrap.append(
      h("p.actions__lead", "Approve a mapping for ", h("span.is-mono", exc.localCodes.supplierCode + " / " + exc.localCodes.accountCode),
        ". Every queued record with these codes is re-normalized, validated and consolidated."),
      h("div.form-row", h("label", "LVMH supplier", sup), h("label", "LVMH account", acct)),
      h("datalist", { id: listId }, ...known.map((k) => h("option", { value: k }))),
      h("button.btn.btn--primary.btn--block", {
        type: "button",
        onclick: () => {
          const draft = { maisonId: exc.maisonId, localSupplierCode: exc.localCodes.supplierCode, localAccountCode: exc.localCodes.accountCode, lvmhSupplierId: sup.value.trim(), lvmhAccountCode: acct.value.trim(), origin: sugg && sugg.lvmhSupplierId === sup.value.trim() ? "agent_suggestion" : "manual" };
          if (!draft.lvmhSupplierId || !draft.lvmhAccountCode) { toast("Enter both LVMH codes.", "error"); return; }
          const res = controller.approveMapping(exc.id, draft, shell.reviewer());
          afterApprove(res);
        },
      }, sugg ? "Approve suggested mapping" : "Approve mapping"),
    );
  } else {
    const note = h("textarea.input", { rows: "2", placeholder: "Reason (required): what did you verify?" });
    wrap.append(note, h("div.btn-row",
      h("button.btn.btn--primary", {
        type: "button",
        onclick: () => {
          if (note.value.trim().length < 8) { toast("Write a reason of at least a few words.", "error"); return; }
          const res = controller.resolveException(exc.id, note.value.trim(), shell.reviewer());
          if (!res.ok) { toast(res.error, "error"); return; }
          emit("changed");
          toast("Cleared by override and consolidated.");
        },
      }, "Override & consolidate"),
      holdButton(exc, note)));
    return wrap;
  }
  const holdNote = h("textarea.input", { rows: "2", placeholder: "Or hold for correction: reason" });
  wrap.append(h("details.more", h("summary", "Hold for correction instead"), holdNote, holdButton(exc, holdNote)));
  return wrap;
}


function holdButton(exc, note) {
  return h("button.btn", {
    type: "button",
    onclick: () => {
      const reason = note.value.trim();
      if (!reason) { toast("Give a reason for the hold.", "error"); return; }
      const res = controller.rejectResolution(exc.id, reason, shell.reviewer());
      if (!res.ok) { toast(res.error, "error"); return; }
      emit("changed");
      toast("Held for correction; moved to the back of the queue.");
    },
  }, "Hold");
}

export function afterApprove(res) {
  if (!res || !res.ok) { toast("Rejected (G4): " + ((res && (res.message || res.error)) || "approval failed"), "error"); return false; }
  emit("changed");
  const back = res.requeuedCount ? " " + res.requeuedCount + " went back to the queue after validation." : "";
  toast("Mapping approved: " + res.resolvedCount + " record(s) consolidated." + back, res.requeuedCount ? "warn" : "ok");
  const focus = (res.requeued || []).map((x) => ({ id: x.id, tone: "changed" }));
  if (focus.length) emit("show", { table: "exception_queue", focus });
  return true;
}

function mappingPanel(m) {
  const s = controller.getState();
  const uses = (s.consolidated || []).filter((r) => r.maisonId === m.maisonId && r.localSupplierCode === m.localSupplierCode && r.localAccountCode === m.localAccountCode).length;
  const note = h("input.input", { placeholder: "Reason for deleting" });
  return h("div.insp__body",
    h("div.insp__head", h("div.insp__title", h("span.mchip", { "data-maison": m.maisonId }, m.maisonId), " ", h("span.is-mono", m.localSupplierCode + " → " + m.lvmhSupplierId)), h("p.insp__id.is-mono", m.id)),
    fields([
      ["Local supplier", h("span.is-mono", m.localSupplierCode)], ["Local account", h("span.is-mono", m.localAccountCode)],
      ["LVMH supplier", h("span.is-mono", m.lvmhSupplierId)], ["LVMH account", h("span.is-mono", m.lvmhAccountCode)],
      ["Status", m.status], ["Origin", m.origin], ["Approved by", m.approvedBy], ["Approved", fmt.time(m.approvedAt)],
      ["Consolidated lines", String(uses)],
    ]),
    shell.replaying ? null : h("details.more", h("summary", "Delete this mapping"),
      h("p.muted", "Future records with these local codes will queue again. Already consolidated lines stay."),
      note,
      h("button.btn.btn--danger", {
        type: "button",
        onclick: () => {
          if (!note.value.trim()) { toast("Give a reason.", "error"); return; }
          const res = controller.deleteMapping(m.id, note.value.trim(), shell.reviewer());
          if (!res.ok) { toast(res.error, "error"); return; }
          view.selected = null;
          emit("changed");
          toast("Mapping deleted and audited.");
        },
      }, "Delete mapping")));
}

function recordPanel(r, banner) {
  const spend = buildTables({ consolidated: [r] }).consolidated_records[0].spend_eur;
  return h("div.insp__body",
    banner ? h("div.advice.is-done", banner) : null,
    h("div.insp__head", h("div.insp__title", h("span.mchip", { "data-maison": r.maisonId }, r.maisonId), " ", h("span.is-mono", r.invoiceRef || r.processingId)),
      h("div.insp__chips", h("span.chip", { "data-v": r.resolvedVia || "auto" }, r.resolvedVia || "auto")), h("p.insp__id.is-mono", r.processingId)),
    h("div.bigfig", fmt.eur2(spend), h("span.muted", " in the Group view")),
    fields([
      ["LVMH supplier", h("span.is-mono", r.lvmhSupplierId)], ["LVMH account", h("span.is-mono", r.lvmhAccountCode)],
      ["Local supplier", h("span.is-mono", r.localSupplierCode)], ["Local account", h("span.is-mono", r.localAccountCode)],
      ["Cost center", r.costCenter], ["PO", r.poRef], ["Goods receipt", r.receiptRef], ["Invoice", r.invoiceRef],
      ["Quantity", fmt.num(r.quantity)], ["Unit price", fmt.num(r.price) + " " + (r.currency || "")],
    ]));
}

function auditPanel(a, seq) {
  return h("div.insp__body",
    h("div.insp__head", h("div.insp__title", h("span.chip", { "data-v": a.action }, a.action), " #" + seq),
      h("p.insp__id", /^agent/i.test(a.actor || "") ? h("span.chip", { "data-v": "agent" }, a.actor) : a.actor, " · ", fmt.time(a.timestamp))),
    h("h3.insp__h", "Before"), h("pre.code", JSON.stringify(a.priorValue ?? null, null, 2)),
    h("h3.insp__h", "After"), h("pre.code", JSON.stringify(a.newValue ?? null, null, 2)),
    a.promptedByProcessingId ? fields([["Prompted by", h("span.is-mono", a.promptedByProcessingId)]]) : null);
}
