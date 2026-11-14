// v2/bus.js — shared state and events between the data workspace and the
// agent panel, so neither imports the other.
//
// Events:
//   "changed"  the governed data changed (any actor); re-render counts and grid
//   "show"     put something in the grid: { table, focus? } or { sql, result, by, label, focus? }
//   "select"   open a row in the inspector: { table, key }
//   "ask"      prefill the live agent composer: { text }
//   "mode"     replay started/stopped: { replaying: boolean }

import * as controller from "../src/ui/appController.js";

const target = new EventTarget();

export function emit(type, detail) {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

export function on(type, fn) {
  const wrapped = (e) => fn(e.detail);
  target.addEventListener(type, wrapped);
  return () => target.removeEventListener(type, wrapped);
}

/** Shared flags. `replaying` locks reviewer actions while a replay owns the data. */
export const shell = {
  replaying: false,
  reviewer() {
    const meta = controller.getState().meta || {};
    return meta.reviewerId || "reviewer-01";
  },
};

/** Repo-root URL of a seed path, independent of where the page lives. */
export function rootUrl(path) {
  return new URL("../" + path, import.meta.url).href;
}

export async function fetchText(path) {
  const resp = await fetch(rootUrl(path), { cache: "no-cache" });
  if (!resp.ok) throw new Error(resp.status + " " + resp.statusText + " (" + path + ")");
  return resp.text();
}

// One SQLite (sql.js) runner for the human console and the agent, loaded
// from the CDN on first use. Every query runs on a fresh copy of live state.
import { createSqlRunner, loadSqlJsFromCdn } from "../src/ui/replay/sqlRunner.js";
let runnerPromise = null;
export async function runSql(state, query) {
  if (!runnerPromise) runnerPromise = loadSqlJsFromCdn().then(createSqlRunner).catch((err) => { runnerPromise = null; throw err; });
  return (await runnerPromise).run(state, query);
}
