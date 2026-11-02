// src/core/normalization.js
//
// Normalization_Module for the Cross-Maison P2P Reconciliation prototype.
//
// Normalization translates a Maison's local codes into the LVMH common
// vocabulary using ONLY approved Mapping_Entries. It never mutates a source
// record: normalizeRecord returns a COPY carrying the entry's lvmhSupplierId
// and lvmhAccountCode, while every original local code and the currency are
// left untouched (Req 16.2, 16.3). Records with no approved mapping are routed
// to the Exception_Queue with reason NO_MAPPING (Req 6.3).
//
// The module is pure: no DOM, no storage, no network. Callers that need live
// timestamps or id prefixes may pass them in via the options bag so the
// functions stay deterministic and testable.
//
// Requirements: 5.4, 6.1, 6.2, 6.3, 12.5, 16.2, 16.3

import { ExceptionReason } from "./constants.js";

/**
 * The approved status a Mapping_Entry must carry to be used for normalization.
 * Suggested / on_hold entries are excluded (Req 5.4, 6.1, 12.5).
 * @type {string}
 */
const APPROVED = "approved";

/**
 * Find the approved Mapping_Entry that matches a record's Maison identity and
 * local codes. Matching is on the full key tuple
 * `(maisonId, localSupplierCode, localAccountCode)` (Req 5.2) and considers
 * ONLY entries whose status is "approved" (Req 5.4, 6.1, 12.5). A record whose
 * only matching entries are non-approved yields no match (null).
 *
 * The first approved match wins; approval uniqueness per tuple is enforced on
 * approval (Req 12.3), so at most one approved entry is expected per tuple.
 *
 * @param {Object} record         a P2P_Record (needs maisonId, supplierCode,
 *                                accountCode)
 * @param {Object[]} mappingTable the Mapping_Table (array of Mapping_Entry)
 * @returns {Object|null}         the matching approved Mapping_Entry, or null
 */
export function findApprovedMapping(record, mappingTable) {
  if (!record || !Array.isArray(mappingTable)) return null;

  return (
    mappingTable.find(
      (entry) =>
        entry != null &&
        entry.status === APPROVED &&
        entry.maisonId === record.maisonId &&
        entry.localSupplierCode === record.supplierCode &&
        entry.localAccountCode === record.accountCode
    ) || null
  );
}

/**
 * Apply an approved Mapping_Entry to a P2P_Record. Returns a COPY of the
 * record with `lvmhSupplierId` and `lvmhAccountCode` assigned from the entry
 * (Req 6.2) and status advanced to "normalized". Every original Maison local
 * code (supplierCode, accountCode, costCenter, the reference fields, ...) and
 * the currency are preserved exactly (Req 16.2, 16.3). The input record is not
 * mutated.
 *
 * @param {Object} record       a P2P_Record
 * @param {Object} mappingEntry an approved Mapping_Entry to apply
 * @returns {Object}            a normalized copy of the record
 */
export function normalizeRecord(record, mappingEntry) {
  return {
    ...record,
    lvmhSupplierId: mappingEntry.lvmhSupplierId,
    lvmhAccountCode: mappingEntry.lvmhAccountCode,
    status: "normalized",
  };
}

/**
 * Build an ExceptionEntry for an unmapped / failed record. Keeps the full
 * record plus the local codes surfaced in the queue view (Req 10.2) and the
 * routing reason.
 *
 * @param {Object} record        the P2P_Record being queued
 * @param {string} reason        an ExceptionReason value
 * @param {Object} [opts]
 * @param {string} [opts.now]    ISO timestamp for enqueuedAt (defaults to now)
 * @param {string} [opts.idPrefix] prefix for the generated id (default "exc")
 * @param {Object} [opts.reasonDetail] optional structured detail
 * @returns {Object}             an ExceptionEntry
 */
function makeExceptionEntry(record, reason, opts = {}) {
  const { now, idPrefix = "exc", reasonDetail = null } = opts;
  return {
    id: `${idPrefix}-${record.processingId}`,
    record,
    maisonId: record.maisonId,
    localCodes: {
      supplierCode: record.supplierCode,
      accountCode: record.accountCode,
    },
    reason,
    reasonDetail,
    status: "open",
    rejectionReason: null,
    recommendation: null,
    enqueuedAt: now || new Date().toISOString(),
  };
}

/**
 * @typedef {Object} NormalizeBatchResult
 * @property {Object[]} normalized  Records with an approved mapping applied,
 *                                  ready for validation (status "normalized").
 * @property {Object[]} unmapped    ExceptionEntry objects for records with no
 *                                  approved mapping, reason NO_MAPPING.
 */

/**
 * Normalize a batch of ingested P2P_Records against the Mapping_Table. Each
 * record is matched to an approved Mapping_Entry: a match is normalized and
 * returned in `normalized`; a record with no approved match is routed to the
 * Exception_Queue as a NO_MAPPING ExceptionEntry in `unmapped` (Req 6.1–6.3).
 *
 * Every attempted record lands in exactly one of the two output arrays, so the
 * batch is partitioned without loss or duplication. Input records are not
 * mutated.
 *
 * @param {Object[]} records      ingested P2P_Records
 * @param {Object[]} mappingTable the Mapping_Table
 * @param {Object} [opts]         forwarded to ExceptionEntry construction
 *                                (e.g. { now } for a deterministic timestamp)
 * @returns {NormalizeBatchResult}
 */
export function normalizeBatch(records, mappingTable, opts = {}) {
  const normalized = [];
  const unmapped = [];

  for (const record of records || []) {
    const mappingEntry = findApprovedMapping(record, mappingTable);
    if (mappingEntry) {
      normalized.push(normalizeRecord(record, mappingEntry));
    } else {
      unmapped.push(
        makeExceptionEntry(record, ExceptionReason.NO_MAPPING, opts)
      );
    }
  }

  return { normalized, unmapped };
}

/**
 * @typedef {Object} RenormalizeResult
 * @property {Object[]} resolved     Records now normalized by a newly approved
 *                                   mapping; remove these from the queue
 *                                   (Req 10.4, 12.6).
 * @property {Object[]} stillQueued  ExceptionEntry objects that still have no
 *                                   approved mapping; they stay in the queue.
 * @property {Object[]} failures     ExceptionEntry objects whose normalization
 *                                   threw after a match; reason
 *                                   NORMALIZATION_FAILED (Req 12.7).
 */

/**
 * Re-run normalization over the Exception_Queue after an approval. For each
 * queued NO_MAPPING-style exception, look for an approved mapping that now
 * matches the record:
 *
 *  - a match whose normalization succeeds → `resolved` (drop from the queue);
 *  - no approved match → `stillQueued` (unchanged, keeps its original entry);
 *  - a match whose normalization throws → `failures`, re-tagged with reason
 *    NORMALIZATION_FAILED and a captured error message (Req 12.7).
 *
 * Exceptions that were queued for a reason other than a missing mapping (for
 * example validation failures) are only re-normalized if an approved mapping
 * now applies to them; otherwise they remain in `stillQueued` untouched.
 *
 * Input entries are not mutated. The three output arrays partition the queue.
 *
 * @param {Object[]} exceptionQueue  current Exception_Queue (ExceptionEntry[])
 * @param {Object[]} mappingTable    the Mapping_Table (post-approval)
 * @param {Object} [opts]            forwarded to ExceptionEntry construction
 * @returns {RenormalizeResult}
 */
export function renormalizeExceptions(exceptionQueue, mappingTable, opts = {}) {
  const resolved = [];
  const stillQueued = [];
  const failures = [];

  for (const entry of exceptionQueue || []) {
    const record = entry && entry.record;
    const mappingEntry = record
      ? findApprovedMapping(record, mappingTable)
      : null;

    if (!mappingEntry) {
      // No approved mapping now applies — leave the exception in place.
      stillQueued.push(entry);
      continue;
    }

    try {
      resolved.push(normalizeRecord(record, mappingEntry));
    } catch (err) {
      failures.push({
        ...entry,
        reason: ExceptionReason.NORMALIZATION_FAILED,
        reasonDetail: {
          ...(entry.reasonDetail || {}),
          error: err && err.message ? err.message : String(err),
        },
        status: "open",
      });
    }
  }

  return { resolved, stillQueued, failures };
}
