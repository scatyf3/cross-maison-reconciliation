// src/ui/replay/sqlRunner.js
//
// Runs an agent's SQL against the governed data, in SQLite (sql.js).
//
// Every query gets a fresh in-memory database built from the live app state
// (src/core/sqlView.js), so even a statement that slipped past the read-only
// check could only change a throwaway copy. The policy blocks writes anyway.
//
// The SQL engine is injected: Node tests pass `require("sql.js")`'s init, the
// browser loads it from cdnjs on first use (loadSqlJsFromCdn), so the app
// keeps working offline until an agent trace actually needs SQL.

import { TABLES, NUMERIC, buildTables } from "../../core/sqlView.js";

const SQLJS_VERSION = "1.10.3";
const CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/" + SQLJS_VERSION + "/";
const MAX_ROWS = 500;

/**
 * @param {Object} SQL  an initialized sql.js module (has `Database`)
 * @returns {{ run: (state: Object, sql: string) => { columns: string[], rows: Object[], truncated: boolean } }}
 */
export function createSqlRunner(SQL) {
  function run(state, sql) {
    const db = new SQL.Database();
    try {
      const data = buildTables(state);
      for (const [name, cols] of Object.entries(TABLES)) {
        db.run("CREATE TABLE " + name + " (" + cols.map((c) => c + (NUMERIC.has(c) ? " REAL" : " TEXT")).join(", ") + ")");
        const stmt = db.prepare("INSERT INTO " + name + " VALUES (" + cols.map(() => "?").join(", ") + ")");
        for (const row of data[name]) stmt.run(cols.map((c) => (row[c] === undefined ? null : row[c])));
        stmt.free();
      }
      const stmt = db.prepare(sql);
      const columns = stmt.getColumnNames();
      const rows = [];
      let truncated = false;
      while (stmt.step()) {
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return { columns, rows, truncated };
    } finally {
      db.close();
    }
  }
  return { run };
}

let cdnPromise = null;

/** Load sql.js from cdnjs once (browser only). */
export function loadSqlJsFromCdn() {
  if (cdnPromise) return cdnPromise;
  cdnPromise = new Promise((resolve, reject) => {
    if (typeof document === "undefined") { reject(new Error("No document to load sql.js into.")); return; }
    const done = () => {
      const init = globalThis.initSqlJs;
      if (typeof init !== "function") { reject(new Error("sql.js did not load.")); return; }
      init({ locateFile: (file) => CDN + file }).then(resolve, reject);
    };
    if (typeof globalThis.initSqlJs === "function") { done(); return; }
    const script = document.createElement("script");
    script.src = CDN + "sql-wasm.js";
    script.async = true;
    script.onload = done;
    script.onerror = () => reject(new Error("Could not load the SQL engine from " + CDN + " (offline?)."));
    document.head.appendChild(script);
  }).catch((err) => { cdnPromise = null; throw err; });
  return cdnPromise;
}
