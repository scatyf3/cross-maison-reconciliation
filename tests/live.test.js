// tests/live.test.js
//
// The v2 live agent feeds each turn into a replay engine whose `steps` array
// grows as the conversation goes (v2/live.js). These tests drive the engine
// the same way, with tool calls built exactly as live.js builds them, to pin
// down that the policy gateway behaves for a live session as it does for a
// recorded trace.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { useInMemoryBackend, resetAll, seedIfEmpty } from "../src/store/browserStore.js";
import * as controller from "../src/ui/appController.js";
import { classifyTool } from "../src/core/agentTrace.js";
import { createReplayEngine } from "../src/ui/replay/replayEngine.js";
import { createSqlRunner } from "../src/ui/replay/sqlRunner.js";
import initSqlJs from "sql.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (p) => readFileSync(join(ROOT, p), "utf8");
const STARTER = JSON.parse(readText("src/seed/starterMappingTable.json"));
const SEED_META = [{ id: "LV" }, { id: "DIOR" }, { id: "FENDI" }];

useInMemoryBackend();
const sqlRunner = createSqlRunner(await initSqlJs());

function freshData() {
  resetAll();
  seedIfEmpty({ mappingTable: STARTER });
  controller.reloadStateFromStore();
  const st = controller.getState();
  st.seedExtractMeta = SEED_META;
  st.seedExtracts = Object.fromEntries(SEED_META.map((m) => [m.id, readText("seed/" + m.id.toLowerCase() + "_extract.csv")]));
  controller.preloadSeedExtracts();
}

function liveSession() {
  const steps = [];
  const engine = createReplayEngine({
    steps, ops: controller, reset: async () => {}, getState: controller.getState,
    fetchText: async (p) => readText(p), enforce: true, actor: "agent:claude",
    sql: async (st, q) => sqlRunner.run(st, q),
  });
  const run = async (step) => { steps.push(step); return engine.commit(await engine.prepare()); };
  return {
    engine,
    say: (role, text) => run({ kind: "narration", role, text }),
    tool: (name, input) => {
      const cls = classifyTool(name, input);
      return run({ kind: cls.kind, op: cls.op || null, route: cls.route || null, tool: name, toolUseId: "t", input, traceResult: null });
    },
  };
}

const fendiExc = () => controller.getState().exceptionQueue.find((e) => e.maisonId === "FENDI").id;

test("live: an unevidenced mapping is blocked by G2 and never reaches the data", async () => {
  freshData();
  const s = liveSession();
  await s.say("user", "Reconcile Fendi.");
  const before = controller.getState().mappingTable.length;
  const o = await s.tool("approve_mapping", { exception_id: fendiExc(), lvmh_supplier_id: "LVMH-SUP-000457", lvmh_account_code: "ACCT-6110" });
  assert.equal(o.status, "blocked");
  assert.ok(o.findings.some((f) => f.policy === "G2" && f.severity === "block"));
  assert.equal(controller.getState().mappingTable.length, before);
});

test("live: the same mapping passes once the reviewer confirms it in chat, and is attributed", async () => {
  freshData();
  const s = liveSession();
  await s.say("user", "Reconcile Fendi.");
  await s.say("agent", "Fendi's 77821 has no suggestion. Shall I map 77821 to LVMH-SUP-000457 / ACCT-6110?");
  await s.say("user", "yes");
  const o = await s.tool("approve_mapping", { exception_id: fendiExc(), lvmh_supplier_id: "LVMH-SUP-000457", lvmh_account_code: "ACCT-6110" });
  assert.equal(o.status, "ok", o.message);
  assert.ok(o.findings.some((f) => f.policy === "G2" && f.severity === "pass"));
  const last = controller.getState().auditTrail.at(-1);
  assert.equal(last.actor, "agent:claude");
});

test("live: SQL reads run; a figure is grounded only after the result is sent to the agent", async () => {
  freshData();
  const s = liveSession();
  await s.say("user", "What's the Group spend?");
  const q = await s.tool("query_sql", { query: "SELECT ROUND(SUM(spend_eur), 2) AS total FROM consolidated_records" });
  assert.equal(q.status, "ok");
  const total = q.result.rows[0].total;
  const claim = "Group spend is €" + total.toFixed(2) + ".";

  const ungrounded = await s.say("agent", claim);
  assert.ok(ungrounded.findings.some((f) => f.policy === "G6"), "not yet in anything the agent was sent");

  s.engine.ground(JSON.stringify(q.result.rows));
  const grounded = await s.say("agent", claim);
  assert.deepEqual(grounded.findings.filter((f) => f.policy === "G6"), []);
});

test("live: a SQL write is blocked by G1", async () => {
  freshData();
  const s = liveSession();
  const o = await s.tool("query_sql", { query: "DELETE FROM mapping_table" });
  assert.equal(o.status, "blocked");
  assert.ok(o.findings.some((f) => f.policy === "G1"));
});
