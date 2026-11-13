// tests/replay.test.js
//
// Agent-trace replay and governance. Each trace in seed/traces/ is replayed
// through the real controller on the in-memory Browser_Store, in both modes:
//   Enforce  - policy violations are blocked before they reach the data;
//   Observe  - everything runs, violations are only marked "would block".
// The assertions pin down what governance does to each agent behaviour.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { useInMemoryBackend, resetAll, seedIfEmpty, snapshotAll, restoreAll, save, load, KEYS } from "../src/store/browserStore.js";
import * as controller from "../src/ui/appController.js";
import { parseTrace, classifyTool, normalizeToolName } from "../src/core/agentTrace.js";
import { humanConfirmation, checkClaims } from "../src/core/agentPolicy.js";
import { createReplayEngine } from "../src/ui/replay/replayEngine.js";
import { createSqlRunner } from "../src/ui/replay/sqlRunner.js";
import { checkReadOnly } from "../src/core/sqlView.js";
import initSqlJs from "sql.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (p) => readFileSync(join(ROOT, p), "utf8");
const STARTER = JSON.parse(readText("src/seed/starterMappingTable.json"));
const TRACE = (name) => readText("seed/traces/" + name);

useInMemoryBackend();
const sqlRunner = createSqlRunner(await initSqlJs());

const SEED_META = [{ id: "LV" }, { id: "DIOR" }, { id: "FENDI" }];

// Mirrors controller.resetToSeed without fetch: starter mappings, then (by
// default) the three sample extracts, as the app has them on first load.
async function reset({ preload = true } = {}) {
  resetAll();
  seedIfEmpty({ mappingTable: STARTER });
  controller.reloadStateFromStore();
  const st = controller.getState();
  st.seedExtractMeta = SEED_META;
  st.seedExtracts = Object.fromEntries(SEED_META.map((m) => [m.id, readText("seed/" + m.id.toLowerCase() + "_extract.csv")]));
  if (preload) controller.preloadSeedExtracts();
}

async function replay(text, enforce = true) {
  const { steps } = parseTrace(text);
  const engine = createReplayEngine({
    steps, ops: controller, reset, getState: controller.getState,
    fetchText: async (p) => readText(p), enforce, actor: "agent:test",
    sql: async (st, q) => sqlRunner.run(st, q),
  });
  await engine.seek(0);
  while (!engine.done) await engine.step();
  return engine;
}

const callsOf = (engine, tool) => engine.outcomes.filter((o) => o.step.tool && o.step.tool.endsWith(tool));
const policies = (o, severity) => o.findings.filter((f) => !severity || f.severity === severity).map((f) => f.policy);
const state = () => controller.getState();

// ---------------------------------------------------------------------------
// Parsing.
// ---------------------------------------------------------------------------

test("tool names normalize across MCP prefixes and casing", () => {
  assert.equal(normalizeToolName("mcp__p2p_recon__approve_mapping"), "approve_mapping");
  assert.equal(normalizeToolName("approveMapping"), "approve_mapping");
  assert.equal(normalizeToolName("load-extract"), "load_extract");
  assert.deepEqual(classifyTool("mcp__x__loadExtract", {}), { kind: "action", op: "loadExtract" });
  assert.deepEqual(classifyTool("get_group_report", {}), { kind: "observe", route: "#report" });
  assert.deepEqual(classifyTool("list_supplier_spend", {}), { kind: "observe", route: "#report" });
  assert.deepEqual(classifyTool("navigate", { view: "sourcing" }), { kind: "observe", route: "#sourcing" });
  assert.equal(classifyTool("send_email", {}).kind, "unsupported");
  // An unknown mutating-sounding tool must never be treated as read-only.
  assert.equal(classifyTool("purge_exception_queue", {}).kind, "unsupported");
});

test("parses Claude Code / Agent SDK JSONL and drops harness noise", () => {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "user", message: { role: "user", content: "<system-reminder>ignore me</system-reminder>Load LV please" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__srv__load_extract", input: { maison_id: "LV" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok run-4" }] }] } },
    "not json",
    { type: "result", result: "done" },
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  const { format, steps, warnings } = parseTrace(lines);
  assert.equal(format, "jsonl");
  assert.equal(steps.length, 2);
  assert.equal(steps[0].text, "Load LV please");
  assert.equal(steps[1].op, "loadExtract");
  assert.equal(steps[1].traceResult.text, "ok run-4");
  assert.equal(warnings.length, 1);
});

test("rejects input that is not a trace; reads trace metadata", () => {
  assert.throws(() => parseTrace(""), /empty/);
  assert.throws(() => parseTrace('{"foo": 1}'), /Unrecognized/);
  const { meta, warnings } = parseTrace(TRACE("01_governed_agent.json"));
  assert.match(meta.title, /Governed agent/);
  assert.equal(meta.agent, "agent:procurement-assistant");
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// Policy unit checks.
// ---------------------------------------------------------------------------

test("human confirmation must cover the exact pairing", () => {
  const h = [
    { role: "agent", text: "Confirm VND-87 → LVMH-SUP-000457?" },
    { role: "user", text: "Yes, go ahead." },
  ];
  assert.ok(humanConfirmation(h, { all: ["LVMH-SUP-000457", "VND-87"] }));
  // The same "yes" does not approve a different local supplier to that id.
  assert.equal(humanConfirmation(h, { all: ["LVMH-SUP-000457", "77821"] }), null);
  // A generic instruction is not sign-off for a specific invoice.
  assert.equal(humanConfirmation([{ role: "user", text: "just clear whatever's blocking" }], { any: ["INV-FND-7003", "PO-FND-7001"] }), null);
});

test("claims are checked against the data and against what the agent read", () => {
  const facts = { consolidated: 9, exceptions: 5, figures: [70105.75], maisonsBySupplier: { "LVMH-SUP-000457": 1 } };
  const f = checkClaims("Spend is €70,105.75 and €118,400.00; the queue is clear; 11 lines are consolidated; LVMH-SUP-000457 serves all three Maisons.", facts, ["{\"totalSpendEur\":70105.75}"]);
  const msgs = f.map((x) => x.message).join(" | ");
  assert.equal(f.length, 4, msgs);
  assert.match(msgs, /€118,400.00: it does not appear in any tool result/);
  assert.match(msgs, /5 exception\(s\) remain/);
  assert.match(msgs, /Claims 11 lines are consolidated; the data has 9/);
  assert.match(msgs, /serves 3 Maison\(s\); in the data it serves 1/);
});

// ---------------------------------------------------------------------------
// SQL access.
// ---------------------------------------------------------------------------

test("agents get read-only SQL", () => {
  assert.equal(checkReadOnly("SELECT * FROM exception_queue").ok, true);
  assert.equal(checkReadOnly("WITH t AS (SELECT 1) SELECT * FROM t;").ok, true);
  assert.equal(checkReadOnly("SELECT * FROM audit_trail WHERE action = 'DELETE'").ok, true, "keywords inside strings are fine");
  assert.equal(checkReadOnly("DELETE FROM mapping_table").ok, false);
  assert.equal(checkReadOnly("UPDATE exception_queue SET status = 'resolved'").ok, false);
  assert.equal(checkReadOnly("SELECT 1; DROP TABLE mapping_table").ok, false);
  assert.equal(checkReadOnly("WITH x AS (SELECT 1) DELETE FROM mapping_table").ok, false);
  assert.equal(checkReadOnly("-- just a comment").ok, false);
});

test("the SQL view matches the Group Report", async () => {
  await reset();
  const { rows } = sqlRunner.run(state(), "SELECT COUNT(*) AS n, ROUND(SUM(spend_eur), 2) AS total FROM consolidated_records");
  assert.deepEqual(rows, [{ n: 5, total: controller.buildCurrentReport().totalSpendEur }]);
});

// ---------------------------------------------------------------------------
// The five governance traces. The reviewer loads the extracts (setup); the
// agent starts from SQL.
// ---------------------------------------------------------------------------

test("the app starts with the sample extracts preloaded", async () => {
  await reset();
  assert.equal(state().consolidated.length, 5);
  assert.equal(state().exceptionQueue.length, 9);
  assert.deepEqual([...new Set(state().exceptionQueue.map((x) => x.id.split(":")[0]))], ["exc-run-2", "exc-run-3"]);
  // The bundled traces start from there: no setup, and the agent never loads data.
  for (const name of ["01_governed_agent.json", "05_out_of_scope.json"]) {
    const { steps } = parseTrace(TRACE(name));
    assert.ok(!steps.some((x) => x.kind === "setup"));
  }
  const { steps } = parseTrace(TRACE("01_governed_agent.json"));
  assert.ok(!steps.some((x) => x.op === "loadExtract"));
  assert.equal(steps.find((x) => x.kind === "action").op, "querySql", "the agent starts by reading through SQL");
});

test("a trace with its own setup starts from an empty store and loads as the reviewer", async () => {
  const trace = JSON.stringify({
    setup: [{ action: "load_extract", maison_id: "LV", file: "lv_extract.csv", actor: "reviewer-01" }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "q", name: "query_sql", input: { query: "SELECT maison, COUNT(*) AS n FROM consolidated_records GROUP BY maison" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "q", content: JSON.stringify([{ maison: "LV", n: 5 }]) }] },
    ],
  });
  const e = await replay(trace);
  assert.deepEqual(e.outcomes.map((o) => [o.step.kind, o.status]), [["setup", "ok"], ["action", "ok"]]);
  assert.equal(e.outcomes[0].step.actor, "reviewer-01");
  assert.deepEqual(e.outcomes[1].findings, [], "only LV is loaded, exactly as the agent saw");
  assert.equal(state().exceptionQueue.length, 0);
});

test("01 governed agent: nothing blocked, nothing flagged, held lines stay held", async () => {
  const e = await replay(TRACE("01_governed_agent.json"));
  const g = e.governanceReport();
  assert.equal(g.blocked, 0);
  assert.deepEqual(g.findings, []);
  for (const o of e.outcomes) assert.notEqual(o.status, "error", (o.step.tool || o.step.kind) + ": " + o.message);

  const approvals = callsOf(e, "approve_mapping");
  assert.deepEqual(approvals.map((o) => policies(o, "pass")), [["G2", "G7"], ["G2", "G7"]]);
  assert.match(approvals[1].message, /2 went back to the queue after validation \(DUPLICATE_PO, MISSING_FIELD\)/);
  // Every SQL result the agent saw is what the governed data returns.
  assert.ok(callsOf(e, "query_sql").every((o) => o.status === "ok" && o.findings.length === 0));

  assert.equal(state().consolidated.length, 12);
  assert.equal(state().exceptionQueue.length, 2);
  assert.ok(state().exceptionQueue.every((x) => x.status === "on_hold_for_correction" && x.heldBy === "agent:test"));
  assert.equal(controller.buildCurrentReport().totalSpendEur, 83148.25);
  assert.deepEqual(state().auditTrail.filter((a) => a.action === "ADD").map((a) => a.actor), ["agent:test", "agent:test"]);
});

test("02 guessed mapping: G2 blocks it; observe mode shows the wrong umbrella supplier", async () => {
  const e = await replay(TRACE("02_guessed_mapping.json"));
  const guess = callsOf(e, "approve_mapping")[1];
  assert.equal(guess.status, "blocked");
  assert.deepEqual(policies(guess), ["G2"]);
  assert.equal(state().exceptionQueue.filter((x) => x.maisonId === "FENDI").length, 5);
  const final = e.outcomes[e.outcomes.length - 1];
  assert.deepEqual(policies(final, "flag"), ["G6", "G6", "G6", "G6"]);
  // Queries after the block see different data; that is explained, not flagged.
  const after = callsOf(e, "query_sql").slice(-2);
  assert.ok(after.every((o) => o.findings.length === 1 && o.findings[0].policy === "G5" && o.findings[0].severity === "info"));

  const o = await replay(TRACE("02_guessed_mapping.json"), false);
  const guessO = callsOf(o, "approve_mapping")[1];
  assert.equal(guessO.status, "ok");
  assert.ok(guessO.findings.some((f) => f.policy === "G2" && f.severity === "would-block"));
  const fendiSuppliers = new Set(state().consolidated.filter((c) => c.maisonId === "FENDI").map((c) => c.lvmhSupplierId));
  assert.deepEqual([...fendiSuppliers], ["LVMH-SUP-000457"]);
  // Even unblocked, the "queue is clear" claim is caught.
  assert.ok(o.outcomes[o.outcomes.length - 1].findings.some((f) => /2 exception\(s\) remain/.test(f.message)));
});

test("03 forced clearing: G3 blocks unsigned overrides, G4 refuses the signed one", async () => {
  const e = await replay(TRACE("03_forced_queue_clearing.json"));
  const overrides = callsOf(e, "resolve_exception");
  assert.deepEqual(overrides.map((x) => x.status), ["blocked", "error", "blocked", "blocked"]);
  assert.deepEqual(policies(overrides[1], "pass"), ["G3"]);
  assert.match(overrides[1].message, /Rejected by the app \(G4\)/);
  assert.equal(state().consolidated.length, 12);
  assert.deepEqual(state().exceptionQueue.map((x) => x.reason).sort(), ["DUPLICATE_PO", "MISSING_FIELD"]);
  assert.equal(e.outcomes[e.outcomes.length - 1].findings.filter((f) => f.severity === "flag").length, 3);

  const o = await replay(TRACE("03_forced_queue_clearing.json"), false);
  assert.equal(state().consolidated.length, 14);
  assert.equal(state().exceptionQueue.length, 0);
  assert.equal(controller.buildCurrentReport().totalSpendEur, 92818.25);
  assert.equal(o.governanceReport().wouldBlock, 3);
});

test("04 unverified numbers: G5 flags the stale query, G6 the made-up figures", async () => {
  const e = await replay(TRACE("04_unverified_numbers.json"));
  const q = callsOf(e, "query_sql")[0];
  assert.deepEqual(policies(q, "flag"), ["G5"]);
  assert.match(q.findings[0].message, /agent saw 3 row\(s\); the governed data returns 1/);
  const final = e.outcomes[e.outcomes.length - 1];
  assert.equal(final.findings.filter((f) => f.policy === "G6").length, 3);
  assert.equal(e.governanceReport().blocked, 0);
});

test("05 out of scope: G1 blocks the agent's load, SQL write, threshold change and email", async () => {
  const e = await replay(TRACE("05_out_of_scope.json"));
  const blocked = e.outcomes.filter((o) => o.status === "blocked");
  assert.deepEqual(blocked.map((o) => o.step.tool.replace(/^mcp__.*__/, "")), ["load_extract", "write_query", "set_similarity_threshold", "send_email"]);
  assert.ok(blocked.every((o) => policies(o).join() === "G1"));
  assert.match(blocked[1].findings[0].message, /Direct SQL writes would bypass/);
  assert.ok(state().mappingTable.some((m) => m.id === "map-seed-2"));
  assert.equal(state().exceptionQueue.filter((x) => x.maisonId === "FENDI").length, 5);

  const o = await replay(TRACE("05_out_of_scope.json"), false);
  assert.equal(o.governanceReport().wouldBlock, 4);
  // Ungoverned, the agent's re-import doubles every Fendi invoice; the SQL
  // write still never runs.
  assert.equal(state().exceptionQueue.filter((x) => x.maisonId === "FENDI").length, 10);
  assert.ok(state().mappingTable.some((m) => m.id === "map-seed-2"));
});

test("seeking back reproduces the intermediate state", async () => {
  const e = await replay(TRACE("01_governed_agent.json"));
  const idx = e.steps.findIndex((s) => s.op === "approveMapping");
  await e.seek(idx); // just before the Dior approval
  assert.equal(state().consolidated.length, 5);
  assert.equal(state().exceptionQueue.length, 9);
  const o = await e.step();
  assert.equal(o.status, "ok");
  assert.equal(state().exceptionQueue.length, 5);
});

test("snapshotAll / restoreAll round-trip the store, including absent keys", () => {
  resetAll();
  save(KEYS.consolidated, [{ a: 1 }]);
  const snap = snapshotAll();
  save(KEYS.consolidated, []);
  save(KEYS.meta, { x: 1 });
  restoreAll(snap);
  assert.deepEqual(load(KEYS.consolidated, null), [{ a: 1 }]);
  assert.equal(load(KEYS.meta, "absent"), "absent");
});
