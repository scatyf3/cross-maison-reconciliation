// src/store/browserStore.js
//
// Browser_Store: the single persistence boundary for the Cross-Maison P2P
// Reconciliation prototype. Every piece of durable state (the Mapping_Table,
// the Exception_Queue, the consolidated records, the append-only Audit_Trail,
// the monotonic run counter, and the meta object) is stored as a JSON string
// under a versioned key in `localStorage`. A thin wrapper isolates this choice
// so the rest of the app never touches `localStorage` directly.
//
// Node-safe by design: `localStorage` does not exist in a plain Node test
// context, so this module detects its absence and falls back to an in-memory,
// Map-backed shim. The same shim is used when the real `localStorage` throws
// (quota exceeded, access disabled in private mode, etc.) so the app degrades
// to in-memory state instead of crashing (Req 2.x resilience).
//
// The governance mutation path (`approveMapping`) is the ONLY way an approved
// Mapping_Entry enters the table: it validates the draft, rejects conflicts
// with an existing approved tuple, stamps the reviewer id + timestamp, and
// appends a complete Audit_Trail entry — otherwise it leaves the table
// unchanged (Req 12.2, 12.3, 13.1, 13.2, 13.3).
//
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 12.2, 12.3, 13.1, 13.2, 13.3

import {
  DEFAULT_SIMILARITY_THRESHOLD,
} from "../core/constants.js";

/**
 * Versioned localStorage keys. Values are JSON strings; the `.v1` suffix lets
 * the schema evolve without clobbering older data. These exact key names are
 * part of the Browser_Store schema contract (design: Browser_Store Schema).
 * @readonly
 */
export const KEYS = Object.freeze({
  mappingTable: "p2p.mappingTable.v1",
  exceptionQueue: "p2p.exceptionQueue.v1",
  consolidated: "p2p.consolidated.v1",
  auditTrail: "p2p.auditTrail.v1",
  runCounter: "p2p.runCounter.v1",
  meta: "p2p.meta.v1",
});

/**
 * The current Browser_Store schema version, written into `meta` on seed.
 * @type {number}
 */
export const SCHEMA_VERSION = 1;

/**
 * Default `meta` object written on first load. Holds the schema version, the
 * active similarity threshold used by the Recommendation_Agent, and the id of
 * the single Finance_Reviewer operating the prototype.
 * @returns {{schemaVersion:number, similarityThreshold:number, reviewerId:string}}
 */
export function defaultMeta() {
  return {
    schemaVersion: SCHEMA_VERSION,
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    reviewerId: "reviewer-01",
  };
}

// ---------------------------------------------------------------------------
// Storage backend: real localStorage when available, in-memory shim otherwise.
// ---------------------------------------------------------------------------

/**
 * A minimal, synchronous, Map-backed stand-in for the Web Storage API. Only
 * the methods this module needs are implemented. Values are strings, matching
 * `localStorage` semantics, so the rest of the module is backend-agnostic.
 */
class MemoryStorage {
  constructor() {
    /** @type {Map<string,string>} */
    this._map = new Map();
  }
  getItem(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  }
  setItem(key, value) {
    this._map.set(key, String(value));
  }
  removeItem(key) {
    this._map.delete(key);
  }
  clear() {
    this._map.clear();
  }
}

/**
 * Probe `globalThis.localStorage`. In Node it is usually absent; in a browser
 * it can exist but throw on access (private mode, blocked cookies). We verify
 * it is both present and writable with a round-trip on a throwaway key.
 *
 * @returns {Storage|null} the usable localStorage, or null to use the shim
 */
function detectLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = "__p2p_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/**
 * The active backend. Resolved once at module load. If the real localStorage
 * is unavailable we degrade silently to in-memory state so the module can be
 * imported and exercised under Node and keeps working in hostile browsers.
 * @type {Storage|MemoryStorage}
 */
let backend = detectLocalStorage() || new MemoryStorage();

/**
 * True when operating on the in-memory shim rather than real localStorage.
 * Exposed for diagnostics/tests.
 * @returns {boolean}
 */
export function isInMemory() {
  return backend instanceof MemoryStorage;
}

/**
 * Force the module onto the in-memory shim. Intended for tests that want a
 * clean, isolated backend regardless of the host environment.
 * @returns {void}
 */
export function useInMemoryBackend() {
  backend = new MemoryStorage();
}

/**
 * Permanently fall back to the in-memory shim, preserving any values already
 * written to the (failing) real backend where possible. Called when a write
 * to the real localStorage throws (e.g. QuotaExceededError).
 * @param {Storage} failing  the backend that just threw
 */
function degradeToMemory(failing) {
  const mem = new MemoryStorage();
  try {
    for (const key of Object.values(KEYS)) {
      const existing = failing.getItem(key);
      if (existing !== null && existing !== undefined) {
        mem.setItem(key, existing);
      }
    }
  } catch {
    // Best effort — if even reading fails, start empty in memory.
  }
  backend = mem;
}

// ---------------------------------------------------------------------------
// Core read/write.
// ---------------------------------------------------------------------------

/**
 * Read and JSON-parse the value at `key`. Falls back to `fallback` when the
 * key is missing or the stored JSON is corrupt, so a single bad key never
 * takes down the app (Req 2.5 restore resilience).
 *
 * @template T
 * @param {string} key       one of the KEYS values
 * @param {T} fallback       value to return on miss or parse failure
 * @returns {T}              the parsed value, or `fallback`
 */
export function load(key, fallback) {
  let raw;
  try {
    raw = backend.getItem(key);
  } catch (err) {
    // Reading the real backend threw — degrade and retry from memory.
    degradeToMemory(backend);
    raw = backend.getItem(key);
  }
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt JSON for this key: fall back to the default for just this key.
    return fallback;
  }
}

/**
 * JSON-stringify `value` and persist it under `key`. If the real backend
 * throws (quota exceeded, storage disabled), the store degrades to in-memory
 * state and the write is retried there so callers never see an exception.
 *
 * @param {string} key    one of the KEYS values
 * @param {*} value       any JSON-serializable value
 * @returns {void}
 */
export function save(key, value) {
  const serialized = JSON.stringify(value);
  try {
    backend.setItem(key, serialized);
  } catch (err) {
    degradeToMemory(backend);
    try {
      backend.setItem(key, serialized);
    } catch {
      // The in-memory shim does not throw; swallow to guarantee no-throw.
    }
  }
}

// ---------------------------------------------------------------------------
// Audit_Trail (append-only).
// ---------------------------------------------------------------------------

/**
 * Append one entry to the Audit_Trail. This ALWAYS reads the current array and
 * pushes the new entry onto the end; it never rewrites, reorders, or removes
 * prior entries, so the trail grows monotonically and each historical entry is
 * preserved exactly as written (Req 13.1, 13.3).
 *
 * @param {Object} entry  an Audit_Trail entry (see design Data Models)
 * @returns {Object}      the entry as stored (with an assigned `id` if absent)
 */
export function appendAudit(entry) {
  const trail = load(KEYS.auditTrail, []);
  const stored = {
    id: entry.id != null ? entry.id : `audit-${trail.length + 1}`,
    ...entry,
  };
  trail.push(stored);
  save(KEYS.auditTrail, trail);
  return stored;
}

// ---------------------------------------------------------------------------
// First-load detection and seeding.
// ---------------------------------------------------------------------------

/**
 * True on the very first load, when no `meta` object has been written yet.
 * The presence of `p2p.meta.v1` is the sentinel that the store was seeded.
 * @returns {boolean}
 */
export function isFirstLoad() {
  let raw;
  try {
    raw = backend.getItem(KEYS.meta);
  } catch {
    degradeToMemory(backend);
    raw = backend.getItem(KEYS.meta);
  }
  return raw === null || raw === undefined;
}

/**
 * Populate the store from seed data, but ONLY on first load — if the store has
 * already been seeded (meta present), this is a no-op so reviewer edits are
 * never clobbered (Req 2.6). Missing pieces of `seedData` fall back to sane
 * empty defaults; `meta` is merged over the default meta.
 *
 * @param {Object} [seedData]
 * @param {Object[]} [seedData.mappingTable]    starter Mapping_Table
 * @param {Object[]} [seedData.exceptionQueue]  starter Exception_Queue
 * @param {Object[]} [seedData.consolidated]    starter consolidated records
 * @param {Object[]} [seedData.auditTrail]      starter Audit_Trail
 * @param {number}   [seedData.runCounter]      starter run counter
 * @param {Object}   [seedData.meta]            meta overrides
 * @returns {boolean}  true if seeding occurred, false if the store was already seeded
 */
export function seedIfEmpty(seedData = {}) {
  if (!isFirstLoad()) return false;

  save(KEYS.mappingTable, seedData.mappingTable ?? []);
  save(KEYS.exceptionQueue, seedData.exceptionQueue ?? []);
  save(KEYS.consolidated, seedData.consolidated ?? []);
  save(KEYS.auditTrail, seedData.auditTrail ?? []);
  save(KEYS.runCounter, seedData.runCounter ?? 0);
  // Write meta LAST so isFirstLoad() only flips to false once seeding is
  // complete; if an earlier write degraded the backend, meta still lands.
  save(KEYS.meta, { ...defaultMeta(), ...(seedData.meta ?? {}) });
  return true;
}

/**
 * Remove every Browser_Store key, returning the store to a pristine, unseeded
 * state (so the next load re-seeds). A demo/dev convenience.
 * @returns {void}
 */
export function resetAll() {
  for (const key of Object.values(KEYS)) {
    try {
      backend.removeItem(key);
    } catch {
      degradeToMemory(backend);
      backend.removeItem(key);
    }
  }
}

/**
 * Capture the raw stored value of every Browser_Store key, so a temporary
 * session (trace replay) can run on clean state and put the reviewer's data
 * back afterwards with restoreAll().
 * @returns {Object<string, string|null>}
 */
export function snapshotAll() {
  const snap = {};
  for (const key of Object.values(KEYS)) {
    try { snap[key] = backend.getItem(key); } catch { snap[key] = null; }
  }
  return snap;
}

/**
 * Restore a snapshotAll() capture exactly: keys that were absent are removed.
 * @param {Object<string, string|null>} snap
 * @returns {void}
 */
export function restoreAll(snap) {
  for (const key of Object.values(KEYS)) {
    const value = snap ? snap[key] : null;
    try {
      if (value == null) backend.removeItem(key);
      else backend.setItem(key, value);
    } catch {
      degradeToMemory(backend);
      if (value == null) backend.removeItem(key);
      else backend.setItem(key, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Governance mutation: the approval path.
// ---------------------------------------------------------------------------

/**
 * The required local-identity fields a draft Mapping_Entry must carry to be
 * approvable. These identify the (Maison, local codes) tuple and the target
 * LVMH codes the normalizer will assign.
 * @type {readonly string[]}
 */
const REQUIRED_DRAFT_FIELDS = Object.freeze([
  "maisonId",
  "localSupplierCode",
  "localAccountCode",
  "lvmhSupplierId",
  "lvmhAccountCode",
]);

/**
 * Validate a draft Mapping_Entry: every required identity field must be
 * present and a non-empty string (after trimming). Returns the name of the
 * first missing field, or null when the draft is valid.
 *
 * @param {Object} draft
 * @returns {string|null}  the first offending field name, or null if valid
 */
function firstMissingDraftField(draft) {
  if (!draft || typeof draft !== "object") return REQUIRED_DRAFT_FIELDS[0];
  for (const field of REQUIRED_DRAFT_FIELDS) {
    const value = draft[field];
    if (value === undefined || value === null) return field;
    if (typeof value === "string" && value.trim() === "") return field;
  }
  return null;
}

/**
 * The approval key tuple for a Mapping_Entry: (maisonId, localSupplierCode,
 * localAccountCode). Uniqueness of APPROVED entries is enforced on this tuple.
 *
 * @param {Object} entry
 * @returns {string}
 */
function tupleKey(entry) {
  return [entry.maisonId, entry.localSupplierCode, entry.localAccountCode].join(
    "\u0000",
  );
}

/**
 * @typedef {Object} ApproveResult
 * @property {boolean} ok               true if the approval was applied
 * @property {Object} [entry]           the approved Mapping_Entry (on success)
 * @property {Object} [audit]           the appended Audit_Trail entry (on success)
 * @property {Object[]} mappingTable    the resulting Mapping_Table (unchanged on failure)
 * @property {string} [error]           machine-readable failure code (on failure)
 * @property {string} [message]         human-readable failure detail (on failure)
 */

/**
 * The governance approval path — the ONLY way an approved Mapping_Entry enters
 * the Mapping_Table. An approved entry is added if and only if:
 *
 *   1. the draft is VALID: it carries maisonId, localSupplierCode,
 *      localAccountCode, lvmhSupplierId, and lvmhAccountCode (Req 12.2); and
 *   2. it does NOT CONFLICT: no existing `approved` entry shares the same
 *      (maisonId, localSupplierCode, localAccountCode) tuple (Req 12.3).
 *
 * On success the new entry is stamped `status: "approved"`, `approvedBy` (the
 * reviewer id), and `approvedAt` (an ISO timestamp), persisted to the
 * Mapping_Table, and a complete Audit_Trail entry is appended (actor,
 * timestamp, action ADD/CHANGE, priorValue, newValue, promptedByProcessingId)
 * (Req 13.1, 13.2). On failure the Mapping_Table is left entirely unchanged and
 * no audit entry is written (Req 12.2, 12.3).
 *
 * @param {Object} draft                    the candidate Mapping_Entry
 * @param {string} reviewerId               the acting Finance_Reviewer id (Req 13.2)
 * @param {Object} [options]
 * @param {string} [options.promptedByProcessingId]  the record that prompted the change (Req 13.2)
 * @param {string} [options.timestamp]      ISO timestamp (defaults to now); injectable for tests
 * @param {string} [options.idPrefix="map"] prefix for the generated entry id
 * @returns {ApproveResult}
 */
export function approveMapping(draft, reviewerId, options = {}) {
  const mappingTable = load(KEYS.mappingTable, []);

  // 1. Validity check — reject and leave the table unchanged.
  const missing = firstMissingDraftField(draft);
  if (missing !== null) {
    return {
      ok: false,
      error: "INVALID_DRAFT",
      message: `Draft mapping is missing required field "${missing}".`,
      mappingTable,
    };
  }

  // 2. Conflict check — an existing APPROVED entry for the same tuple blocks
  //    the approval (Req 12.3). Non-approved entries (suggested/on_hold) for
  //    the same tuple do NOT block.
  const key = tupleKey(draft);
  const conflict = mappingTable.find(
    (m) => m.status === "approved" && tupleKey(m) === key,
  );
  if (conflict) {
    return {
      ok: false,
      error: "CONFLICT",
      message:
        "An approved mapping already exists for this " +
        "(maisonId, localSupplierCode, localAccountCode) tuple.",
      mappingTable,
      conflictingId: conflict.id,
    };
  }

  // Success: build the approved entry with reviewer id + timestamp.
  const timestamp =
    options.timestamp != null ? options.timestamp : new Date().toISOString();
  const idPrefix = options.idPrefix ?? "map";

  const approvedEntry = {
    id: draft.id != null ? draft.id : `${idPrefix}-${mappingTable.length + 1}`,
    maisonId: draft.maisonId,
    localSupplierCode: draft.localSupplierCode,
    localAccountCode: draft.localAccountCode,
    lvmhSupplierId: draft.lvmhSupplierId,
    lvmhAccountCode: draft.lvmhAccountCode,
    status: "approved",
    approvedBy: reviewerId,
    approvedAt: timestamp,
    origin: draft.origin ?? "manual",
  };

  const nextTable = [...mappingTable, approvedEntry];
  save(KEYS.mappingTable, nextTable);

  // Append the audit entry. There is no prior approved entry for this tuple
  // (we rejected conflicts above), so this is an ADD. A CHANGE would supply a
  // priorValue; here priorValue is null.
  const audit = appendAudit({
    actor: reviewerId,
    timestamp,
    action: "ADD",
    priorValue: null,
    newValue: approvedEntry,
    promptedByProcessingId: options.promptedByProcessingId ?? null,
  });

  return { ok: true, entry: approvedEntry, audit, mappingTable: nextTable };
}
