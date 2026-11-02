// src/core/reporting.js
//
// Reporting_Module for the Cross-Maison P2P Reconciliation prototype.
//
// Once records have been normalized, validated, and consolidated into the LVMH
// common structure, the Reporting_Module turns that consolidated data into the
// Group_Report: the final LVMH Group P2P view that presents spend across all
// Maisons on a common basis (Req 15.1). The report expresses each consolidated
// record with its canonical LVMH Supplier ID and LVMH Account Code and the
// single common-currency label (Req 15.1), lists the per-Maison local-supplier
// -> LVMH-supplier mapping (Req 15.2), and carries the run counts that split
// the attempted records into auto-normalized, finance-judgment, and
// exceptions-remaining buckets (Req 15.3).
//
// `exportGroupReportCsv` writes the report rows back to CSV text through the
// shared CSV_Serializer in the common nine-column format (Req 15.4).
//
// The module is pure: no DOM, no storage, no network. `buildGroupReport` may
// stamp `generatedAt` with the current time, which is the module's only
// non-deterministic input; callers that need a fixed timestamp can pass one in
// via the options bag so the function stays testable.
//
// Requirements: 15.1, 15.2, 15.3, 15.4

import { serializeCsv } from "./csv.js";
import { COMMON_CURRENCY } from "./constants.js";

/**
 * @typedef {Object} ConsolidatedRecord
 * A normalized + validated P2P_Record combined into the LVMH common structure.
 * Keyed by its LVMH codes while retaining the original Maison local codes.
 * @property {string} lvmhSupplierId
 * @property {string} lvmhAccountCode
 * @property {string} maisonId
 * @property {string} supplierCode     original local supplier code (Req 16.3)
 * @property {string} accountCode       original local account code
 * @property {number|string} quantity
 * @property {number|string} price
 * @property {string} currency          original Maison currency (retained)
 */

/**
 * @typedef {Object} GroupReportRow
 * @property {string} lvmhSupplierId
 * @property {string} lvmhAccountCode
 * @property {string} maisonId
 * @property {string} localSupplierCode
 * @property {number|string} quantity
 * @property {number|string} price
 * @property {string} currency           the common-currency label (Req 15.1)
 */

/**
 * @typedef {Object} GroupReportCounts
 * @property {number} autoNormalized       normalized without reviewer action
 * @property {number} financeJudgment      resolved via approval of a mapping
 * @property {number} exceptionsRemaining  still in the Exception_Queue
 */

/**
 * @typedef {Object} GroupReport
 * @property {string} generatedAt          ISO timestamp the report was built
 * @property {string} commonCurrency       the common presentation currency
 * @property {GroupReportRow[]} rows
 * @property {{maisonId: string, localSupplierCode: string, lvmhSupplierId: string}[]} supplierMapping
 * @property {GroupReportCounts} counts
 */

/**
 * Build a report row from one consolidated record. The row is expressed with
 * the record's LVMH Supplier ID and LVMH Account Code (Req 15.1) and carries
 * the common-currency label rather than the record's original Maison currency,
 * since the Group_Report presents spend on a common basis (Req 15.1). The
 * original local supplier code is retained so the supplier mapping can be read
 * back off the rows (Req 15.2, 16.3).
 *
 * @param {ConsolidatedRecord} record
 * @param {string} commonCurrency
 * @returns {GroupReportRow}
 */
function toReportRow(record, commonCurrency) {
  const localSupplier = record.localSupplierCode != null ? record.localSupplierCode : record.supplierCode;
  const spendEur = spendInEur(record);
  return {
    lvmhSupplierId: record.lvmhSupplierId,
    // Fall back to the LVMH supplier id when a record carries no supplier name
    // (e.g. older records consolidated before names were captured).
    standardSupplierName: record.standardSupplierName || record.lvmhSupplierId || null,
    lvmhAccountCode: record.lvmhAccountCode,
    spendCategory: record.spendCategory != null ? record.spendCategory : record.localAccountCode,
    maisonId: record.maisonId,
    localSupplierCode: localSupplier,
    quantity: record.quantity,
    unitPrice: record.price,
    spendEur: spendEur,
    currency: commonCurrency,
  };
}

// Line spend in the common currency (EUR): the file Approved Spend EUR when
// present, else qty * unit price * FX (FX defaults to 1).
function spendInEur(record) {
  const direct = Number(record.approvedSpendEur);
  if (Number.isFinite(direct) && direct > 0) return round2(direct);
  const qty = Number(record.quantity);
  const price = Number(record.price);
  const fx = Number(record.fxToEur);
  const rate = Number.isFinite(fx) && fx > 0 ? fx : 1;
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return 0;
  return round2(qty * price * rate);
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Derive the per-Maison local-supplier -> LVMH-supplier mapping from the
 * consolidated data. One entry per distinct `(maisonId, localSupplierCode,
 * lvmhSupplierId)` triple is emitted, so every local supplier that reached the
 * consolidated data is represented exactly once (Req 15.2).
 *
 * @param {ConsolidatedRecord[]} consolidated
 * @returns {{maisonId: string, localSupplierCode: string, lvmhSupplierId: string}[]}
 */
function buildSupplierMapping(consolidated) {
  const seen = new Set();
  const mapping = [];

  for (const record of consolidated) {
    const sup = record.localSupplierCode != null ? record.localSupplierCode : record.supplierCode;
    const key = `${record.maisonId}\u0000${sup}\u0000${record.lvmhSupplierId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mapping.push({
      maisonId: record.maisonId,
      localSupplierCode: sup,
      lvmhSupplierId: record.lvmhSupplierId,
    });
  }

  return mapping;
}

/**
 * Normalize an incoming counts object into a complete GroupReportCounts,
 * defaulting any missing bucket to 0. The three buckets are reported as given;
 * together they partition the attempted records (Req 15.3) — the caller (the
 * pipeline controller) is responsible for supplying counts that sum correctly.
 *
 * @param {Partial<GroupReportCounts>} [counts]
 * @returns {GroupReportCounts}
 */
function normalizeCounts(counts) {
  const source = counts || {};
  return {
    autoNormalized: source.autoNormalized || 0,
    financeJudgment: source.financeJudgment || 0,
    exceptionsRemaining: source.exceptionsRemaining || 0,
  };
}

/**
 * Build the LVMH Group_Report from the consolidated data, the Mapping_Table,
 * and the run counts.
 *
 * Every report row is expressed with an LVMH Supplier ID, an LVMH Account Code,
 * and the common-currency label (Req 15.1); the report's `supplierMapping`
 * lists every `(Maison local supplier code -> LVMH Supplier ID)` pair present
 * in the consolidated data (Req 15.2); and `counts` carries the
 * auto-normalized / finance-judgment / exceptions-remaining split (Req 15.3).
 *
 * The `mappingTable` is accepted per the Reporting_Module interface for
 * forward compatibility (e.g. annotating rows with approval provenance); the
 * supplier mapping is derived from the consolidated data itself so the report
 * reflects exactly what was consolidated.
 *
 * Pure except for the `generatedAt` stamp, which defaults to the current time
 * and can be overridden via `opts.now` for deterministic tests.
 *
 * @param {ConsolidatedRecord[]} consolidated  the consolidated LVMH data
 * @param {Object[]} [mappingTable]            the Mapping_Table (approved entries)
 * @param {Partial<GroupReportCounts>} [counts]
 * @param {Object} [opts]
 * @param {string} [opts.now]                  ISO timestamp for generatedAt
 * @param {string} [opts.commonCurrency]       override the common-currency label
 * @returns {GroupReport}
 */
// Total EUR spend grouped by LVMH supplier, sorted high to low.
function buildSpendBySupplier(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = row.lvmhSupplierId || "(unmapped)";
    const cur = byId.get(id) || { lvmhSupplierId: id, standardSupplierName: row.standardSupplierName || null, spendEur: 0, lines: 0 };
    cur.spendEur = round2(cur.spendEur + (Number(row.spendEur) || 0));
    cur.lines += 1;
    if (!cur.standardSupplierName && row.standardSupplierName) cur.standardSupplierName = row.standardSupplierName;
    byId.set(id, cur);
  }
  return [...byId.values()].sort((a, b) => b.spendEur - a.spendEur);
}

// Total EUR spend grouped by spend category, sorted high to low.
function buildSpendByCategory(rows) {
  const byCat = new Map();
  for (const row of rows) {
    const cat = row.spendCategory || row.lvmhAccountCode || "(uncategorized)";
    const cur = byCat.get(cat) || { spendCategory: cat, spendEur: 0, lines: 0 };
    cur.spendEur = round2(cur.spendEur + (Number(row.spendEur) || 0));
    cur.lines += 1;
    byCat.set(cat, cur);
  }
  return [...byCat.values()].sort((a, b) => b.spendEur - a.spendEur);
}

export function buildGroupReport(consolidated, mappingTable, counts, opts = {}) {
  const records = Array.isArray(consolidated) ? consolidated : [];
  const commonCurrency = opts.commonCurrency || COMMON_CURRENCY;
  const generatedAt = opts.now || new Date().toISOString();

  // Counts are DERIVED from the data so they always reconcile with the rows.
  // Each consolidated record carries a `resolvedVia` tag:
  //   "auto"     -> normalized automatically (no reviewer action)
  //   "mapping"  -> reviewer approved a new mapping
  //   "override" -> reviewer approved the record as-is with a reason
  // auto counts as auto-normalized; mapping + override count as finance
  // judgment. exceptionsRemaining is the live Exception_Queue length when
  // provided (opts.exceptionsRemaining), else falls back to the given count.
  let autoNormalized = 0;
  let financeJudgment = 0;
  for (const r of records) {
    if (r && (r.resolvedVia === "mapping" || r.resolvedVia === "override")) financeJudgment += 1;
    else autoNormalized += 1;
  }
  const exceptionsRemaining =
    opts.exceptionsRemaining != null
      ? opts.exceptionsRemaining
      : (counts && counts.exceptionsRemaining) || 0;

  const reportRows = records.map((record) => toReportRow(record, commonCurrency));
  const totalSpendEur = round2(reportRows.reduce((sum, row) => sum + (Number(row.spendEur) || 0), 0));
  return {
    generatedAt,
    commonCurrency,
    rows: reportRows,
    supplierMapping: buildSupplierMapping(records),
    spendBySupplier: buildSpendBySupplier(reportRows),
    spendByCategory: buildSpendByCategory(reportRows),
    totalSpendEur,
    counts: { autoNormalized, financeJudgment, exceptionsRemaining },
  };
}

/**
 * Export a Group_Report to CSV text in the common nine-column LVMH format via
 * the shared CSV_Serializer (Req 15.4).
 *
 * Shaping note: the common extract format has nine columns
 * (supplierCode, accountCode, costCenter, poRef, receiptRef, invoiceRef,
 * quantity, price, currency), but a Group_Report row is a consolidated,
 * LVMH-canonical view and does not carry per-line references. The report rows
 * are mapped onto the nine-column shape as follows:
 *   - supplierCode <- lvmhSupplierId   (the report's canonical supplier id)
 *   - accountCode  <- lvmhAccountCode  (the report's canonical account code)
 *   - costCenter   <- maisonId         (the owning Maison, retained for traceability)
 *   - poRef        <- localSupplierCode(the original local supplier code, so the
 *                                        local -> LVMH supplier mapping survives the export)
 *   - receiptRef   <- "" (no per-line reference at the consolidated level)
 *   - invoiceRef   <- "" (no per-line reference at the consolidated level)
 *   - quantity     <- quantity
 *   - price        <- price
 *   - currency     <- currency         (the common-currency label)
 * This keeps the export a valid nine-column extract while preserving the LVMH
 * codes, the common currency, and the local->LVMH supplier link (Req 15.1,
 * 15.2) so the CSV round-trips the report's field values (Property 19).
 *
 * @param {GroupReport} groupReport
 * @returns {string} CSV text in the common nine-column format
 */
// Export the whole Group Report as one CSV with labeled, stacked sections:
// Summary, Spend by Supplier, Spend by Category, and the full Consolidated
// Records. Blocks are separated by a blank line and open cleanly in Excel.
export function exportGroupReportCsv(groupReport) {
  const report = groupReport || {};
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const bySupplier = Array.isArray(report.spendBySupplier) ? report.spendBySupplier : [];
  const byCategory = Array.isArray(report.spendByCategory) ? report.spendByCategory : [];
  const counts = report.counts || {};
  const lines = [];
  const row = (arr) => lines.push(arr.map(csvField).join(","));
  const blank = () => lines.push("");
  row(["LVMH GROUP REPORT"]);
  row(["Generated", report.generatedAt || ""]);
  row(["Common currency", report.commonCurrency || ""]);
  row(["Total spend (EUR)", report.totalSpendEur != null ? report.totalSpendEur : ""]);
  row(["Consolidated records", rows.length]);
  row(["Auto-normalized", counts.autoNormalized || 0]);
  row(["Finance judgment", counts.financeJudgment || 0]);
  row(["Exceptions remaining", counts.exceptionsRemaining || 0]);
  blank();
  row(["SPEND BY LVMH SUPPLIER"]);
  row(["LVMH Supplier ID", "Supplier Name", "Lines", "Spend (EUR)"]);
  for (const r of bySupplier) row([r.lvmhSupplierId, r.standardSupplierName, r.lines, r.spendEur]);
  blank();
  row(["SPEND BY CATEGORY"]);
  row(["Spend Category", "Lines", "Spend (EUR)"]);
  for (const r of byCategory) row([r.spendCategory, r.lines, r.spendEur]);
  blank();
  row(["CONSOLIDATED RECORDS"]);
  row(["LVMH Supplier ID", "Supplier Name", "LVMH Account Code", "Spend Category", "Maison", "Local Supplier", "Quantity", "Unit Price", "Spend (EUR)", "Currency"]);
  for (const r of rows) row([r.lvmhSupplierId, r.standardSupplierName, r.lvmhAccountCode, r.spendCategory, r.maisonId, r.localSupplierCode, r.quantity, r.unitPrice, r.spendEur, r.currency]);
  return lines.join("\n");
}

function csvField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// Build sheet definitions for a multi-sheet Excel export: one sheet per
// Group Report category. Returns [{ name, rows: [[cell,...],...] }] for the
// dependency-free XLSX writer (src/core/xlsx.js). Pure data, no DOM.
export function buildReportSheets(report) {
  const r = report || {};
  const counts = r.counts || {};
  const rows = Array.isArray(r.rows) ? r.rows : [];
  const bySupplier = Array.isArray(r.spendBySupplier) ? r.spendBySupplier : [];
  const byCategory = Array.isArray(r.spendByCategory) ? r.spendByCategory : [];
  const summary = {
    name: "Summary",
    rows: [
      ["LVMH Group Report"],
      ["Generated", r.generatedAt || ""],
      ["Common currency", r.commonCurrency || ""],
      ["Total spend (EUR)", r.totalSpendEur != null ? r.totalSpendEur : ""],
      ["Consolidated records", rows.length],
      ["Auto-normalized", counts.autoNormalized || 0],
      ["Finance judgment", counts.financeJudgment || 0],
      ["Exceptions remaining", counts.exceptionsRemaining || 0],
    ],
  };
  const supplierSheet = {
    name: "Spend by Supplier",
    rows: [["LVMH Supplier ID", "Supplier Name", "Lines", "Spend (EUR)"]].concat(
      bySupplier.map((x) => [x.lvmhSupplierId, x.standardSupplierName, x.lines, x.spendEur])),
  };
  const categorySheet = {
    name: "Spend by Category",
    rows: [["Spend Category", "Lines", "Spend (EUR)"]].concat(
      byCategory.map((x) => [x.spendCategory, x.lines, x.spendEur])),
  };
  const recordsSheet = {
    name: "Consolidated Records",
    rows: [["LVMH Supplier ID", "Supplier Name", "LVMH Account Code", "Spend Category", "Maison", "Local Supplier", "Quantity", "Unit Price", "Spend (EUR)", "Currency"]].concat(
      rows.map((x) => [x.lvmhSupplierId, x.standardSupplierName, x.lvmhAccountCode, x.spendCategory, x.maisonId, x.localSupplierCode, x.quantity, x.unitPrice, x.spendEur, x.currency])),
  };
  return [summary, supplierSheet, categorySheet, recordsSheet];
}
