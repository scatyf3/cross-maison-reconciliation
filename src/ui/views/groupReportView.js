// src/ui/views/groupReportView.js
// Group Report view (route "#report"). The consolidated LVMH Group P2P view:
// enriched rows (supplier name, category, qty, unit price, EUR line spend),
// a total-spend headline, reconciliation counts, and spend-by-supplier /
// spend-by-category summaries that set up strategic sourcing. Req 15.x, 17.2.

import { buildCurrentReport } from "../appController.js";
import { buildReportSheets } from "../../core/reporting.js";
import { buildWorkbookBlob } from "../../core/xlsx.js";

const ROW_COLUMNS = [
  { key: "lvmhSupplierId", label: "LVMH Supplier ID" },
  { key: "standardSupplierName", label: "Supplier Name" },
  { key: "spendCategory", label: "Spend Category" },
  { key: "maisonId", label: "Maison" },
  { key: "localSupplierCode", label: "Local Supplier" },
  { key: "quantity", label: "Qty" },
  { key: "unitPrice", label: "Unit Price" },
  { key: "spendEur", label: "Spend (EUR)" },
];

export function render(container, state, handlers) {
  if (typeof document === "undefined" || !container) return;
  const report = safeBuildReport();
  container.innerHTML = "";
  const section = el("section", { class: "view view-report" });
  const header = el("div", { class: "view-header" });
  header.appendChild(el("h2", { text: "Group Report" }));
  header.appendChild(buildExportButton(handlers));
  section.appendChild(header);
  if (!report) {
    section.appendChild(el("p", { class: "empty-state", text: "The report could not be built from the current data." }));
    container.appendChild(section);
    return;
  }
  section.appendChild(el("p", { class: "view-caption", text: "Common currency: " + scalar(report.commonCurrency) + ", generated " + scalar(report.generatedAt) }));
  section.appendChild(buildMetrics(report));

  // Switchable tabs so users do not scroll through every section.
  const panels = [
    { id: "records", label: "Consolidated records (" + report.rows.length + ")", build: () => buildRows(report.rows) },
    { id: "bysupplier", label: "Spend by supplier", build: () => buildSummary("Spend by LVMH supplier", ["Supplier", "Name", "Lines", "Spend (EUR)"], (report.spendBySupplier || []).map((r) => [r.lvmhSupplierId, r.standardSupplierName, r.lines, money(r.spendEur)])) },
    { id: "bycategory", label: "Spend by category", build: () => buildSummary("Spend by category", ["Category", "Lines", "Spend (EUR)"], (report.spendByCategory || []).map((r) => [r.spendCategory, r.lines, money(r.spendEur)])) },
    { id: "suppliermap", label: "Supplier mapping", build: () => buildSupplierMapping(report.supplierMapping) },
  ];

  const tabs = el("div", { class: "report-tabs", role: "tablist" });
  const panelHost = el("div", { class: "report-tabpanel" });
  function show(id) {
    panelHost.innerHTML = "";
    const panel = panels.find((x) => x.id === id) || panels[0];
    panelHost.appendChild(panel.build());
    for (const b of tabs.children) {
      const active = b.getAttribute("data-tab") === id;
      b.className = active ? "report-tab is-active" : "report-tab";
      b.setAttribute("aria-selected", active ? "true" : "false");
    }
  }
  for (const panel of panels) {
    const b = el("button", { type: "button", class: "report-tab", role: "tab", text: panel.label });
    b.setAttribute("data-tab", panel.id);
    b.addEventListener("click", () => show(panel.id));
    tabs.appendChild(b);
  }
  section.appendChild(tabs);
  section.appendChild(panelHost);
  show(panels[0].id);
  container.appendChild(section);
}

function safeBuildReport() {
  try { return buildCurrentReport(); }
  catch (err) { if (typeof console !== "undefined") console.warn("[groupReportView]", err); return null; }
}

function buildExportButton(handlers) {
  const btn = el("button", { type: "button", class: "btn btn-export", text: "Export Excel" });
  btn.addEventListener("click", () => exportExcel());
  return btn;
}

// Build the workbook from the live report and trigger a .xlsx download.
function exportExcel() {
  const report = safeBuildReport();
  if (!report) return;
  const blob = buildWorkbookBlob(buildReportSheets(report));
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return;
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "group-report-" + stamp + ".xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildMetrics(report) {
  const wrap = el("div", { class: "metrics" });
  const c = report.counts || {};
  wrap.appendChild(metric(money(report.totalSpendEur), "Total spend (EUR)"));
  wrap.appendChild(metric(String(report.rows.length), "Consolidated records"));
  wrap.appendChild(metric(String(c.autoNormalized || 0), "Auto-normalized"));
  wrap.appendChild(metric(String(c.financeJudgment || 0), "Finance judgment"));
  wrap.appendChild(metric(String(c.exceptionsRemaining || 0), "Exceptions remaining"));
  return wrap;
}

function metric(value, label) {
  const m = el("div", { class: "metric" });
  m.appendChild(el("span", { class: "metric__value", text: value }));
  m.appendChild(el("span", { class: "metric__label", text: label }));
  return m;
}

function buildSummary(title, headers, rows) {
  const wrap = el("div", { class: "report-summary" });
  wrap.appendChild(el("h3", { text: title }));
  if (!rows || rows.length === 0) { wrap.appendChild(el("p", { class: "empty-state", text: "No data yet." })); return wrap; }
  const tw = el("div", { class: "table-wrap" });
  const table = el("table", { class: "summary-table" });
  const thead = el("thead"); const hr = el("tr");
  for (const h of headers) hr.appendChild(el("th", { text: h }));
  thead.appendChild(hr); table.appendChild(thead);
  const tb = el("tbody");
  for (const row of rows) { const tr = el("tr"); for (const cell of row) tr.appendChild(el("td", { text: scalar(cell) })); tb.appendChild(tr); }
  table.appendChild(tb); tw.appendChild(table); wrap.appendChild(tw);
  return wrap;
}

function buildRows(rows) {
  const wrap = el("div", { class: "report-rows" });
  wrap.appendChild(el("h3", { text: "Consolidated records (" + (rows ? rows.length : 0) + ")" }));
  if (!rows || rows.length === 0) { wrap.appendChild(el("p", { class: "empty-state", text: "No consolidated records yet." })); return wrap; }
  const tw = el("div", { class: "table-wrap" });
  const table = el("table", { class: "report-table" });
  const thead = el("thead"); const hr = el("tr");
  for (const col of ROW_COLUMNS) hr.appendChild(el("th", { text: col.label }));
  thead.appendChild(hr); table.appendChild(thead);
  const tb = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const col of ROW_COLUMNS) {
      const v = row ? row[col.key] : undefined;
      tr.appendChild(el("td", { text: col.key === "spendEur" ? money(v) : scalar(v) }));
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb); tw.appendChild(table); wrap.appendChild(tw);
  return wrap;
}

function buildSupplierMapping(mapping) {
  const wrap = el("div", { class: "report-supplier-mapping" });
  wrap.appendChild(el("h3", { text: "Local → LVMH supplier mapping" }));
  const list = Array.isArray(mapping) ? mapping : [];
  if (list.length === 0) { wrap.appendChild(el("p", { class: "empty-state", text: "No supplier mappings yet." })); return wrap; }
  const tw = el("div", { class: "table-wrap" });
  const table = el("table", { class: "supplier-mapping-table" });
  const thead = el("thead"); const hr = el("tr");
  for (const h of ["Maison", "Local Supplier", "LVMH Supplier ID"]) hr.appendChild(el("th", { text: h }));
  thead.appendChild(hr); table.appendChild(thead);
  const tb = el("tbody");
  for (const e of list) { const tr = el("tr"); for (const k of ["maisonId","localSupplierCode","lvmhSupplierId"]) tr.appendChild(el("td", { text: scalar(e[k]) })); tb.appendChild(tr); }
  table.appendChild(tb); tw.appendChild(table); wrap.appendChild(tw);
  return wrap;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return "€" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function scalar(v) {
  if (v === undefined || v === null || v === "") return "-";
  return String(v);
}

function el(tag, attrs) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  return node;
}
