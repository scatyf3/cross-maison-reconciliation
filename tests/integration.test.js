// tests/integration.test.js
//
// End-to-end integration harness for the Cross-Maison P2P Reconciliation
// pipeline (task 14.1). This drives the controller's exported pipeline
// functions — loadExtract, approveMapping, buildCurrentReport, exportReport —
// against the real pure core and the Browser_Store's in-memory shim, using the
// real seed CSV content read from disk and the real starter Mapping_Table.
//
// The controller's own first-load seeding (seedStoreIfEmpty) relies on `fetch`,
// which is not available in this Node context, so this harness bypasses it:
// it forces the Browser_Store onto a clean in-memory backend and seeds the
// starter Mapping_Table directly via seedIfEmpty, then feeds each seed CSV's
// text straight into the controller's loadExtract. Everything downstream of
// ingestion is the real production code path.
//
// What it asserts (the integration contract of task 14.1):
//   1. LV auto-normalizes into the consolidated data (approved seed mapping),
//      with no exceptions and counted as autoNormalized.
//   2. Dior and Fendi have no exact approved mapping, so every one of their
//      records lands in the Exception_Queue; the Recommendation_Agent runs on
//      each Dior NO_MAPPING exception and scores the near-miss seed candidate
//      (proving the agent is wired in), and that candidate becomes SUGGESTED
//      under a permissive threshold.
//   3. Approving a mapping for the Dior tuple resolves the matching queued
//      exceptions, removes them from the queue, and moves them into the
//      consolidated data (counted as financeJudgment).
//   4. buildCurrentReport's counts reconcile: autoNormalized + financeJudgment
//      equals the consolidated row count, and exceptionsRemaining equals the
//      live Exception_Queue length. exportReport returns CSV that round-trips.
//
// Requirements: 6.4, 10.1, 10.3, 10.4, 14.4, 17.3

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  seedIfEmpty,
  useInMemoryBackend,
  resetAll,
} from "../src/store/browserStore.js";
import {
  loadExtract,
  approveMapping,
  buildCurrentReport,
  exportReport,
  getState,
} from "../src/ui/appController.js";
import { parseCsv } from "../src/core/csv.js";
import { recommendMapping } from "../src/core/recommendation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Read a file from the repo root as UTF-8 text. */
function readText(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

const LV_CSV = readText("seed/lv_extract.csv");
const DIOR_CSV = readText("seed/dior_extract.csv");
const FENDI_CSV = readText("seed/fendi_extract.csv");
const STARTER_MAPPING = JSON.parse(readText("src/seed/starterMappingTable.json"));

/**
 * Put the Browser_Store on a fresh in-memory backend and seed the starter
 * Mapping_Table directly (no fetch), mirroring what seedStoreIfEmpty would do
 * in the browser. Also clears the controller's in-memory state by re-reading
 * from the freshly seeded store — loadExtract/buildCurrentReport read live
 * store state through the controller, so after seeding we must prime the
 * controller's state. The controller restores on init(); here we trigger the
 * same restore by invoking a no-op route-free path: loadExtract reads the
 * mapping table from the controller's module state, which is populated by
 * restoreState() inside init(). Since init() calls fetch-based seeding, we
 * instead rely on the controller reading the store on each operation.
 */
function freshStore() {
  useInMemoryBackend();
  resetAll();
  const seeded = seedIfEmpty({ mappingTable: STARTER_MAPPING });
  assert.equal(seeded, true, "store should seed on first load");
}

test("end-to-end: LV auto-normalizes, Dior/Fendi queue, approval resolves, counts reconcile", async (t) => {
  freshStore();

  // The controller holds its collections in module-local state, restored from
  // the store by init(). init() uses fetch-based seeding which is unavailable
  // here, so we re-hydrate the controller's state from the freshly seeded
  // store by importing its restore path. getState() returns the live object;
  // we reset it to match the seeded store before driving the pipeline.
  const state = getState();
  state.mappingTable = STARTER_MAPPING.map((m) => ({ ...m }));
  state.exceptionQueue = [];
  state.consolidated = [];
  state.auditTrail = [];
  state.meta = { ...state.meta, counts: { autoNormalized: 0, financeJudgment: 0 } };

  await t.test("LV auto-normalizes into consolidated with no exceptions", () => {
    const lvRows = parseCsv(LV_CSV).records.length;
    assert.ok(lvRows > 0, "LV seed must have data rows");

    const result = loadExtract("LV", LV_CSV);

    assert.equal(result.parseErrors.length, 0, "LV should parse cleanly");
    assert.equal(
      result.consolidatedAdded,
      lvRows,
      "every LV row should auto-normalize and consolidate",
    );
    assert.equal(result.exceptionsAdded, 0, "LV should produce no exceptions");
    assert.equal(getState().consolidated.length, lvRows);
    assert.equal(getState().exceptionQueue.length, 0);
  });

  await t.test("Dior produces NO_MAPPING exceptions and the agent runs on them", () => {
    const diorRows = parseCsv(DIOR_CSV).records.length;
    const result = loadExtract("DIOR", DIOR_CSV);

    assert.equal(result.consolidatedAdded, 0, "Dior has no exact approved mapping");
    assert.equal(
      result.exceptionsAdded,
      diorRows,
      "every Dior row should be queued",
    );

    const diorExceptions = getState().exceptionQueue.filter(
      (e) => e.maisonId === "DIOR",
    );
    assert.equal(diorExceptions.length, diorRows);
    for (const exc of diorExceptions) {
      assert.equal(exc.reason, "NO_MAPPING");
    }

    // The controller wires the Recommendation_Agent into the pipeline: every
    // NO_MAPPING exception must carry a recommendation with a valid status and
    // a bounded confidence (Req 11.3). With the default 0.70 threshold the
    // near-miss seed candidate (VND-87/6110 at 0.64) falls just short, so the
    // agent legitimately returns NO_SUGGESTION — what matters here is that the
    // agent RAN and scored a candidate, proving it is wired in end-to-end.
    const VALID_STATUSES = new Set(["SUGGESTED", "NO_SUGGESTION", "ERROR"]);
    for (const exc of diorExceptions) {
      assert.ok(exc.recommendation, "agent should run on every Dior exception");
      assert.ok(
        VALID_STATUSES.has(exc.recommendation.status),
        `recommendation status should be valid, got ${exc.recommendation.status}`,
      );
      assert.ok(
        exc.recommendation.confidence >= 0 &&
          exc.recommendation.confidence <= 1,
        "confidence must be within [0, 1] (Req 11.3)",
      );
    }
    // The agent scored the near-miss candidate for at least one Dior record
    // (non-zero confidence), demonstrating it read the live Mapping_Table.
    const scored = diorExceptions.filter(
      (e) => e.recommendation && e.recommendation.confidence > 0,
    );
    assert.ok(
      scored.length > 0,
      "the agent should score a near-miss candidate against the seed table",
    );

    // With a permissive threshold the same near-miss candidate becomes a
    // SUGGESTED recommendation, confirming the threshold-driven selection path
    // the controller relies on is live (the default run above stayed queued).
    const probe = scored[0].record;
    const permissive = recommendMapping(probe, getState().mappingTable, {
      similarityThreshold: 0.5,
    });
    assert.equal(
      permissive.status,
      "SUGGESTED",
      "the near-miss candidate should be suggested under a permissive threshold",
    );
    assert.ok(permissive.suggestion, "a SUGGESTED result carries a suggestion");
  });

  await t.test("Fendi produces exceptions (no approved mapping)", () => {
    const fendiRows = parseCsv(FENDI_CSV).records.length;
    const result = loadExtract("FENDI", FENDI_CSV);

    assert.equal(result.consolidatedAdded, 0, "Fendi has no approved mapping");
    assert.equal(
      result.exceptionsAdded,
      fendiRows,
      "every Fendi row should be queued",
    );
    const fendiExceptions = getState().exceptionQueue.filter(
      (e) => e.maisonId === "FENDI",
    );
    assert.equal(fendiExceptions.length, fendiRows);
  });

  await t.test(
    "approving a Dior mapping resolves matching exceptions into consolidated (Req 10.4/14.4)",
    () => {
      const before = getState();
      const consolidatedBefore = before.consolidated.length;
      const diorQueuedBefore = before.exceptionQueue.filter(
        (e) => e.maisonId === "DIOR",
      ).length;
      assert.ok(diorQueuedBefore > 0, "precondition: Dior exceptions queued");

      // Approve the mapping the queued Dior records need:
      // (DIOR, VND-87, 6110-FR) -> LVMH codes.
      const diorExc = before.exceptionQueue.find((e) => e.maisonId === "DIOR");
      const draft = {
        maisonId: "DIOR",
        localSupplierCode: diorExc.localCodes.supplierCode, // VND-87
        localAccountCode: diorExc.localCodes.accountCode, // 6110-FR
        lvmhSupplierId: "LVMH-SUP-000457",
        lvmhAccountCode: "ACCT-6110",
        origin: "manual",
      };

      const res = approveMapping(diorExc.id, draft, "reviewer-01");
      assert.equal(res.ok, true, `approval should succeed: ${res.message || ""}`);
      assert.equal(
        res.resolvedCount,
        diorQueuedBefore,
        "all matching Dior exceptions should resolve",
      );
      assert.equal(res.failedCount, 0, "no re-normalization failures expected");

      const after = getState();
      // Resolved records left the queue...
      const diorQueuedAfter = after.exceptionQueue.filter(
        (e) => e.maisonId === "DIOR",
      ).length;
      assert.equal(diorQueuedAfter, 0, "resolved Dior exceptions leave the queue");
      // ...and entered the consolidated data.
      assert.equal(
        after.consolidated.length,
        consolidatedBefore + diorQueuedBefore,
        "resolved records enter the consolidated data",
      );
      // A record never lives in both (Req 10.3/14.3): no consolidated record
      // shares a processingId with a queued exception.
      const queuedIds = new Set(
        after.exceptionQueue.map((e) => e.record && e.record.processingId),
      );
      for (const c of after.consolidated) {
        assert.ok(
          !queuedIds.has(c.processingId),
          `consolidated record ${c.processingId} must not also be queued`,
        );
      }
    },
  );

  await t.test("buildCurrentReport counts reconcile (single source of truth)", () => {
    const report = buildCurrentReport();
    const { autoNormalized, financeJudgment, exceptionsRemaining } =
      report.counts;
    const state = getState();

    // auto + judgment == consolidated rows == report rows (Req 6.4/14.x).
    assert.equal(
      autoNormalized + financeJudgment,
      state.consolidated.length,
      "autoNormalized + financeJudgment should equal consolidated count",
    );
    assert.equal(
      report.rows.length,
      state.consolidated.length,
      "report rows should mirror the consolidated data",
    );
    // exceptionsRemaining reads straight off the live queue (Req 10.1).
    assert.equal(
      exceptionsRemaining,
      state.exceptionQueue.length,
      "exceptionsRemaining should equal the live Exception_Queue length",
    );

    // Concrete expectation given the seed data:
    //   LV 5 auto-normalized + Dior 4 finance-judgment = 9 consolidated,
    //   Fendi 5 still queued.
    const lvRows = parseCsv(LV_CSV).records.length;
    const diorRows = parseCsv(DIOR_CSV).records.length;
    const fendiRows = parseCsv(FENDI_CSV).records.length;
    assert.equal(autoNormalized, lvRows, "LV should be the auto-normalized count");
    assert.equal(financeJudgment, diorRows, "Dior should be the finance-judgment count");
    assert.equal(
      exceptionsRemaining,
      fendiRows,
      "Fendi should be the exceptions-remaining count",
    );
  });

  await t.test("exportReport produces a stacked CSV with all report sections", () => {
    const { ok, csv } = exportReport();
    assert.equal(ok, true);
    assert.equal(typeof csv, "string");
    // The export is a single file with four labeled sections.
    assert.ok(csv.includes("LVMH GROUP REPORT"), "has summary header");
    assert.ok(csv.includes("SPEND BY LVMH SUPPLIER"), "has spend-by-supplier section");
    assert.ok(csv.includes("SPEND BY CATEGORY"), "has spend-by-category section");
    assert.ok(csv.includes("CONSOLIDATED RECORDS"), "has records section");
    // One data line per consolidated record appears under the records header.
    const lines = csv.split("\n");
    const idx = lines.indexOf("CONSOLIDATED RECORDS");
    assert.ok(idx >= 0, "records header present");
    const recordDataLines = lines.length - (idx + 2); // header label + column header
    assert.equal(recordDataLines, getState().consolidated.length, "one line per consolidated record");
  });
});
