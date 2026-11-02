// src/core/financeAdapter.js
//
// Adapter that lets the app ingest a realistic 30-column LVMH finance export
// (e.g. LVMH_Finance_Approved_Transactions.csv) in ADDITION to the strict
// nine-column format in csv.js. It never replaces the strict parser; the UI
// chooses this path when detectFinanceFormat() recognizes the header.
//
// The real export carries far more than the internal P2P_Record shape, and its
// real invoices have small price variances that would fail the strict 0.00
// 3-way match. So instead of forcing the strict validator, this adapter maps
// the file's own governance columns (PO Status / RPA First Pass / Finance
// Decision) into the pipeline and lets those drive the auto-vs-exception split
// (see the finance-import routing policy in the UI controller).
//
// Pure module: no DOM, no storage, no network.

import { splitCsvLine } from "./csv.js";
import { ExceptionReason } from "./constants.js";

// The columns we rely on from the 30-column finance export.
const H = {
  maison: "Maison",
  sourceErp: "Source ERP (assumed)",
  supplierLocalId: "Supplier Local ID",
  globalSupplierId: "Global Supplier ID",
  standardSupplierName: "Standard Supplier Name",
  spendCategory: "Spend Category",
  invoiceNo: "Invoice No",
  poNo: "Validated PO No",
  grId: "Verified Goods Receipt ID",
  invoicedQty: "Invoiced Qty",
  receivedQty: "Verified Received Qty",
  poUnitPrice: "Approved PO Unit Price (local)",
  invUnitPrice: "Invoice Unit Price (local)",
  priceVariancePct: "Final Price Variance %",
  approvedSpendEur: "Approved Spend EUR",
  currency: "Verified Currency",
  fxToEur: "FX to EUR (assumed)",
  poStatus: "PO Status",
  rpaFirstPass: "RPA First Pass",
  financeDecision: "Finance Decision",
  reviewRoute: "Review Route",
  approvalDate: "Approval Date",
  supportingEvidence: "Supporting Evidence (simulated)",
  reviewNotes: "Finance Review Notes",
};

// Signature columns used to recognize the finance export format.
const SIGNATURE = [H.maison, H.supplierLocalId, H.globalSupplierId, H.poStatus, H.rpaFirstPass];

/** Map an RPA First Pass flag to an ExceptionReason when it is not a clean match. */
const RPA_TO_REASON = {
  UNKNOWN_SUPPLIER: ExceptionReason.NO_MAPPING,
  PRICE_VARIANCE: ExceptionReason.PRICE_MISMATCH,
  QTY_OVER_RECEIPT: ExceptionReason.QUANTITY_MISMATCH,
  NO_PO: ExceptionReason.MISSING_REFERENCE,
  MISSING_CURRENCY: ExceptionReason.MISSING_FIELD,
};

/**
 * Normalize a Maison display name into a stable id: uppercase, non-alphanumerics
 * to single underscores. "Louis Vuitton" -> "LOUIS_VUITTON".
 * @param {string} name
 * @returns {string}
 */
export function normalizeMaisonId(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Slug a spend category into an LVMH account code, e.g. "Leather materials" -> "ACCT-LEATHER-MATERIALS". */
function accountCodeFor(spendCategory) {
  const slug = String(spendCategory || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `ACCT-${slug}` : "ACCT-UNCATEGORIZED";
}

/**
 * True when the CSV text looks like the 30-column finance export (header
 * contains all signature columns).
 * @param {string} csvText
 * @returns {boolean}
 */
export function detectFinanceFormat(csvText) {
  if (typeof csvText !== "string" || csvText.length === 0) return false;
  const firstLine = csvText.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const header = splitCsvLine(firstLine);
  const set = new Set(header.map((h) => h.trim()));
  return SIGNATURE.every((col) => set.has(col));
}

/** A clean auto-match row: RPA matched it on the first pass with no finance exception. */
function isCleanMatch(row) {
  return String(row[H.rpaFirstPass]).trim().toUpperCase() === "MATCHED";
}

/**
 * Parse the finance export into per-Maison records, derived approved mapping
 * entries, and parse errors.
 *
 * @param {string} csvText
 * @returns {{ recordsByMaison: Object<string,Object[]>, maisonLabels: Object<string,string>,
 *             mappingEntries: Object[], parseErrors: Object[], stats: Object }}
 */
export function parseFinanceCsv(csvText) {
  const text = String(csvText || "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const parseErrors = [];
  const recordsByMaison = {};
  const maisonLabels = {};
  const mappingSeen = new Map(); // tupleKey -> Mapping_Entry
  let seq = 0;

  if (lines.length === 0) {
    return { recordsByMaison, maisonLabels, mappingEntries: [], parseErrors, stats: { rows: 0 } };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = {};
  for (const [k, name] of Object.entries(H)) col[k] = header.indexOf(name);

  const runId = `finance-${Date.now()}`;
  let cleanMatches = 0;
  let exceptions = 0;

  for (let r = 1; r < lines.length; r += 1) {
    const fields = splitCsvLine(lines[r]);
    if (fields.length === 1 && fields[0].trim() === "") continue;
    if (fields.length < header.length) {
      parseErrors.push({ rowNumber: r + 1, column: "row", reason: "MISSING_COLUMN" });
      continue;
    }
    const get = (key) => (col[key] >= 0 ? (fields[col[key]] ?? "").trim() : "");

    const maisonLabel = get("maison");
    const maisonId = normalizeMaisonId(maisonLabel);
    if (!maisonId) {
      parseErrors.push({ rowNumber: r + 1, column: H.maison, reason: "MISSING_FIELD" });
      continue;
    }
    maisonLabels[maisonId] = maisonLabel;

    const supplierCode = get("supplierLocalId");
    const spendCategory = get("spendCategory");
    const accountCode = spendCategory; // local account = spend category
    const lvmhAccountCode = accountCodeFor(spendCategory);
    const globalSupplierId = get("globalSupplierId");
    const currency = get("currency");

    const rpa = get("rpaFirstPass").toUpperCase();
    const poStatus = get("poStatus");
    const clean = rpa === "MATCHED";

    const record = {
      processingId: `${runId}:${String(seq).padStart(6, "0")}`,
      runId,
      maisonId,
      maisonLabel,
      // internal P2P_Record fields
      supplierCode,
      accountCode,
      costCenter: get("sourceErp"),
      poRef: get("poNo"),
      receiptRef: get("grId"),
      invoiceRef: get("invoiceNo"),
      quantity: get("invoicedQty"),
      price: get("invUnitPrice"),
      currency,
      // per-side 3-way fields
      poPrice: get("poUnitPrice"),
      receiptPrice: get("poUnitPrice"),
      invoicePrice: get("invUnitPrice"),
      poQuantity: get("invoicedQty"),
      invoiceQuantity: get("invoicedQty"),
      receiptQuantity: get("receivedQty"),
      poCurrency: currency,
      receiptCurrency: currency,
      invoiceCurrency: currency,
      // finance-domain fields (drive routing + evidence)
      financePoStatus: poStatus,
      rpaFirstPass: rpa,
      financeDecision: get("financeDecision"),
      reviewRoute: get("reviewRoute"),
      priceVariancePct: get("priceVariancePct"),
      verifiedReceivedQty: get("receivedQty"),
      approvedSpendEur: get("approvedSpendEur"),
      fxToEur: get("fxToEur"),
      globalSupplierId,
      standardSupplierName: get("standardSupplierName"),
      supportingEvidence: get("supportingEvidence"),
      financeReviewNotes: get("reviewNotes"),
      // derived routing hint (used by the finance pipeline in the controller)
      financeExceptionReason: clean ? null : (RPA_TO_REASON[rpa] || ExceptionReason.NO_MAPPING),
      lvmhSupplierId: null,
      lvmhAccountCode: null,
      status: "ingested",
    };
    seq += 1;

    if (!recordsByMaison[maisonId]) recordsByMaison[maisonId] = [];
    recordsByMaison[maisonId].push(record);

    if (clean) {
      cleanMatches += 1;
      // Derive an approved mapping for clean matches so they auto-normalize.
      const tupleKey = [maisonId, supplierCode, accountCode].join("\u0000");
      if (!mappingSeen.has(tupleKey) && supplierCode && globalSupplierId) {
        mappingSeen.set(tupleKey, {
          id: `fin-map-${mappingSeen.size + 1}`,
          maisonId,
          localSupplierCode: supplierCode,
          localAccountCode: accountCode,
          lvmhSupplierId: globalSupplierId,
          lvmhAccountCode: lvmhAccountCode,
          status: "approved",
          approvedBy: "finance-import",
          approvedAt: get("approvalDate") || new Date().toISOString(),
          origin: "finance_import",
        });
      }
    } else {
      exceptions += 1;
    }
  }

  return {
    recordsByMaison,
    maisonLabels,
    mappingEntries: [...mappingSeen.values()],
    parseErrors,
    stats: {
      rows: seq,
      maisons: Object.keys(recordsByMaison).length,
      cleanMatches,
      exceptions,
      mappingEntries: mappingSeen.size,
    },
  };
}
