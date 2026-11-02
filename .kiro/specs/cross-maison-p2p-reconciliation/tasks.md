# Implementation Plan: Cross-Maison P2P Reconciliation

## Overview

This plan builds the prototype as a plain static web app (HTML, CSS, vanilla JavaScript ES modules) with no build step. Work proceeds bottom-up: scaffold the repo and shared constants, build the pure core (CSV, ingestion, normalization, validation, recommendation, consolidation, reporting) with property-based tests for the 20 design correctness properties, then the Browser_Store persistence layer, then the UI shell and its five views, then the seed data, and finally the GitHub Pages deployment setup. Each coding step is runnable and testable in isolation via the Node `node:test` + `fast-check` harness, and the final wiring step integrates everything into the live app shell.

Implementation language: **JavaScript (vanilla ES modules)**, as specified by the design. Tests use Node's built-in `node:test` runner with `fast-check` (property tests run `numRuns` ≥ 100).

## Tasks

- [x] 1. Scaffold repository, module mode, and shared constants
  - [x] 1.1 Create project skeleton and test-only package.json
    - Create the directory layout from the design: `index.html`, `styles/`, `src/core/`, `src/store/`, `src/seed/`, `src/ui/views/`, `seed/`, `tests/browser/`
    - Add `package.json` with `{ "type": "module", "scripts": { "test": "node --test tests/" } }` used ONLY for running tests (no app dependencies, no build)
    - Add `fast-check` as a devDependency for the Node test harness
    - Add `.nojekyll` at the repo root so GitHub Pages serves `src/` and underscore paths verbatim
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Define shared constants and enumerated vocabularies
    - Create `src/core/constants.js` exporting the fixed nine-column order (`supplierCode, accountCode, costCenter, poRef, receiptRef, invoiceRef, quantity, price, currency`), `ExceptionReason` (NO_MAPPING, MISSING_FIELD, MISSING_REFERENCE, PRICE_MISMATCH, CURRENCY_MISMATCH, QUANTITY_MISMATCH, DUPLICATE_PO, NORMALIZATION_FAILED), `ParseErrorReason` (MISSING_COLUMN, TYPE_RANGE), field type/range bounds, default `similarityThreshold` (0.70), and the common presentation currency (EUR)
    - These constants are shared by core modules, the UI, tests, and audit entries so they use one vocabulary
    - _Requirements: 4.2, 7.2, 8.2, 8.3, 8.4, 8.5, 9.2_

- [x] 2. Implement CSV_Parser / CSV_Serializer
  - [x] 2.1 Implement CSV parsing, serialization, and low-level helpers
    - Create `src/core/csv.js` with `parseCsv(csvText)`, `serializeCsv(records)`, `splitCsvLine(line)`, and `escapeCsvField(value)`
    - Handle RFC-4180 quoting (embedded commas, escaped quotes, `\r\n`/`\n` endings), require the nine-column header in fixed order, and emit one `{rowNumber, column, reason}` parse error per malformed row while continuing to parse the rest
    - Enforce field type/range rules: quantity integer 0–999,999,999; price decimal 0.00–999,999,999.99 with ≤ 2 dp; currency 3-letter A–Z code; serialize in the fixed nine-column order with a header row
    - _Requirements: 4.2, 4.5, 4.6, 4.7_

  - [ ]* 2.2 Write property test for CSV round trip
    - **Property 1: CSV round trip preserves all fields and Maison identity**
    - **Validates: Requirements 4.7, 4.8, 16.1**
    - In `tests/csv.test.js` using `arbP2PRecord`/`arbP2PRecordList` generators (`tests/generators.js`)

  - [ ]* 2.3 Write property test for parse error isolation
    - **Property 2: Parse error isolation**
    - **Validates: Requirements 4.2, 4.5, 4.6**
    - In `tests/csv.test.js` using the `arbMalformedRow` generator

- [x] 3. Implement Ingestion_Module
  - [x] 3.1 Implement extract ingestion and processing-id assignment
    - Create `src/core/ingestion.js` with `ingestExtract(maisonId, csvText, runId)` and `makeProcessingId(runId, sequence)`
    - Tag every parsed record with `maisonId`, `runId`, and a `processingId` of the form `${runId}:${zeroPaddedSequence}` unique within the run; forward parse errors from `parseCsv`
    - _Requirements: 4.3, 4.4, 16.1_

  - [ ]* 3.2 Write property test for processing-id uniqueness
    - **Property 3: Processing identifier uniqueness within a run**
    - **Validates: Requirements 4.4**
    - In `tests/ingestion.test.js`

- [x] 4. Implement Normalization_Module
  - [x] 4.1 Implement approved-mapping lookup and record normalization
    - Create `src/core/normalization.js` with `findApprovedMapping(record, mappingTable)`, `normalizeRecord(record, mappingEntry)`, `normalizeBatch(records, mappingTable)`, and `renormalizeExceptions(exceptionQueue, mappingTable)`
    - Match only entries with `status === "approved"` on the `(maisonId, localSupplierCode, localAccountCode)` tuple; assign `lvmhSupplierId`/`lvmhAccountCode` while preserving all original local codes and currency; route unmatched records to the queue as `NO_MAPPING`
    - `renormalizeExceptions` returns resolved records, still-queued exceptions, and `NORMALIZATION_FAILED` failures
    - _Requirements: 5.4, 6.1, 6.2, 6.3, 12.5, 16.2, 16.3_

  - [ ]* 4.2 Write property test for approved-only normalization
    - **Property 4: Normalization uses only approved mappings**
    - **Validates: Requirements 5.4, 6.3, 12.5**
    - In `tests/normalization.test.js` using the `arbMappingTable` generator

  - [ ]* 4.3 Write property test for LVMH assignment and local-code preservation
    - **Property 5: Normalization assigns LVMH codes and preserves local codes**
    - **Validates: Requirements 6.1, 6.2, 16.2, 16.3**
    - In `tests/normalization.test.js`

- [x] 5. Implement Validation_Module
  - [x] 5.1 Implement required-field, 3-way match, and duplicate-PO checks
    - Create `src/core/validation.js` with `validateRequiredFields(record)`, `threeWayMatch(record)`, `detectDuplicatePO(record, priorRecordsInMaison)`, and `validateRecord(record, context)`
    - Required fields: supplierCode, accountCode, poRef, receiptRef, invoiceRef, quantity, price, currency → `MISSING_FIELD` naming the field; 3-way match compares per-side price (abs diff 0.00), currency (all identical), quantity (all equal), with a missing reference → `MISSING_REFERENCE`; duplicate detection scoped per Maison on `poRef`, flagging the later record `DUPLICATE_PO` with references to both conflicting records
    - Failing records keep their data unchanged and retain the specific failure reason
    - _Requirements: 7.1, 7.2, 7.3, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 9.2, 9.3_

  - [ ]* 5.2 Write property test for required-field validation
    - **Property 6: Required-field validation**
    - **Validates: Requirements 7.1, 7.2, 7.3**
    - In `tests/validation.test.js`

  - [ ]* 5.3 Write property test for 3-way match correctness
    - **Property 7: 3-way match correctness with data preserved**
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.5, 8.6**
    - In `tests/validation.test.js` using the `arbThreeWaySides` generator

  - [ ]* 5.4 Write property test for per-Maison duplicate PO detection
    - **Property 8: Duplicate purchase order detection is per Maison**
    - **Validates: Requirements 9.1, 9.2, 9.3**
    - In `tests/validation.test.js` using the `arbRecordList` generator

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement similarity utilities and Recommendation_Agent
  - [x] 7.1 Implement similarity helpers
    - Create `src/core/similarity.js` with normalized Levenshtein similarity, token overlap (Jaccard), term normalization/tokenization on non-alphanumeric boundaries, and a per-field `fieldSimilarity = 0.5*levenshteinSim + 0.5*jaccard` clamped to [0,1]
    - _Requirements: 11.2_

  - [x] 7.2 Implement the read-only Recommendation_Agent
    - Create `src/core/recommendation.js` with `recommendMapping(record, mappingTable, options)`
    - Score candidates with `termScore = 0.6*supplierSim + 0.4*accountSim`, apply `historyBoost = min(1, timesApproved/H)`, combine `confidence = clamp01(0.7*termScore + 0.3*historyBoost)` rounded to 2 dp, select the max; return `SUGGESTED` (candidate `status: "suggested"`) when max ≥ threshold else `NO_SUGGESTION`; attach `SupportingEvidence` (matched terms, per-term scores, history used); perform no network call and never mutate the Mapping_Table
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1_

  - [ ]* 7.3 Write property test for confidence bounds
    - **Property 11: Recommendation confidence is bounded**
    - **Validates: Requirements 11.3**
    - In `tests/recommendation.test.js`

  - [ ]* 7.4 Write property test for threshold-based selection
    - **Property 12: Recommendation selects the highest-scoring candidate against the threshold**
    - **Validates: Requirements 11.2, 11.6**
    - In `tests/recommendation.test.js`

  - [ ]* 7.5 Write property test for evidence completeness
    - **Property 13: Recommendation evidence is complete**
    - **Validates: Requirements 11.4**
    - In `tests/recommendation.test.js`

  - [ ]* 7.6 Write property test for read-only agent behavior
    - **Property 14: The Recommendation_Agent is read-only**
    - **Validates: Requirements 11.1, 12.1**
    - In `tests/recommendation.test.js`

- [x] 8. Implement Consolidation_Module
  - [x] 8.1 Implement consolidation into the LVMH common structure
    - Create `src/core/consolidation.js` with `consolidate(normalizedPassedRecords)` producing `ConsolidatedRecord[]` keyed by `lvmhSupplierId`/`lvmhAccountCode` while retaining original local codes; exception-queue records are excluded by construction
    - _Requirements: 14.1, 14.2, 14.3_

  - [ ]* 8.2 Write property test for consolidated/queue partition
    - **Property 9: Consolidated data and Exception_Queue partition the attempted records**
    - **Validates: Requirements 6.4, 10.1, 10.3, 14.1, 14.2, 14.3**
    - In `tests/consolidation.test.js`

  - [ ]* 8.3 Write property test for resolving an exception
    - **Property 10: Resolving an exception removes it from the queue and consolidates it**
    - **Validates: Requirements 10.4, 12.6, 14.4**
    - In `tests/consolidation.test.js` (exercising `renormalizeExceptions` + `consolidate`)

- [x] 9. Implement Reporting_Module
  - [x] 9.1 Implement Group_Report builder and CSV export
    - Create `src/core/reporting.js` with `buildGroupReport(consolidated, mappingTable, counts)` and `exportGroupReportCsv(groupReport)`
    - Report rows express LVMH Supplier ID, LVMH Account Code, and the common-currency label; include the per-Maison local-supplier → LVMH-supplier mapping and counts `{ autoNormalized, financeJudgment, exceptionsRemaining }`; export via the CSV_Serializer in the common nine-column format
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [ ]* 9.2 Write property test for report count partition
    - **Property 17: Group_Report counts partition the attempted records**
    - **Validates: Requirements 15.3**
    - In `tests/reporting.test.js`

  - [ ]* 9.3 Write property test for LVMH codes, common currency, and supplier mapping
    - **Property 18: Group_Report presents LVMH codes, common currency, and supplier mapping**
    - **Validates: Requirements 15.1, 15.2**
    - In `tests/reporting.test.js`

  - [ ]* 9.4 Write property test for Group_Report CSV export round trip
    - **Property 19: Group_Report CSV export round trip**
    - **Validates: Requirements 15.4**
    - In `tests/reporting.test.js`

- [x] 10. Checkpoint - Ensure all core tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement Browser_Store persistence boundary
  - [x] 11.1 Implement the localStorage wrapper and governance mutations
    - Create `src/store/browserStore.js` with `KEYS`, `load(key, fallback)`, `save(key, value)`, `appendAudit(entry)`, `isFirstLoad()`, `seedIfEmpty(seedData)`, and `resetAll()`
    - `appendAudit` reads the current array and pushes only (append-only, nothing removed/altered); `load` falls back to defaults on missing/corrupt JSON per key; catch quota/unavailable errors and degrade to in-memory state; `meta` holds schemaVersion, similarityThreshold, reviewerId
    - Implement the approval mutation path (`approveMapping`-style helper) that adds an `approved` entry only when the draft is valid and non-conflicting with an existing approved tuple, records reviewer id + timestamp, appends the audit entry, and otherwise rejects leaving the table unchanged
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 12.2, 12.3, 13.1, 13.2, 13.3_

  - [ ]* 11.2 Write property test for approval add / invalid-conflict rejection
    - **Property 15: Approval adds an approved entry, and invalid or conflicting approvals leave the table unchanged**
    - **Validates: Requirements 12.2, 12.3**
    - In `tests/governance.test.js` using the `arbMappingTable` generator

  - [ ]* 11.3 Write property test for append-only audit trail
    - **Property 16: The Audit_Trail grows append-only and each entry is complete**
    - **Validates: Requirements 13.1, 13.2, 13.3**
    - In `tests/governance.test.js`

  - [ ]* 11.4 Write in-browser property test for persistence round trip
    - **Property 20: Browser_Store persistence round trip**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
    - In `tests/browser/index.html` against the real `localStorage`

- [x] 12. Implement seed data
  - [x] 12.1 Create seed CSV extracts and starter Mapping_Table
    - Create `seed/lv_extract.csv` (auto-normalized path: SUP-1042 / 6110 / EUR, consistent 3-way match), `seed/dior_extract.csv` (ambiguous-mapping path: VND-87 / 6110-FR / EUR, near-miss candidate), `seed/fendi_extract.csv` (validation-failure path: 77821 / 61-10 / USD, divergent per-side values or duplicate PO)
    - Create `src/seed/starterMappingTable.json` with the approved LV entry plus one or two historical approved entries giving Dior a near-miss candidate
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 12.2 Implement first-load seed loader
    - Create `src/seed/seedData.js` that `fetch`es the static `seed/*.csv` files and the starter Mapping_Table and populates the Browser_Store when it is empty on first load
    - _Requirements: 2.6_

  - [ ]* 12.3 Write unit tests for first-load seeding and seed content
    - Assert first-load seeds the Mapping_Table + extracts, that all three Maison extracts exist with local codes/currency, and that seeds exercise auto/ambiguous/failure paths
    - _Requirements: 2.6, 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 13. Implement UI shell and views
  - [x] 13.1 Implement the app controller and hash router
    - Create `src/ui/appController.js` with `init()`, `route(hash)`, `loadExtract(maisonId, csvText)`, `approveMapping(exceptionId, draft, reviewerId)`, `rejectResolution(exceptionId, reason)`, `exportReport()`
    - On init: seed if empty, restore state from the Browser_Store, route; wrap agent calls in try/catch to surface `ERROR` status while keeping the record queued; on resolution refresh the Exception Queue, Mapping Table, and Group Report views; `rejectResolution` keeps the record `on_hold_for_correction` with the reason; `exportReport` triggers a CSV Blob download
    - _Requirements: 2.5, 10.4, 11.7, 12.4, 12.6, 12.7, 17.1, 17.3_

  - [x] 13.2 Implement the Load Extracts and Exception Queue views
    - Create `src/ui/views/loadExtractsView.js` (choose/load a Maison extract) and `src/ui/views/exceptionQueueView.js` (per-record Maison, local codes, reason; show recommendation + evidence or a "no suggestion met the threshold" / error indication; approve/reject controls)
    - _Requirements: 10.2, 11.6, 11.7, 17.2_

  - [x] 13.3 Implement the Mapping Table, Audit Trail, and Group Report views
    - Create `src/ui/views/mappingTableView.js` (authoritative approved mappings), `src/ui/views/auditTrailView.js` (append-only log display), and `src/ui/views/groupReportView.js` (LVMH codes, common currency, supplier mapping, counts, CSV export button)
    - _Requirements: 5.5, 13.4, 15.1, 15.2, 15.3, 15.4, 17.2_

  - [x] 13.4 Create the app shell HTML and styles
    - Create `index.html` loading `src/ui/appController.js` as `<script type="module">` with navigation across the five views, and `styles/app.css` for a clean single-reviewer UI
    - _Requirements: 1.1, 17.1, 17.2_

  - [ ]* 13.5 Write example/integration tests for error paths and view presence
    - No-network guarantee (11.5), agent-error path (11.7), reject-resolution (12.4), normalization-failure (12.7), and view/router presence (17.2, 17.3)
    - In `tests/examples.test.js` (Node) and `tests/browser/index.html` (views)

- [x] 14. Wire the full pipeline and finalize deployment
  - [x] 14.1 Integrate the end-to-end pipeline through the controller
    - Wire load → ingest → normalize → validate → consolidate → report and the approval → re-normalize loop through `appController.js` so all five views operate on live Browser_Store state with no orphaned modules
    - _Requirements: 6.4, 10.1, 10.3, 10.4, 14.4, 17.3_

  - [ ]* 14.2 Write benchmark tests for timing bounds
    - Parse 100k rows < 60s (4.1), 3-way match < 5s (8.1), suggestion < 5s (11.1), run a few iterations
    - In `tests/bench.test.js`

  - [x] 14.3 Add GitHub Pages deployment setup and README
    - Confirm `.nojekyll` at root, ensure `index.html` and `src/` load as native ES modules with no build, and write `README.md` with local-run instructions (any static server) and step-by-step GitHub Pages deploy steps
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements and, where applicable, the exact design correctness property it validates for traceability.
- Property-based tests run with `fast-check` at `numRuns` ≥ 100 using Node's `node:test`; Property 20 and view tests run in the in-browser harness (`tests/browser/index.html`) against real `localStorage` and the DOM.
- Checkpoints ensure incremental validation; the app is runnable and testable after each core module lands and fully integrated at task 14.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "7.1", "12.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.1", "7.2", "11.1"] },
    { "id": 4, "tasks": ["3.2", "4.1", "7.3", "7.4", "7.5", "7.6", "8.1", "11.2", "11.3", "11.4", "12.2"] },
    { "id": 5, "tasks": ["4.2", "4.3", "5.1", "8.2", "8.3", "9.1", "12.3"] },
    { "id": 6, "tasks": ["5.2", "5.3", "5.4", "9.2", "9.3", "9.4", "13.1"] },
    { "id": 7, "tasks": ["13.2", "13.3", "13.4"] },
    { "id": 8, "tasks": ["13.5", "14.1"] },
    { "id": 9, "tasks": ["14.2", "14.3"] }
  ]
}
```
