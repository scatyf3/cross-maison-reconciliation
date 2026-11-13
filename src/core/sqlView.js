// src/core/sqlView.js
//
// The read-only SQL view an AI agent gets of the governed data. Pure: no DOM,
// no storage, no SQL engine (the runner in src/ui/replay/sqlRunner.js loads
// SQLite and fills these tables).
//
// Agents read through SQL and change data only through governed tools
// (approve_mapping, resolve_exception, ...), which validate, check conflicts
// and write the Audit Trail. A direct SQL write would skip all of that, so the
// policy (G1) blocks anything that is not a single SELECT / WITH ... SELECT.
//
// Tables (snake_case, one row per record):
//   consolidated_records  records in the Group view, with EUR spend
//   exception_queue       queued records, reason, status, recommender output
//   mapping_table         governed local -> LVMH mappings
//   audit_trail           governance log

import { spendInEur } from "./reporting.js";

export const TABLES = Object.freeze({
  consolidated_records: [
    "processing_id", "maison", "lvmh_supplier_id", "lvmh_account_code", "local_supplier_code", "local_account_code",
    "cost_center", "po_ref", "receipt_ref", "invoice_ref", "quantity", "unit_price", "currency", "spend_eur", "resolved_via",
  ],
  exception_queue: [
    "exception_id", "processing_id", "maison", "local_supplier_code", "local_account_code", "cost_center",
    "po_ref", "receipt_ref", "invoice_ref", "quantity", "unit_price", "currency", "reason", "status",
    "rejection_reason", "recommendation_status", "recommendation_confidence",
    "suggested_lvmh_supplier_id", "suggested_lvmh_account_code",
  ],
  mapping_table: [
    "mapping_id", "maison", "local_supplier_code", "local_account_code", "lvmh_supplier_id", "lvmh_account_code",
    "status", "origin", "approved_by", "approved_at",
  ],
  audit_trail: ["seq", "actor", "timestamp", "action", "prompted_by_processing_id"],
});

/** Columns holding numbers (declared REAL so SUM/ROUND behave). */
export const NUMERIC = new Set(["quantity", "unit_price", "spend_eur", "recommendation_confidence", "seq"]);

/**
 * Turn live app state into table rows, keyed by table name.
 * @returns {Object<string, Object[]>}
 */
export function buildTables(state) {
  const s = state || {};
  const num = (v) => {
    const n = Number(v);
    return v === "" || v == null || !Number.isFinite(n) ? null : n;
  };
  const str = (v) => (v === undefined || v === "" ? null : v);

  const consolidated_records = (s.consolidated || []).map((r) => ({
    processing_id: str(r.processingId),
    maison: str(r.maisonId),
    lvmh_supplier_id: str(r.lvmhSupplierId),
    lvmh_account_code: str(r.lvmhAccountCode),
    local_supplier_code: str(r.localSupplierCode),
    local_account_code: str(r.localAccountCode),
    cost_center: str(r.costCenter),
    po_ref: str(r.poRef),
    receipt_ref: str(r.receiptRef),
    invoice_ref: str(r.invoiceRef),
    quantity: num(r.quantity),
    unit_price: num(r.price),
    currency: str(r.currency),
    spend_eur: spendInEur(r),
    resolved_via: str(r.resolvedVia),
  }));

  const exception_queue = (s.exceptionQueue || []).map((e) => {
    const rec = e.record || {};
    const reco = e.recommendation || {};
    const sugg = reco.suggestion || {};
    return {
      exception_id: str(e.id),
      processing_id: str(rec.processingId),
      maison: str(e.maisonId),
      local_supplier_code: str(e.localCodes && e.localCodes.supplierCode),
      local_account_code: str(e.localCodes && e.localCodes.accountCode),
      cost_center: str(rec.costCenter),
      po_ref: str(rec.poRef),
      receipt_ref: str(rec.receiptRef),
      invoice_ref: str(rec.invoiceRef),
      quantity: num(rec.quantity),
      unit_price: num(rec.price),
      currency: str(rec.currency),
      reason: str(e.reason),
      status: str(e.status),
      rejection_reason: str(e.rejectionReason),
      recommendation_status: str(reco.status),
      recommendation_confidence: num(reco.confidence),
      suggested_lvmh_supplier_id: str(sugg.lvmhSupplierId),
      suggested_lvmh_account_code: str(sugg.lvmhAccountCode),
    };
  });

  const mapping_table = (s.mappingTable || []).map((m) => ({
    mapping_id: str(m.id),
    maison: str(m.maisonId),
    local_supplier_code: str(m.localSupplierCode),
    local_account_code: str(m.localAccountCode),
    lvmh_supplier_id: str(m.lvmhSupplierId),
    lvmh_account_code: str(m.lvmhAccountCode),
    status: str(m.status),
    origin: str(m.origin),
    approved_by: str(m.approvedBy),
    approved_at: str(m.approvedAt),
  }));

  const audit_trail = (s.auditTrail || []).map((a, i) => ({
    seq: i + 1,
    actor: str(a.actor),
    timestamp: str(a.timestamp),
    action: str(a.action),
    prompted_by_processing_id: str(a.promptedByProcessingId),
  }));

  return { consolidated_records, exception_queue, mapping_table, audit_trail };
}

/**
 * Is this a single read-only statement? Comments and string literals are
 * stripped first so a keyword inside a quoted value does not count.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkReadOnly(sql) {
  const src = String(sql || "");
  const code = src
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim()
    .replace(/;\s*$/, "");
  if (code === "") return { ok: false, reason: "The query is empty." };
  if (code.includes(";")) return { ok: false, reason: "Only one statement per query is allowed." };
  if (!/^(select|with)\b/i.test(code)) {
    const verb = (code.match(/^\s*([a-z]+)/i) || [, "this"])[1].toUpperCase();
    return { ok: false, reason: verb + " is a write or schema statement; agents get read-only SQL." };
  }
  const w = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b/i.exec(code);
  if (w) return { ok: false, reason: "The query contains " + w[1].toUpperCase() + "; agents get read-only SQL." };
  return { ok: true };
}

/** Which view best shows what a query read (for the replay's navigation). */
export function routeForSql(sql) {
  const t = String(sql || "").toLowerCase();
  if (/count\s*\(\s*distinct\s+maison/.test(t)) return "#sourcing";
  if (/\bexception_queue\b/.test(t)) return "#exceptions";
  if (/\bconsolidated_records\b/.test(t)) return "#report";
  if (/\b(mapping_table|audit_trail)\b/.test(t)) return "#mappings";
  return "#report";
}

/** Human-readable schema, returned by list_tables / describe_table. */
export function describeSchema(table) {
  if (table && TABLES[table]) {
    return TABLES[table].map((c) => ({ column: c, type: NUMERIC.has(c) ? "REAL" : "TEXT" }));
  }
  return Object.keys(TABLES).map((name) => ({ table: name, columns: TABLES[name].join(", ") }));
}
