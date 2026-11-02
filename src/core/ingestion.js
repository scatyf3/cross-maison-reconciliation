// src/core/ingestion.js
//
// Ingestion_Module for the Cross-Maison P2P Reconciliation prototype. It loads
// a single Maison's extract (CSV text), delegates parsing to the CSV_Parser,
// and tags every resulting P2P_Record with:
//   - maisonId ...... the originating Maison identity (Req 4.3, 16.1)
//   - runId ......... the current reconciliation run id
//   - processingId .. an identifier unique across all records in the run
//                     (Req 4.4), of the form `${runId}:${zeroPaddedSequence}`.
//
// Parse errors surfaced by parseCsv are forwarded verbatim so the caller can
// report excluded rows (Req 4.5, 4.6). The module is pure: no DOM, no storage,
// and no network access.
//
// Requirements: 4.3, 4.4, 16.1

import { parseCsv } from "./csv.js";

/**
 * The width of the zero-padded sequence portion of a processing id. The design
 * example "run-3:000042" uses a six-digit sequence.
 * @type {number}
 */
const SEQUENCE_WIDTH = 6;

/**
 * Build a processing identifier from a run id and a sequence number. The
 * sequence is zero-padded to a fixed width so ids sort lexically within a run.
 *
 * Because the sequence is unique within the run and the runId prefix is fixed
 * per run, the resulting id is unique across all records in the run (Req 4.4).
 * Sequences wider than SEQUENCE_WIDTH are not truncated; they keep their full
 * length so uniqueness is preserved for very large extracts.
 *
 * @param {string|number} runId     the current reconciliation run id
 * @param {number} sequence         a non-negative, per-run-unique sequence
 * @returns {string}                e.g. "run-3:000042"
 */
export function makeProcessingId(runId, sequence) {
  const padded = String(sequence).padStart(SEQUENCE_WIDTH, "0");
  return `${runId}:${padded}`;
}

/**
 * @typedef {Object} IngestResult
 * @property {Object[]} records      Parsed P2P_Records, each tagged with
 *                                   maisonId, runId, and a unique processingId.
 * @property {Object[]} parseErrors  Parse errors forwarded from parseCsv.
 */

/**
 * Parse one Maison's extract and tag each produced P2P_Record with the Maison
 * identity, the run id, and a processing id unique within the run.
 *
 * Only valid rows become records (malformed rows are excluded by parseCsv and
 * reported in parseErrors). Each record's processing id is assigned from a
 * per-call sequence counter starting at 0, guaranteeing pairwise-distinct ids
 * for all records in this extract; combined with a run-unique runId prefix,
 * ids are unique across the whole run (Req 4.4).
 *
 * @param {string} maisonId   originating Maison id ("LV" | "DIOR" | "FENDI")
 * @param {string} csvText    the raw CSV text of the Maison_Extract
 * @param {string|number} runId  the current reconciliation run id
 * @returns {IngestResult}
 */
export function ingestExtract(maisonId, csvText, runId) {
  const { records, parseErrors } = parseCsv(csvText);

  const taggedRecords = records.map((record, index) => ({
    processingId: makeProcessingId(runId, index),
    runId,
    maisonId,
    ...record,
    status: "ingested",
  }));

  return { records: taggedRecords, parseErrors };
}
