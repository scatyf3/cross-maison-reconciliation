// src/seed/seedData.js
//
// First-load seed loader (Req 2.6). On the very first load — when the
// Browser_Store holds no prior data — the System must initialize the
// Mapping_Table and the sample Maison_Extracts from the seeded data set.
//
// This module owns that bootstrap. It `fetch`es the three static Maison
// extract CSV files (`seed/lv_extract.csv`, `seed/dior_extract.csv`,
// `seed/fendi_extract.csv`) and the starter Mapping_Table
// (`src/seed/starterMappingTable.json`), bundles them into a `seedData`
// object, and hands the Mapping_Table to the Browser_Store via
// `seedIfEmpty()` so it is persisted ONLY on first load (reviewer edits on a
// subsequent load are never clobbered — Req 2.6).
//
// The raw CSV extract text is NOT a persisted Browser_Store key: extracts flow
// through the Ingestion_Module when the reviewer loads them from the Load
// Extracts view. So `loadSeedData()` returns the raw extract text keyed by
// maisonId ("LV" | "DIOR" | "FENDI") for that view to ingest on demand.
//
// All paths are RELATIVE to `index.html` at the repository root so the app
// works unchanged when served statically from a GitHub Pages project subpath
// (e.g. https://user.github.io/repo/). Absolute paths like "/seed/..." would
// break under a project subpath, so they are deliberately avoided.
//
// fetch and localStorage are browser globals; this module is only exercised at
// runtime in the browser. Under Node it imports cleanly (no top-level fetch),
// and the Browser_Store it delegates to degrades to an in-memory shim.
//
// Requirements: 2.6

import { isFirstLoad, seedIfEmpty, KEYS } from "../store/browserStore.js";

/**
 * The three seeded Maisons and the static CSV file each extract is served
 * from. `id` is the canonical maisonId used throughout the pipeline
 * ("LV" | "DIOR" | "FENDI"); `path` is relative to index.html at the repo
 * root so it resolves correctly under a GitHub Pages project subpath.
 * @readonly
 */
export const SEED_EXTRACTS = Object.freeze([
  Object.freeze({ id: "LV", label: "Louis Vuitton", path: "seed/lv_extract.csv" }),
  Object.freeze({ id: "DIOR", label: "Dior", path: "seed/dior_extract.csv" }),
  Object.freeze({ id: "FENDI", label: "Fendi", path: "seed/fendi_extract.csv" }),
]);

/**
 * Path to the starter Mapping_Table JSON, relative to index.html at the repo
 * root (GitHub Pages subpath safe).
 * @type {string}
 */
export const STARTER_MAPPING_TABLE_PATH = "src/seed/starterMappingTable.json";

/**
 * Fetch a static asset relative to the document and return its text. Throws a
 * descriptive error on a non-OK response so the caller can surface which seed
 * asset failed rather than silently seeding partial data.
 *
 * @param {string} path  path relative to the repo root (e.g. "seed/lv_extract.csv")
 * @returns {Promise<string>}  the response body as text
 */
async function fetchText(path) {
  // Resolve against the repo root (this module lives in src/seed/), not the
  // page, so shells in subfolders (v2/) find the same seed files.
  const url = new URL("../../" + path, import.meta.url);
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(
      `Failed to load seed asset "${path}": ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

/**
 * @typedef {Object} SeedData
 * @property {Object[]} mappingTable
 *   The starter Mapping_Table (parsed from starterMappingTable.json). Passed to
 *   `seedIfEmpty` and persisted under KEYS.mappingTable on first load.
 * @property {Object<string,string>} extracts
 *   Raw CSV extract text keyed by maisonId ("LV" | "DIOR" | "FENDI"). Not
 *   persisted — consumed by the Load Extracts view / Ingestion_Module.
 * @property {{id:string,label:string,path:string}[]} extractMeta
 *   The SEED_EXTRACTS descriptors, for the Load Extracts view to render a list.
 */

/**
 * Fetch every seed asset and assemble the `seedData` object. All four fetches
 * run in parallel. If any asset fails to load, the returned promise rejects so
 * the caller never seeds a partial data set.
 *
 * @returns {Promise<SeedData>}
 */
export async function loadSeedData() {
  const [mappingTableText, ...extractTexts] = await Promise.all([
    fetchText(STARTER_MAPPING_TABLE_PATH),
    ...SEED_EXTRACTS.map((e) => fetchText(e.path)),
  ]);

  let mappingTable;
  try {
    mappingTable = JSON.parse(mappingTableText);
  } catch (err) {
    throw new Error(
      `Starter Mapping_Table at "${STARTER_MAPPING_TABLE_PATH}" is not valid JSON: ${err.message}`,
    );
  }
  if (!Array.isArray(mappingTable)) {
    throw new Error(
      `Starter Mapping_Table at "${STARTER_MAPPING_TABLE_PATH}" must be a JSON array of Mapping_Entries.`,
    );
  }

  /** @type {Object<string,string>} */
  const extracts = {};
  SEED_EXTRACTS.forEach((e, i) => {
    extracts[e.id] = extractTexts[i];
  });

  return {
    mappingTable,
    extracts,
    extractMeta: SEED_EXTRACTS.map((e) => ({ ...e })),
  };
}

/**
 * @typedef {Object} SeedStoreResult
 * @property {boolean} seeded     true if first-load seeding occurred this call
 * @property {SeedData} [seedData] the loaded seed data (present when seeded, so
 *                                 the caller can ingest the fresh extracts)
 */

/**
 * First-load bootstrap. Checks `isFirstLoad()` against the Browser_Store and,
 * only when the store is empty, loads the seed assets and persists the starter
 * Mapping_Table via `seedIfEmpty`. On any later load this is a no-op (no fetch,
 * no write) so persisted reviewer edits survive reloads (Req 2.6).
 *
 * @returns {Promise<SeedStoreResult>}
 *   `{ seeded: false }` when the store was already seeded; otherwise
 *   `{ seeded: true, seedData }` with the loaded data for the Load Extracts
 *   view to ingest.
 */
export async function seedStoreIfEmpty() {
  if (!isFirstLoad()) {
    return { seeded: false };
  }

  const seedData = await loadSeedData();

  // Persist the starter Mapping_Table (and default meta, written by
  // seedIfEmpty). seedIfEmpty re-checks isFirstLoad internally, so it is a
  // no-op if another path seeded between our check and this call.
  const seeded = seedIfEmpty({ mappingTable: seedData.mappingTable });

  return { seeded, seedData };
}

export { KEYS };
