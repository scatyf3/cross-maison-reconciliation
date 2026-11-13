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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (p) => readFileSync(join(ROOT, p), "utf8");
const STARTER = JSON.parse(readText("src/seed/starterMappingTable.json"));
const TRACE = (name) => readText("seed/traces/" + name);

useInMemoryBackend();

async function reset() {
  resetAll();
  seedIfEmpty({ mappingTable: STARTER });
  controller.reloadStateFromStore();
  controller.getState().seedExtracts = {};
}

async function replay(text, enforce = true) {
  const { steps } = parseTrace(text);
  const engine = createReplayEngine({
    steps, ops: controller, reset, getState: controller.getState,
    fetchText: async (p) => readText(p), enforce, actor: "agent:test",
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
// The five governance traces.
// ---------------------------------------------------------------------------

test("01 governed agent: nothing blocked, nothing flagged, held lines stay held", async () => {
  const e = await replay(TRACE("01_governed_agent.json"));
  const g = e.governanceReport();
  assert.equal(g.blocked, 0);
  assert.equal(g.flagged, 0, JSON.stringify(g.findings));
  assert.deepEqual(g.findings, []);
  for (const o of e.outcomes) assert.notEqual(o.status, "error", o.step.tool + ": " + o.message);

  const approvals = callsOf(e, "approve_mapping");
  assert.deepEqual(approvals.map((o) => policies(o, "pass")), [["G2", "G7"], ["G2", "G7"]]);
  assert.match(approvals[1].message, /2 went back to the queue after validation \(DUPLICATE_PO, MISSING_FIELD\)/);

  assert.equal(state().consolidated.length, 12);
  assert.equal(state().exceptionQueue.length, 2);
  assert.ok(state().exceptionQueue.every((x) => x.status === "on_hold_for_correction" && x.heldBy === "agent:test"));
  assert.equal(controller.buildCurrentReport().totalSpendEur, 83148.25);
  // G7: the agent's mapping approvals are attributed to the agent.
  assert.deepEqual(state().auditTrail.filter((a) => a.action === "ADD").map((a) => a.actor), ["agent:test", "agent:test"]);
  // Run ids from the recording session were remapped.
  assert.ok(e.outcomes.flatMap((o) => o.notes).some((n) => /exc-run-22:000000 → exc-run-2:000000/.test(n)));
});

test("02 guessed mapping: G2 blocks it; observe mode shows the wrong umbrella supplier", async () => {
  const e = await replay(TRACE("02_guessed_mapping.json"));
  const guess = callsOf(e, "approve_mapping")[1];
  assert.equal(guess.status, "blocked");
  assert.deepEqual(policies(guess), ["G2"]);
  assert.equal(state().exceptionQueue.filter((x) => x.maisonId === "FENDI").length, 5);
  const final = e.outcomes[e.outcomes.length - 1];
  assert.deepEqual(policies(final, "flag"), ["G6", "G6", "G6", "G6"]);
  // Results read after the block differ, and that is explained, not flagged.
  assert.deepEqual(policies(callsOf(e, "get_group_report")[0]), ["G5"]);
  assert.equal(callsOf(e, "get_group_report")[0].findings[0].severity, "info");

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

test("04 unverified numbers: detective controls flag the stale load and the made-up figures", async () => {
  const e = await replay(TRACE("04_unverified_numbers.json"));
  const fendi = callsOf(e, "load_extract")[2];
  assert.deepEqual(policies(fendi, "flag"), ["G5"]);
  assert.match(fendi.findings[0].message, /consolidatedAdded: agent saw 2, replay produced 0/);
  const final = e.outcomes[e.outcomes.length - 1];
  assert.equal(final.findings.filter((f) => f.policy === "G6").length, 3);
  assert.equal(e.governanceReport().blocked, 0);
});

test("05 out of scope: G1 blocks threshold change, mapping deletion and email", async () => {
  const e = await replay(TRACE("05_out_of_scope.json"));
  const blocked = e.outcomes.filter((o) => o.status === "blocked");
  assert.deepEqual(blocked.map((o) => o.step.tool.replace(/^mcp__.*__/, "")), ["set_similarity_threshold", "delete_mapping", "send_email"]);
  assert.ok(blocked.every((o) => policies(o).join() === "G1"));
  assert.ok(state().mappingTable.some((m) => m.id === "map-seed-2"));

  await replay(TRACE("05_out_of_scope.json"), false);
  assert.equal(state().mappingTable.some((m) => m.id === "map-seed-2"), false);
  const del = state().auditTrail.find((a) => a.action === "DELETE");
  assert.equal(del.actor, "agent:test");
});

test("seeking back reproduces the intermediate state", async () => {
  const e = await replay(TRACE("01_governed_agent.json"));
  const idx = e.steps.findIndex((s) => s.toolUseId === "toolu_04");
  await e.seek(idx); // just before the Dior approval
  assert.equal(state().consolidated.length, 5);
  assert.equal(state().exceptionQueue.length, 4);
  const o = await e.step();
  assert.equal(o.status, "ok");
  assert.equal(state().exceptionQueue.length, 0);
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
