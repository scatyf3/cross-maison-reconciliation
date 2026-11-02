// src/ui/appController.js
//
// App Controller & hash router for the Cross-Maison P2P Reconciliation
// prototype. This is the UI SHELL layer: it mediates between the DOM and the
// pure core (design: "UI Controller & Views"). The pure core modules
// (ingestion, normalization, validation, recommendation, consolidation,
// reporting) never touch the DOM or storage; this controller wires them to the
// Browser_Store and to the five view modules, holding the live in-memory app
// state in between.
//
// Responsibilities:
//   - init() ............ seed on first load, restore state from the
//                         Browser_Store (Req 2.5), wire the hash router, and
//                         route to the current hash.
//   - route(hash) ....... render one of five views for
//                         "#load" | "#exceptions" | "#mappings" | "#audit" |
//                         "#report" (default "#load") (Req 17.1, 17.2).
//   - loadExtract() ..... run the load -> ingest -> normalize -> validate ->
//                         consolidate pipeline for one Maison extract, routing
//                         failures/unmapped records to the Exception_Queue and
//                         running the (try/catch-guarded) Recommendation_Agent
//                         on NO_MAPPING exceptions (Req 11.7).
//   - approveMapping() .. approve a draft through the Browser_Store governance
//                         path, then re-normalize matching queued records
//                         (Req 12.6), consolidate the resolved ones, handle
//                         NORMALIZATION_FAILED (Req 12.7), and refresh the
//                         Exception Queue, Mapping Table, and Group Report
//                         views (Req 17.3).
//   - rejectResolution() set an exception to "on_hold_for_correction" with the
//                         reviewer's reason, keeping it in the queue (Req 12.4).
//   - exportReport() .... build the Group_Report and trigger a CSV Blob
//                         download in the browser (Req 15.4).
//
// VIEW-MODULE DEPENDENCY NOTE: the five view modules live in
// `src/ui/views/` and are implemented by tasks 13.2 / 13.3
// (loadExtractsView, exceptionQueueView, mappingTableView, auditTrailView,
// groupReportView). They may not exist yet when this controller lands. The
// router therefore imports them LAZILY (dynamic `import()`), wrapped in
// try/catch, so a missing view degrades to a simple placeholder render instead
// of throwing — and so this module passes `node --check` and loads in the
// browser before the views are written. Each view is expected to export a
// `render(container, state, handlers)` function (design: "UI Controller &
// Views"). Once the views exist, no change to this controller is required.
//
// Requirements: 2.5, 10.4, 11.7, 12.4, 12.6, 12.7, 17.1, 17.3

import {
  KEYS,
  load,
  save,
  defaultMeta,
  approveMapping as storeApproveMapping,
  appendAudit,
  resetAll,
} from "../store/browserStore.js";
import { seedStoreIfEmpty } from "../seed/seedData.js";
import { ingestExtract } from "../core/ingestion.js";
import { normalizeBatch, renormalizeExceptions } from "../core/normalization.js";
import { validateRecord } from "../core/validation.js";
import { recommendMapping, adviseException } from "../core/recommendation.js";
import { consolidate } from "../core/consolidation.js";
import { buildGroupReport, exportGroupReportCsv } from "../core/reporting.js";
import { ExceptionReason } from "../core/constants.js";
import { normalizeRecord, findApprovedMapping } from "../core/normalization.js";
import {
  detectFinanceFormat,
  parseFinanceCsv,
} from "../core/financeAdapter.js";

/**
 * The hash routes the controller renders and the view module each maps to.
 * The map key (without the leading "#") doubles as the view module file name
 * under `src/ui/views/`. Order defines nav order; "#load" is the default.
 * @readonly
 */
export const ROUTES = Object.freeze({
  "#load": "loadExtractsView",
  "#exceptions": "exceptionQueueView",
  "#mappings": "mappingTableView",
  "#report": "groupReportView",
  "#sourcing": "strategicSourcingView",
});

/** The route used when the hash is empty or unknown. */
export const DEFAULT_ROUTE = "#load";

/**
 * The live, in-memory application state. Restored from the Browser_Store on
 * init() and written back on every mutation so a reload rehydrates it
 * (Req 2.5). `seedExtracts` holds the raw seed CSV text keyed by maisonId so
 * the Load Extracts view can offer the seeded extracts for ingestion.
 */
const state = {
  mappingTable: [],
  exceptionQueue: [],
  consolidated: [],
  auditTrail: [],
  meta: defaultMeta(),
  /** @type {Object<string,string>} rawCSV keyed by maisonId, from the seed */
  seedExtracts: {},
  /** @type {{id:string,label:string,path:string}[]} seed extract descriptors */
  seedExtractMeta: [],
  /** The current hash route. */
  currentRoute: DEFAULT_ROUTE,
};

/**
 * Read-only accessor for the current in-memory state (used by views/tests).
 * @returns {typeof state}
 */
export function getState() {
  return state;
}

// ---------------------------------------------------------------------------
// State persistence helpers.
// ---------------------------------------------------------------------------

/**
 * Restore all four persisted collections plus meta from the Browser_Store into
 * the in-memory state (Req 2.5). Missing/corrupt keys fall back to safe
 * defaults inside `load`.
 * @returns {void}
 */
function restoreState() {
  state.mappingTable = load(KEYS.mappingTable, []);
  state.exceptionQueue = load(KEYS.exceptionQueue, []);
  state.consolidated = load(KEYS.consolidated, []);
  state.auditTrail = load(KEYS.auditTrail, []);
  state.meta = { ...defaultMeta(), ...load(KEYS.meta, {}) };
}

/**
 * Persist the Exception_Queue, consolidated data, and meta (which carries the
 * run counts) back to the Browser_Store. The Mapping_Table and Audit_Trail are
 * written by the Browser_Store governance path (approveMapping / appendAudit),
 * so they are only re-synced into memory here, not re-saved.
 * @returns {void}
 */
function persistState() {
  save(KEYS.exceptionQueue, state.exceptionQueue);
  save(KEYS.consolidated, state.consolidated);
  save(KEYS.meta, state.meta);
}

/**
 * Re-sync the Mapping_Table and Audit_Trail from the store into memory after a
 * governance mutation performed by the Browser_Store.
 * @returns {void}
 */
function syncGovernanceState() {
  state.mappingTable = load(KEYS.mappingTable, []);
  state.auditTrail = load(KEYS.auditTrail, []);
}

/**
 * Read and increment the monotonic run counter, returning the new run id
 * string (e.g. "run-3"). Persisted so run ids stay unique across reloads
 * (Req 4.4 relies on a per-run-unique prefix).
 * @returns {string} the new run id
 */
function nextRunId() {
  const current = load(KEYS.runCounter, 0);
  const next = (typeof current === "number" ? current : 0) + 1;
  save(KEYS.runCounter, next);
  return `run-${next}`;
}

// ---------------------------------------------------------------------------
// Run counts (Req 15.3) — tracked in meta so they survive reloads.
// ---------------------------------------------------------------------------

/**
 * Ensure the run-count buckets exist on meta, defaulting to 0. autoNormalized
 * counts records normalized with no reviewer action; financeJudgment counts
 * records resolved via an approval. exceptionsRemaining is derived from the
 * live queue at report time.
 * @returns {{autoNormalized:number, financeJudgment:number}}
 */
function ensureCounts() {
  if (!state.meta.counts || typeof state.meta.counts !== "object") {
    state.meta.counts = { autoNormalized: 0, financeJudgment: 0 };
  }
  if (typeof state.meta.counts.autoNormalized !== "number") {
    state.meta.counts.autoNormalized = 0;
  }
  if (typeof state.meta.counts.financeJudgment !== "number") {
    state.meta.counts.financeJudgment = 0;
  }
  return state.meta.counts;
}

// ---------------------------------------------------------------------------
// init / router.
// ---------------------------------------------------------------------------

/**
 * Initialize the app: seed the Browser_Store on first load, keep the loaded
 * seed extracts available for the Load Extracts view, restore the persisted
 * state into memory (Req 2.5), wire the hash-change listener, and route to the
 * current hash.
 *
 * @returns {Promise<void>}
 */
export async function init() {
  // First-load seeding (Req 2.6). Never clobbers prior reviewer edits.
  try {
    const result = await seedStoreIfEmpty();
    if (result && result.seedData) {
      state.seedExtracts = result.seedData.extracts || {};
      state.seedExtractMeta = result.seedData.extractMeta || [];
    }
  } catch (err) {
    // Seeding failure must not block the app; surface it and continue with
    // whatever is already persisted (graceful degradation).
    logWarning("Seed load failed; continuing with persisted state.", err);
  }

  // Restore persisted collections into memory (Req 2.5).
  restoreState();

  // Wire the hash router (browser only).
  if (typeof window !== "undefined") {
    window.onhashchange = () => {
      route(currentHash());
    };
  }

  route(currentHash());
}

/**
 * The current location hash, or the default route outside a browser.
 * @returns {string}
 */
function currentHash() {
  if (typeof window !== "undefined" && window.location && window.location.hash) {
    return window.location.hash;
  }
  return DEFAULT_ROUTE;
}

/**
 * Resolve the app root container the views render into. Falls back to null
 * outside a browser (so routing is a no-op under Node / tests).
 * @returns {Element|null}
 */
function appRoot() {
  if (typeof document === "undefined") return null;
  return document.getElementById("app") || document.body || null;
}

/**
 * Route to one of the five views for the given hash, defaulting unknown hashes
 * to "#load" (Req 17.1, 17.2). The view module is imported lazily so a view
 * not yet implemented (tasks 13.2/13.3) degrades to a placeholder rather than
 * crashing the shell.
 *
 * @param {string} hash  e.g. "#exceptions"
 * @returns {void}
 */
export function route(hash) {
  const resolved = ROUTES[hash] ? hash : DEFAULT_ROUTE;
  state.currentRoute = resolved;

  const container = appRoot();
  if (!container) return; // non-browser context: nothing to render.

  renderView(ROUTES[resolved], container);
}

/**
 * The handlers object passed to every view so view event callbacks can drive
 * the controller without importing it directly.
 * @returns {Object}
 */
function viewHandlers() {
  return {
    navigate: route,
    loadExtract,
    loadFinanceExtract,
    approveMapping,
    resolveException,
    addMapping,
    deleteMapping,
    rejectResolution,
    exportReport,
  };
}

/**
 * Lazily import a view module and call its `render(container, state, handlers)`
 * function. If the module is missing or lacks a render export (views land in a
 * later task), render a minimal placeholder so the shell stays usable.
 *
 * @param {string} viewName  the view module base name (e.g. "loadExtractsView")
 * @param {Element} container
 * @returns {Promise<void>}
 */
async function renderView(viewName, container) {
  try {
    const mod = await import(`./views/${viewName}.js`);
    if (mod && typeof mod.render === "function") {
      mod.render(container, state, viewHandlers());
      return;
    }
    renderPlaceholder(container, viewName, "view has no render() export yet");
  } catch (err) {
    renderPlaceholder(container, viewName, "view module not available yet");
    logWarning(`View "${viewName}" could not be rendered.`, err);
  }
}

/**
 * Minimal placeholder shown when a view module is not yet available. Keeps the
 * shell navigable before tasks 13.2/13.3 implement the views.
 * @param {Element} container
 * @param {string} viewName
 * @param {string} note
 * @returns {void}
 */
function renderPlaceholder(container, viewName, note) {
  if (typeof document === "undefined") return;
  container.innerHTML = "";
  const section = document.createElement("section");
  section.className = "view-placeholder";
  const h = document.createElement("h2");
  h.textContent = viewName;
  const p = document.createElement("p");
  p.textContent = note;
  section.appendChild(h);
  section.appendChild(p);
  container.appendChild(section);
}

// ---------------------------------------------------------------------------
// Pipeline: load -> ingest -> normalize -> validate -> consolidate.
// ---------------------------------------------------------------------------

/**
 * Load one Maison's extract through the full pipeline and persist the results.
 *
 * Steps:
 *   1. allocate a new run id (monotonic counter);
 *   2. ingest the CSV into tagged P2P_Records (parse errors forwarded);
 *   3. normalize the batch against the approved Mapping_Table — unmapped
 *      records become NO_MAPPING exceptions;
 *   4. validate each normalized record, tracking prior records per Maison for
 *      duplicate-PO detection; passed records are consolidated (and counted as
 *      auto-normalized, Req 15.3), failed records become exceptions;
 *   5. run the Recommendation_Agent on every NO_MAPPING exception, wrapped in
 *      try/catch so a thrown computation yields recommendation
 *      `status: "ERROR"` and the record STAYS queued (Req 11.7);
 *   6. persist all state and refresh the current view.
 *
 * @param {string} maisonId  "LV" | "DIOR" | "FENDI"
 * @param {string} csvText   the raw extract CSV text
 * @returns {{ runId:string, parseErrors:Object[], consolidatedAdded:number,
 *             exceptionsAdded:number }}
 */
export function loadExtract(maisonId, csvText) {
  const runId = nextRunId();

  // 2. Ingest.
  const { records, parseErrors } = ingestExtract(maisonId, csvText, runId);

  // 3. Normalize against approved mappings.
  const { normalized, unmapped } = normalizeBatch(records, state.mappingTable);

  // 4. Validate normalized records; track prior records per Maison so
  //    duplicate-PO detection sees siblings from this run AND already-loaded
  //    records across prior runs.
  const priorByMaison = buildPriorByMaison();
  const passed = [];
  const newExceptions = [...unmapped];

  for (const record of normalized) {
    const prior = priorByMaison.get(record.maisonId) || [];
    const result = validateRecord(record, { priorRecordsInMaison: prior });
    // Count this record as "seen" for subsequent duplicate checks regardless
    // of outcome.
    prior.push(record);
    priorByMaison.set(record.maisonId, prior);

    if (result.passed) {
      passed.push(record);
    } else {
      newExceptions.push(
        makeExceptionEntry(record, result.reason, result.detail),
      );
    }
  }

  // 5. Attach guidance to every exception (mapping suggestion for NO_MAPPING,
  //    advisory for validation-type reasons).
  for (const exc of newExceptions) adviseEntry(exc);

  // 4 (cont). Consolidate the passed records and count them as auto-normalized.
  const consolidatedAdded = tag(consolidate(passed), "auto");
  state.consolidated = [...state.consolidated, ...consolidatedAdded];

  // Append the new exceptions to the queue.
  state.exceptionQueue = [...state.exceptionQueue, ...newExceptions];

  // 6. Persist and refresh.
  persistState();
  refreshCurrentView();

  return {
    runId,
    parseErrors,
    consolidatedAdded: consolidatedAdded.length,
    exceptionsAdded: newExceptions.length,
  };
}

/**
 * Load a 30-column LVMH finance export (LVMH_Finance_Approved_Transactions.csv
 * style). Detects the format, imports the derived approved mappings into the
 * governed Mapping_Table (with one audit entry), then runs every Maison's
 * records through the pipeline. Unlike loadExtract, routing uses the file's own
 * finance governance columns (RPA First Pass / PO Status): a record
 * auto-consolidates only if it has an approved mapping AND its finance status
 * is a clean MATCHED; otherwise it is routed to the Exception_Queue with the
 * reason the adapter derived from the file (financeExceptionReason), and the
 * Recommendation_Agent runs on NO_MAPPING cases. This is the finance-import
 * routing policy: it respects the file's human/RPA decisions rather than the
 * strict 0.00 three-way tolerance (real invoices carry small variances).
 *
 * @param {string} csvText
 * @returns {{ ok:boolean, error?:string, maisons?:string[], consolidatedAdded?:number,
 *             exceptionsAdded?:number, mappingEntriesImported?:number, parseErrors?:Object[] }}
 */
export function loadFinanceExtract(csvText) {
  if (!detectFinanceFormat(csvText)) {
    return {
      ok: false,
      error:
        "This does not look like the 30-column LVMH finance export. Use the " +
        "nine-column loader for the standard extract format.",
    };
  }

  const { recordsByMaison, maisonLabels, mappingEntries, parseErrors, stats } =
    parseFinanceCsv(csvText);

  // Import derived approved mappings into the governed table (dedupe by tuple).
  const existing = state.mappingTable;
  const tupleKey = (m) =>
    [m.maisonId, m.localSupplierCode, m.localAccountCode].join("\u0000");
  const have = new Set(existing.map(tupleKey));
  const imported = [];
  for (const entry of mappingEntries) {
    if (!have.has(tupleKey(entry))) {
      imported.push(entry);
      have.add(tupleKey(entry));
    }
  }
  if (imported.length > 0) {
    state.mappingTable = [...existing, ...imported];
    save(KEYS.mappingTable, state.mappingTable);
    appendAudit({
      actor: state.meta.reviewerId || "finance-import",
      timestamp: new Date().toISOString(),
      action: "IMPORT",
      priorValue: null,
      newValue: { importedCount: imported.length, origin: "finance_import" },
      promptedByProcessingId: null,
    });
    state.auditTrail = load(KEYS.auditTrail, []);
  }

  // Run each Maison's records through the finance pipeline.
  let consolidatedAdded = 0;
  let exceptionsAdded = 0;
  const counts = ensureCounts();
  for (const maisonId of Object.keys(recordsByMaison)) {
    const records = recordsByMaison[maisonId];
    const passed = [];
    const exceptions = [];
    for (const record of records) {
      const approved = findApprovedMapping(record, state.mappingTable);
      const cleanFinance = !record.financeExceptionReason;
      if (approved && cleanFinance) {
        passed.push(normalizeRecord(record, approved));
      } else {
        const reason = record.financeExceptionReason || ExceptionReason.NO_MAPPING;
        const exc = makeExceptionEntry(record, reason, {
          financePoStatus: record.financePoStatus,
          rpaFirstPass: record.rpaFirstPass,
          reviewRoute: record.reviewRoute,
          priceVariancePct: record.priceVariancePct,
          note: record.financeReviewNotes,
        });
        adviseEntry(exc);
        exceptions.push(exc);
      }
    }
    const consolidatedRecords = tag(consolidate(passed), "auto");
    state.consolidated = [...state.consolidated, ...consolidatedRecords];
    state.exceptionQueue = [...state.exceptionQueue, ...exceptions];
    counts.autoNormalized += consolidatedRecords.length;
    consolidatedAdded += consolidatedRecords.length;
    exceptionsAdded += exceptions.length;
  }

  persistState();
  refreshCurrentView();

  return {
    ok: true,
    maisons: Object.keys(recordsByMaison).map((id) => maisonLabels[id] || id),
    consolidatedAdded,
    exceptionsAdded,
    mappingEntriesImported: imported.length,
    parseErrors,
    stats,
  };
}

/**
 * Build a per-Maison list of records already seen (from the consolidated data
 * and the records held on existing exception entries) so duplicate-PO
 * detection in a new run can see prior history within each Maison.
 * @returns {Map<string, Object[]>}
 */
function buildPriorByMaison() {
  const map = new Map();
  const add = (rec) => {
    if (!rec || !rec.maisonId) return;
    const list = map.get(rec.maisonId) || [];
    list.push(rec);
    map.set(rec.maisonId, list);
  };
  for (const c of state.consolidated) add(c);
  for (const e of state.exceptionQueue) if (e && e.record) add(e.record);
  return map;
}

/**
 * Run the Recommendation_Agent for a record, wrapped so any thrown computation
 * becomes a recommendation of `status: "ERROR"` rather than aborting the
 * pipeline; the record is left queued for manual mapping (Req 11.7).
 *
 * @param {Object} record  the unmapped P2P_Record
 * @returns {Object} a recommendation object (SUGGESTED | NO_SUGGESTION | ERROR)
 */
function runRecommendation(record) {
  try {
    return recommendMapping(record, state.mappingTable, {
      similarityThreshold: state.meta.similarityThreshold,
    });
  } catch (err) {
    logWarning("Recommendation computation failed; record stays queued.", err);
    return {
      status: "ERROR",
      suggestion: null,
      confidence: 0,
      evidence: null,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Build an ExceptionEntry for a failed/unmapped record, mirroring the shape the
 * Normalization_Module uses so the Exception_Queue is uniform.
 * @param {Object} record
 * @param {string} reason      an ExceptionReason value
 * @param {Object|null} detail structured failure detail
 * @returns {Object} an ExceptionEntry
 */
function makeExceptionEntry(record, reason, detail = null) {
  return {
    id: `exc-${record.processingId}`,
    record,
    maisonId: record.maisonId,
    localCodes: {
      supplierCode: record.supplierCode,
      accountCode: record.accountCode,
    },
    reason,
    reasonDetail: detail,
    status: "open",
    rejectionReason: null,
    recommendation: null,
    enqueuedAt: new Date().toISOString(),
  };
}


// --- Resolution helpers ---------------------------------------------------

/** Tag consolidated records with how they were resolved (for report counts). */
function tag(records, resolvedVia) {
  return (records || []).map((r) => ({ ...r, resolvedVia }));
}

/** Attach guidance to an exception entry: a mapping suggestion for NO_MAPPING,
 *  plus an advisory for every reason so the reviewer always has context. */
function adviseEntry(exc) {
  if (!exc) return;
  if (exc.reason === ExceptionReason.NO_MAPPING) {
    exc.recommendation = runRecommendation(exc.record);
  }
  try { exc.advice = adviseException(exc); } catch (e) { exc.advice = null; }
}

/**
 * Resolve an exception by HUMAN OVERRIDE (approve-with-reason), mirroring the
 * map finance-review -> approve loop: the reviewer confirms the record is OK
 * as-is (price variance within tolerance, goods receipt reconciled, PO
 * recovered). The record leaves the queue and enters the consolidated data
 * tagged resolvedVia override. A NO_MAPPING record cannot be overridden (it
 * has no LVMH codes yet) so we block that and point to approveMapping. An
 * audit entry is recorded. (Req 10.4 / 14.4 / 13.x)
 * @param {string} exceptionId
 * @param {string} reason reviewer approval note
 * @returns {{ ok:boolean, error?:string }}
 */
export function resolveException(exceptionId, reason) {
  const index = state.exceptionQueue.findIndex((e) => e && e.id === exceptionId);
  if (index === -1) return { ok: false, error: "NOT_FOUND" };
  const entry = state.exceptionQueue[index];
  if (entry.reason === ExceptionReason.NO_MAPPING) {
    return { ok: false, error: "Approve a mapping for this record instead (it has no LVMH supplier yet)." };
  }
  const reviewer = state.meta.reviewerId || "reviewer-01";
  const consolidatedRecords = tag(consolidate([entry.record]), "override");
  state.consolidated = [...state.consolidated, ...consolidatedRecords];
  state.exceptionQueue = [
    ...state.exceptionQueue.slice(0, index),
    ...state.exceptionQueue.slice(index + 1),
  ];
  appendAudit({
    actor: reviewer,
    timestamp: new Date().toISOString(),
    action: "OVERRIDE",
    priorValue: { reason: entry.reason, processingId: entry.record && entry.record.processingId },
    newValue: { resolvedVia: "override", note: reason || "" },
    promptedByProcessingId: entry.record && entry.record.processingId,
  });
  state.auditTrail = load(KEYS.auditTrail, []);
  persistState();
  refreshViews(["#exceptions", "#audit", "#report"]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Governance: approve / reject.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ApproveControllerResult
 * @property {boolean} ok              whether the approval was applied
 * @property {string} [error]          failure code from the store on rejection
 * @property {string} [message]        human-readable failure detail
 * @property {Object} [entry]          the approved Mapping_Entry (on success)
 * @property {number} [resolvedCount]  queued records resolved by the approval
 * @property {number} [failedCount]    records that failed re-normalization
 */

/**
 * Approve a Mapping_Entry draft and resolve the exceptions it unlocks.
 *
 * Flow:
 *   1. delegate to the Browser_Store governance path, which validates the
 *      draft, rejects conflicts, stamps reviewer id + timestamp, appends the
 *      Audit_Trail entry, and returns the new table (Req 12.2, 12.3, 13.x). On
 *      failure the table is unchanged and we surface the error.
 *   2. on success, re-sync the Mapping_Table/Audit_Trail into memory and run
 *      `renormalizeExceptions` over the live queue: records the new entry now
 *      matches are normalized and removed from the queue (Req 12.6), the rest
 *      stay queued, and any that fail re-normalization are retained with reason
 *      NORMALIZATION_FAILED (Req 12.7).
 *   3. consolidate the resolved records (Req 10.4 / 14.4), bump the
 *      finance-judgment count, persist, and refresh the Exception Queue,
 *      Mapping Table, and Group Report views (Req 17.3).
 *
 * @param {string} exceptionId  the exception that prompted the approval (for audit)
 * @param {Object} draft        the candidate Mapping_Entry
 * @param {string} [reviewerId] acting Finance_Reviewer (defaults to meta.reviewerId)
 * @returns {ApproveControllerResult}
 */
export function approveMapping(exceptionId, draft, reviewerId) {
  const reviewer = reviewerId || state.meta.reviewerId || "reviewer-01";
  const prompted = findException(exceptionId);
  const promptedByProcessingId =
    prompted && prompted.record ? prompted.record.processingId : null;

  // 1. Governance mutation through the store (the only approved-entry writer).
  const result = storeApproveMapping(draft, reviewer, {
    promptedByProcessingId,
  });

  if (!result.ok) {
    // Table left unchanged (Req 12.3); surface the specific reason.
    return {
      ok: false,
      error: result.error,
      message: result.message,
      resolvedCount: 0,
      failedCount: 0,
    };
  }

  // 2. Re-sync governance state and re-normalize the queue (Req 12.6).
  syncGovernanceState();
  const { resolved, stillQueued, failures } = renormalizeExceptions(
    state.exceptionQueue,
    state.mappingTable,
  );

  // 3. Resolved records leave the queue and enter consolidation (Req 10.4/14.4).
  const consolidatedAdded = tag(consolidate(resolved), "mapping");
  state.consolidated = [...state.consolidated, ...consolidatedAdded];

  // NORMALIZATION_FAILED entries are retained in the queue (Req 12.7).
  state.exceptionQueue = [...stillQueued, ...failures];

  // Count records resolved through finance judgment (Req 15.3).
  const counts = ensureCounts();
  counts.financeJudgment += consolidatedAdded.length;

  persistState();

  // Refresh the three affected views (Req 17.3). The current view is
  // re-rendered; the others are inherently refreshed from live state on their
  // next render.
  refreshViews(["#exceptions", "#mappings", "#report"]);

  return {
    ok: true,
    entry: result.entry,
    resolvedCount: resolved.length,
    failedCount: failures.length,
  };
}

/**
 * Reject a P2P_Record's resolution: keep it in the Exception_Queue with status
 * "on_hold_for_correction" and record the reviewer's rejection reason (Req
 * 12.4). Persists and refreshes.
 *
 * @param {string} exceptionId  the exception being put on hold
 * @param {string} reason       the reviewer-provided rejection reason
 * @returns {{ ok: boolean, error?: string }}
 */
export function rejectResolution(exceptionId, reason) {
  const index = state.exceptionQueue.findIndex((e) => e && e.id === exceptionId);
  if (index === -1) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const existing = state.exceptionQueue[index];
  // Per the process map, a rejected record is held for correction and cycles
  // back through the queue: mark it on hold and move it to the BACK so fresh
  // exceptions are worked first and held ones come around again later.
  const updated = {
    ...existing,
    status: "on_hold_for_correction",
    rejectionReason: reason != null ? reason : "",
    holdCount: (existing.holdCount || 0) + 1,
    heldAt: new Date().toISOString(),
  };
  const without = [
    ...state.exceptionQueue.slice(0, index),
    ...state.exceptionQueue.slice(index + 1),
  ];
  state.exceptionQueue = [...without, updated];

  persistState();
  refreshViews(["#exceptions"]);

  return { ok: true, movedToBack: true };
}

/**
 * Find an exception entry by id in the live queue.
 * @param {string} exceptionId
 * @returns {Object|null}
 */
function findException(exceptionId) {
  return state.exceptionQueue.find((e) => e && e.id === exceptionId) || null;
}

// -------------------------------------------------------------------------
// Reset (demo convenience).
// -------------------------------------------------------------------------

// Clear ALL persisted data and reload so the app re-seeds from scratch. For a
// class demo this gives a clean slate without digging into browser storage.
export function resetApp() {
  resetAll();
  if (typeof window !== "undefined" && window.location) {
    window.location.reload();
  }
}

// -------------------------------------------------------------------------
// Mapping Table: manual add / delete (both audited).
// -------------------------------------------------------------------------

// Manually add an approved Mapping_Entry from the Mapping Table screen. It
// reuses the governed approval path (validate, conflict-check, audit) and then
// re-runs the Exception_Queue so waiting records the mapping now covers resolve.
export function addMapping(draft) {
  return approveMapping(null, { ...draft, origin: "manual" }, state.meta.reviewerId);
}

// Delete a Mapping_Entry by id. Writes a DELETE audit entry for traceability.
// Does not alter already-consolidated records; it removes the standing rule so
// future records with those codes no longer auto-normalize.
export function deleteMapping(id, reason) {
  const idx = state.mappingTable.findIndex((m) => m && m.id === id);
  if (idx === -1) return { ok: false, error: "NOT_FOUND" };
  const removed = state.mappingTable[idx];
  state.mappingTable = [
    ...state.mappingTable.slice(0, idx),
    ...state.mappingTable.slice(idx + 1),
  ];
  save(KEYS.mappingTable, state.mappingTable);
  appendAudit({
    actor: state.meta.reviewerId || "reviewer-01",
    timestamp: new Date().toISOString(),
    action: "DELETE",
    priorValue: removed,
    newValue: { note: reason || "" },
    promptedByProcessingId: null,
  });
  state.auditTrail = load(KEYS.auditTrail, []);
  persistState();
  refreshViews(["#mappings", "#audit", "#report"]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reporting + CSV export.
// ---------------------------------------------------------------------------

/**
 * Build the current Group_Report from live state, supplying the run counts
 * with exceptionsRemaining derived from the live queue (Req 15.3).
 * @returns {Object} a Group_Report
 */
export function buildCurrentReport() {
  // Counts are derived from the consolidated records (resolvedVia tag) and the
  // live queue length, so they always reconcile with the rows.
  return buildGroupReport(state.consolidated, state.mappingTable, null, {
    exceptionsRemaining: state.exceptionQueue.length,
  });
}

/**
 * Export the Group_Report to CSV and trigger a browser download via a Blob
 * (Req 15.4). Outside a browser (no document/URL) it returns the CSV text
 * without attempting a download, so the function is safe to unit-test.
 *
 * @returns {{ ok: boolean, csv: string, downloaded: boolean }}
 */
export function exportReport() {
  const report = buildCurrentReport();
  const csv = exportGroupReportCsv(report);

  // Guard for a non-browser environment (Node/tests): no DOM download.
  const hasBrowser =
    typeof document !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof Blob !== "undefined";

  if (!hasBrowser) {
    return { ok: true, csv, downloaded: false };
  }

  try {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `group-report-${stamp()}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return { ok: true, csv, downloaded: true };
  } catch (err) {
    logWarning("CSV export download failed.", err);
    return { ok: true, csv, downloaded: false };
  }
}

/**
 * A filename-safe timestamp for the export download name.
 * @returns {string}
 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// View refresh helpers.
// ---------------------------------------------------------------------------

/**
 * Re-render the current view from live state (e.g. after a pipeline run).
 * @returns {void}
 */
function refreshCurrentView() {
  const container = appRoot();
  if (!container) return;
  renderView(ROUTES[state.currentRoute], container);
}

/**
 * Refresh the given routes. Only the currently displayed route actually
 * re-renders here; the others always read live state on their next render, so
 * listing them documents the Req 17.3 refresh contract (Exception Queue,
 * Mapping Table, Group Report) without redundant off-screen work.
 *
 * @param {string[]} routes  hash routes that should reflect the change
 * @returns {void}
 */
function refreshViews(routes) {
  if (Array.isArray(routes) && routes.includes(state.currentRoute)) {
    refreshCurrentView();
  }
}

// ---------------------------------------------------------------------------
// Diagnostics.
// ---------------------------------------------------------------------------

/**
 * Log a recoverable warning without throwing. Uses console when present.
 * @param {string} message
 * @param {*} [err]
 * @returns {void}
 */
function logWarning(message, err) {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`[appController] ${message}`, err || "");
  }
}

// ---------------------------------------------------------------------------
// Browser auto-boot: start the app when loaded as a module in the browser.
// ---------------------------------------------------------------------------

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      init();
    });
  } else {
    init();
  }
}
