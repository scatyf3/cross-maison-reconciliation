// src/core/consolidation.js
//
// Consolidation_Module for the Cross-Maison P2P Reconciliation prototype.
//
// Consolidation combines all normalized + validated P2P_Records from every
// Maison into the single LVMH common data structure (Req 14.1). Each record is
// represented through its canonical LVMH codes — `lvmhSupplierId` and
// `lvmhAccountCode` (Req 14.2) — while the Maison's original local codes and
// currency are retained alongside, preserving Maison autonomy (Req 16.3).
//
// Records that remain in the Exception_Queue are excluded by construction: the
// caller passes only records that were normalized AND passed validation, so no
// queued record can reach consolidation (Req 14.3). A record either lives in
// the consolidated data or in the Exception_Queue, never both.
//
// The module is pure: no DOM, no storage, no network, no mutation of inputs.
//
// Requirements: 14.1, 14.2, 14.3

/**
 * @typedef {Object} ConsolidatedRecord
 * @property {string} processingId     the record's run-unique processing id
 * @property {string} runId            the reconciliation run that produced it
 * @property {string} maisonId         the originating Maison ("LV"|"DIOR"|...)
 * @property {string} lvmhSupplierId   canonical LVMH Supplier ID (Req 14.2)
 * @property {string} lvmhAccountCode  canonical LVMH Account Code (Req 14.2)
 * @property {string} localSupplierCode the Maison's original supplier code (Req 16.3)
 * @property {string} localAccountCode  the Maison's original account code (Req 16.3)
 * @property {string} costCenter       the Maison's original cost center
 * @property {string} poRef            purchase order reference
 * @property {string} receiptRef       goods-receipt reference
 * @property {string} invoiceRef       invoice reference
 * @property {number} quantity         matched quantity
 * @property {number} price            matched price (in the local currency)
 * @property {string} currency         the Maison's original currency (Req 16.3)
 * @property {string} status           always "consolidated"
 */

/**
 * Build a single ConsolidatedRecord from a normalized, validated P2P_Record.
 *
 * The record is keyed by its canonical LVMH codes while its original Maison
 * local codes and currency are carried through unchanged (Req 14.2, 16.3). A
 * COPY is produced; the source record is never mutated.
 *
 * @param {Object} record a normalized + validated P2P_Record (carries
 *                        lvmhSupplierId / lvmhAccountCode)
 * @returns {ConsolidatedRecord}
 */
function toConsolidatedRecord(record) {
  return {
    processingId: record.processingId,
    runId: record.runId,
    maisonId: record.maisonId,

    // Canonical LVMH representation (Req 14.2).
    lvmhSupplierId: record.lvmhSupplierId,
    lvmhAccountCode: record.lvmhAccountCode,

    // Original Maison local codes + currency retained alongside (Req 16.3).
    localSupplierCode: record.supplierCode,
    localAccountCode: record.accountCode,
    costCenter: record.costCenter,
    poRef: record.poRef,
    receiptRef: record.receiptRef,
    invoiceRef: record.invoiceRef,
    quantity: record.quantity,
    price: record.price,
    currency: record.currency,

    // Finance-domain fields carried through for the Group Report + strategic
    // sourcing (present when loaded from the LVMH finance export; undefined
    // for the nine-column format, which the report renders as a dash).
    standardSupplierName: record.standardSupplierName,
    spendCategory: record.accountCode,
    approvedSpendEur: record.approvedSpendEur,
    fxToEur: record.fxToEur,
    invoicedQty: record.invoicedQty != null ? record.invoicedQty : record.quantity,
    resolvedVia: record.resolvedVia,

    status: "consolidated",
  };
}

/**
 * Consolidate normalized + validated P2P_Records into the LVMH common data
 * structure. Every input record is expected to already carry its approved LVMH
 * codes (from normalization) and to have passed validation; records still in
 * the Exception_Queue are excluded by construction because they are never
 * passed in (Req 14.3).
 *
 * The result is a ConsolidatedRecord[] in which each record is represented by
 * its `lvmhSupplierId` / `lvmhAccountCode` while retaining the Maison's
 * original local codes and currency (Req 14.1, 14.2, 16.3). Input order is
 * preserved and no record is dropped or duplicated; inputs are not mutated.
 *
 * @param {Object[]} normalizedPassedRecords P2P_Records that were normalized
 *                                           AND passed validation
 * @returns {ConsolidatedRecord[]}
 */
export function consolidate(normalizedPassedRecords) {
  if (!Array.isArray(normalizedPassedRecords)) return [];
  return normalizedPassedRecords.map(toConsolidatedRecord);
}
