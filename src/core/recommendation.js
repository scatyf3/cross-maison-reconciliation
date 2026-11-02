// src/core/recommendation.js
//
// Recommendation_Agent for the Cross-Maison P2P Reconciliation prototype.
//
// For an unmapped P2P_Record this module scores every existing Mapping_Entry,
// combines string similarity with Mapping_Table history, and surfaces the
// highest-scoring candidate as a read-only suggestion when its confidence
// reaches the configured similarity threshold. The whole computation is
// synchronous, in-memory, and deterministic: it issues no network call
// (Req 11.5) and never creates, modifies, or deletes any Mapping_Table entry
// (Req 11.1, 12.1). The returned suggestion is a deep clone of the candidate
// with status "suggested", so callers cannot reach back into the table.
//
// The algorithm implements Steps 3–6 of the "Recommendation / Similarity
// Algorithm" in the design (Steps 1–2 live in similarity.js):
//   termScore   = 0.6 * fieldSimilarity(supplier) + 0.4 * fieldSimilarity(account)
//   historyBoost = min(1, timesApprovedForTuple / H)       with H = 5
//   confidence  = clamp01(0.7 * termScore + 0.3 * historyBoost), rounded to 2 dp
// The candidate with the maximum confidence is selected; it becomes a
// SUGGESTED recommendation when that maximum is >= threshold, otherwise the
// agent returns NO_SUGGESTION (Req 11.2, 11.6).
//
// Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1

import { clamp01, fieldSimilarity } from "./similarity.js";
import { DEFAULT_SIMILARITY_THRESHOLD } from "./constants.js";

/**
 * History normalization constant: an entry whose tuple has been approved H or
 * more times receives the maximum history boost of 1.0 (design Step 4).
 * @type {number}
 */
export const HISTORY_SATURATION = 5;

/**
 * @typedef {Object} MatchedTerm
 * @property {string} field           The record field compared ("supplierCode" | "accountCode").
 * @property {string} recordValue     The record's local code.
 * @property {string} candidateValue  The candidate entry's local code.
 * @property {number} similarity      Per-field similarity in [0, 1], 2 dp.
 */

/**
 * @typedef {Object} HistoryUsed
 * @property {string|null} mappingEntryId  The candidate entry id.
 * @property {string|null} approvedAt      Candidate approval timestamp, if any.
 * @property {number} timesUsed            Approved entries sharing the candidate tuple.
 */

/**
 * @typedef {Object} SupportingEvidence
 * @property {MatchedTerm[]} matchedTerms   Per-term record/candidate comparison (Req 11.4).
 * @property {HistoryUsed[]} historyUsed    Mapping_Table history used in the score (Req 11.4).
 * @property {number} combinedScore         The selected candidate's confidence.
 * @property {number} threshold             The similarity threshold applied.
 * @property {string} method                Human-readable scoring formula.
 */

/**
 * @typedef {Object} Recommendation
 * @property {"SUGGESTED"|"NO_SUGGESTION"} status
 * @property {Object|null} suggestion   Deep-cloned candidate with status "suggested", or null.
 * @property {number} confidence        Max combined confidence, 0.00..1.00 inclusive (Req 11.3).
 * @property {SupportingEvidence} evidence
 */

/**
 * Round a number to two decimal places, keeping the result in [0, 1].
 * @param {number} value
 * @returns {number} the value rounded to 2 dp and clamped to [0, 1]
 */
function round2(value) {
  return clamp01(Math.round(value * 100) / 100);
}

/**
 * Deep clone a plain JSON-serializable value. Used so the returned suggestion
 * shares no reference with any entry in the passed-in Mapping_Table.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Count how many approved entries in the table share a candidate's key tuple
 * `(maisonId, localSupplierCode, localAccountCode)` — the "times approved for
 * tuple" used by the history boost (design Step 4).
 * @param {Object} candidate   The Mapping_Entry being scored.
 * @param {Object[]} mappingTable
 * @returns {number} count of approved entries with the same tuple
 */
function timesApprovedForTuple(candidate, mappingTable) {
  let count = 0;
  for (const entry of mappingTable) {
    if (
      entry.status === "approved" &&
      entry.maisonId === candidate.maisonId &&
      entry.localSupplierCode === candidate.localSupplierCode &&
      entry.localAccountCode === candidate.localAccountCode
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Score a single candidate Mapping_Entry against a record, returning the
 * component scores and the final rounded confidence (design Steps 3–5).
 * @param {Object} record         The unmapped P2P_Record.
 * @param {Object} candidate      A Mapping_Entry to score.
 * @param {Object[]} mappingTable The full table (for history lookups).
 * @param {number} historySaturation  H, the history normalization constant.
 * @returns {{ supplierSim: number, accountSim: number, termScore: number,
 *             historyBoost: number, timesApproved: number, confidence: number }}
 */
function scoreCandidate(record, candidate, mappingTable, historySaturation) {
  const supplierSim = fieldSimilarity(
    record.supplierCode,
    candidate.localSupplierCode,
  );
  const accountSim = fieldSimilarity(
    record.accountCode,
    candidate.localAccountCode,
  );

  // Step 3 — candidate (term) similarity, supplier weighted above account.
  const termScore = clamp01(0.6 * supplierSim + 0.4 * accountSim);

  // Step 4 — history boost from prior approvals of this candidate's tuple.
  const timesApproved = timesApprovedForTuple(candidate, mappingTable);
  const H = historySaturation > 0 ? historySaturation : HISTORY_SATURATION;
  const historyBoost = Math.min(1, timesApproved / H);

  // Step 5 — combined confidence, rounded to 2 dp and kept in [0, 1].
  const confidence = round2(0.7 * termScore + 0.3 * historyBoost);

  return {
    supplierSim: round2(supplierSim),
    accountSim: round2(accountSim),
    termScore,
    historyBoost,
    timesApproved,
    confidence,
  };
}

/**
 * Recommend a mapping for an unmapped P2P_Record.
 *
 * This is a PURE, READ-ONLY function: it never mutates `record`, `mappingTable`,
 * or any entry within it, and it performs no I/O or network call (Req 11.5).
 * It scores every Mapping_Entry, selects the one with the highest combined
 * confidence (Req 11.2), and returns it as a SUGGESTED recommendation when that
 * confidence is at or above the threshold, else NO_SUGGESTION (Req 11.6). The
 * suggested entry is a deep clone with status "suggested" (Req 11.1, 12.1).
 *
 * @param {Object} record  The unmapped P2P_Record to recommend a mapping for.
 * @param {Object[]} mappingTable  The Mapping_Table (array of Mapping_Entry).
 * @param {Object} [options]
 * @param {number} [options.similarityThreshold]  Minimum confidence to suggest
 *   (defaults to DEFAULT_SIMILARITY_THRESHOLD = 0.70).
 * @param {number} [options.historySaturation]  H, the history normalization
 *   constant (defaults to HISTORY_SATURATION = 5).
 * @returns {Recommendation}
 */
export function recommendMapping(record, mappingTable, options = {}) {
  const threshold =
    typeof options.similarityThreshold === "number"
      ? options.similarityThreshold
      : DEFAULT_SIMILARITY_THRESHOLD;
  const historySaturation =
    typeof options.historySaturation === "number" &&
    options.historySaturation > 0
      ? options.historySaturation
      : HISTORY_SATURATION;

  const table = Array.isArray(mappingTable) ? mappingTable : [];

  /** @type {{ candidate: Object, score: ReturnType<typeof scoreCandidate> }|null} */
  let best = null;
  for (const candidate of table) {
    if (!candidate || typeof candidate !== "object") continue;
    const score = scoreCandidate(record, candidate, table, historySaturation);
    if (best === null || score.confidence > best.score.confidence) {
      best = { candidate, score };
    }
  }

  // No candidates at all: nothing to suggest.
  if (best === null) {
    return {
      status: "NO_SUGGESTION",
      suggestion: null,
      confidence: 0,
      evidence: buildEvidence(record, null, null, threshold),
    };
  }

  const confidence = best.score.confidence;
  const evidence = buildEvidence(record, best.candidate, best.score, threshold);

  if (confidence >= threshold) {
    // Deep clone so the suggestion never aliases a table entry (read-only),
    // and present it in a non-approved "suggested" state (Req 11.1, 12.1).
    const suggestion = deepClone(best.candidate);
    suggestion.status = "suggested";
    suggestion.origin = "agent_suggestion";
    suggestion.approvedBy = null;
    suggestion.approvedAt = null;
    return { status: "SUGGESTED", suggestion, confidence, evidence };
  }

  return { status: "NO_SUGGESTION", suggestion: null, confidence, evidence };
}

/**
 * Build the Supporting_Evidence object describing how a candidate was scored:
 * matched terms with per-term similarity, the Mapping_Table history used, the
 * combined score, the threshold, and the scoring method (Req 11.4).
 * @param {Object} record
 * @param {Object|null} candidate
 * @param {ReturnType<typeof scoreCandidate>|null} score
 * @param {number} threshold
 * @returns {SupportingEvidence}
 */
function buildEvidence(record, candidate, score, threshold) {
  if (candidate === null || score === null) {
    return {
      matchedTerms: [],
      historyUsed: [],
      combinedScore: 0,
      threshold,
      method: "0.7*termScore + 0.3*historyBoost",
    };
  }

  const matchedTerms = [
    {
      field: "supplierCode",
      recordValue: record.supplierCode ?? null,
      candidateValue: candidate.localSupplierCode ?? null,
      similarity: score.supplierSim,
    },
    {
      field: "accountCode",
      recordValue: record.accountCode ?? null,
      candidateValue: candidate.localAccountCode ?? null,
      similarity: score.accountSim,
    },
  ];

  const historyUsed = [
    {
      mappingEntryId: candidate.id ?? null,
      approvedAt: candidate.approvedAt ?? null,
      timesUsed: score.timesApproved,
    },
  ];

  return {
    matchedTerms,
    historyUsed,
    combinedScore: score.confidence,
    threshold,
    method: "0.7*termScore + 0.3*historyBoost",
  };
}

/** Human-readable advice for ANY exception reason. Pure, read-only. */
export function adviseException(entry) {
  const reason = entry && entry.reason;
  const rec = (entry && entry.record) || {};
  const d = (entry && entry.reasonDetail) || {};
  const note = d.note || rec.financeReviewNotes || "";
  const MAP = {
    PRICE_MISMATCH: { headline: "Price variance between PO and invoice", action: "Approve the invoiced amount, or reject to hold for a PO amendment." },
    QUANTITY_MISMATCH: { headline: "Quantity over receipt", action: "Approve once the goods receipt is reconciled, or reject to hold." },
    CURRENCY_MISMATCH: { headline: "Currency mismatch across PO/receipt/invoice", action: "Approve with the verified currency, or reject to hold." },
    MISSING_REFERENCE: { headline: "Missing purchase order", action: "Approve once the PO is recovered, or reject to hold." },
    MISSING_FIELD: { headline: "Missing required field", action: "Approve once corrected, or reject to hold." },
    DUPLICATE_PO: { headline: "Duplicate purchase order", action: "Reject the duplicate, or approve if it is a legitimate separate line." },
    NORMALIZATION_FAILED: { headline: "Normalization failed", action: "Investigate and re-approve, or reject to hold." }
  };
  const base = MAP[reason] || { headline: "Needs finance review", action: "Approve to clear, or reject to hold for correction." };
  const detail = note || "Reviewer investigates the reason this record was flagged, then approves to clear or rejects to hold.";
  return { headline: base.headline, detail: detail, action: base.action };
}
