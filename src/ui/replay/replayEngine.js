// src/ui/replay/replayEngine.js
//
// Governed replay engine for agent traces. DOM-free: it drives the
// controller's own operations (injected as `ops`) step by step, so a replayed
// tool call goes through exactly the same pipeline as a click in the UI.
//
// Every tool call first passes the agent policy (src/core/agentPolicy.js),
// acting as the gateway between the agent and the governed data:
//   - Enforce mode: calls that violate a preventive policy are BLOCKED and
//     never reach the data. This is what the governed system would do.
//   - Observe mode: everything runs and violations are only marked "would
//     block". This shows the damage the same agent does with no governance.
// After each step the detective checks run: result integrity (did the agent
// see what the data says?) and grounded claims (are its statements true?).
// Executed actions are recorded under the agent's identity (attribution).
//
// Setup steps (the reviewer loading extracts before the session) run first,
// as the reviewer, outside the agent policy. The agent then reads through
// read-only SQL (deps.sql) and acts through governed tools.
//
// Identity: a trace was recorded in another session, so its ids (e.g.
// exception "exc-run-12:0003") may not exist here. They are resolved by
// (1) exact id, (2) run ids remapped from setup/load results, (3) the
// invoice the agent saw next to that id in an earlier SQL result, (4) the
// record's invoiceRef / poRef in the call, (5) a unique sequence suffix.
// Every remap is reported on the step.

import { camelizeKeys } from "../../core/agentTrace.js";
import { buildGroupReport } from "../../core/reporting.js";
import { detectFinanceFormat } from "../../core/financeAdapter.js";
import { checkAction, checkScope, checkResult, checkSqlResult, checkClaims, rowsFrom } from "../../core/agentPolicy.js";
import { checkReadOnly, routeForSql, describeSchema } from "../../core/sqlView.js";

const MAISON_ALIASES = { LOUISVUITTON: "LV", LV: "LV", DIOR: "DIOR", CHRISTIANDIOR: "DIOR", FENDI: "FENDI" };
const AUDITED_OPS = new Set(["approveMapping", "addMapping", "resolveException", "deleteMapping"]);

/**
 * @param {Object} deps
 * @param {Object[]} deps.steps       steps from parseTrace()
 * @param {Object}   deps.ops         controller operations (loadExtract, ...)
 * @param {Function} deps.reset       async () => void; puts the app on clean seeded state
 * @param {Function} deps.getState    () => live controller state
 * @param {Function} deps.fetchText   async (path) => string; reads a CSV the trace refers to
 * @param {Function} [deps.sql]       async (state, query) => { columns, rows, truncated }; runs agent SQL
 * @param {boolean}  [deps.enforce=true]  block policy violations (false = observe only)
 * @param {string}   [deps.actor="agent"] identity recorded in the Audit Trail
 */
export function createReplayEngine({ steps, ops, reset, getState, fetchText, sql, enforce = true, actor = "agent" }) {
  let position = 0;
  let ctx = freshContext();
  const outcomes = new Array(steps.length).fill(null);

  function freshContext() {
    return { runMap: new Map(), csvCache: new Map(), history: [], groundTexts: [], blockedSoFar: 0, idHints: new Map(), replayNumbers: new Set() };
  }

  function report() {
    const s = getState();
    try {
      return buildGroupReport(s.consolidated, s.mappingTable, null, { now: "-", exceptionsRemaining: (s.exceptionQueue || []).length });
    } catch { return null; }
  }

  /** Snapshot of the numbers the player shows as before/after deltas. */
  function summarize() {
    const s = getState();
    const r = report();
    return {
      consolidated: (s.consolidated || []).length,
      exceptions: (s.exceptionQueue || []).length,
      mappings: (s.mappingTable || []).filter((m) => m && m.status === "approved").length,
      audit: (s.auditTrail || []).length,
      spendEur: r ? Math.round((r.totalSpendEur || 0) * 100) / 100 : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Id resolution.
  // -------------------------------------------------------------------------

  function queue() { return getState().exceptionQueue || []; }

  function resolveExceptionId(rawId, args) {
    const q = queue();
    const id = rawId == null ? "" : String(rawId);
    if (id && q.some((e) => e.id === id)) return { id, note: null };

    const m = /^exc-(.+):(\d+)$/.exec(id);
    if (m && ctx.runMap.has(m[1])) {
      const mapped = "exc-" + ctx.runMap.get(m[1]) + ":" + m[2];
      if (q.some((e) => e.id === mapped)) {
        return { id: mapped, note: "Trace id " + id + " → " + mapped + " (run " + m[1] + " replayed as " + ctx.runMap.get(m[1]) + ")." };
      }
    }

    const hint = ctx.idHints.get(id);
    if (hint && hint.invoiceRef) {
      const hit = q.find((e) => e.record && e.record.invoiceRef === hint.invoiceRef && (!hint.maison || e.maisonId === hint.maison));
      if (hit) return { id: hit.id, note: id === hit.id ? null : "Trace id " + id + " → " + hit.id + " (the agent read it as " + hint.invoiceRef + ")." };
    }

    const maison = normalizeMaison(args.maisonId ?? args.maison);
    const invoiceRef = args.invoiceRef ?? args.invoice;
    const poRef = args.poRef ?? args.po;
    if (invoiceRef || poRef) {
      const hit = q.find((e) => e.record
        && (!invoiceRef || e.record.invoiceRef === invoiceRef)
        && (!poRef || e.record.poRef === poRef)
        && (!maison || e.maisonId === maison));
      if (hit) return { id: hit.id, note: "Matched by record reference (" + (invoiceRef || poRef) + ") → " + hit.id + "." };
    }

    if (m) {
      const hits = q.filter((e) => e.id.endsWith(":" + m[2]) && (!maison || e.maisonId === maison));
      if (hits.length === 1) return { id: hits[0].id, note: "Trace id " + id + " → " + hits[0].id + " (matched by sequence number)." };
    }
    return { id: null, note: "Could not find exception " + (id || "(none given)") + " in the replayed queue." };
  }

  function exceptionsMatching(draft) {
    const key = [draft.maisonId, draft.localSupplierCode, draft.localAccountCode].join("\u0000");
    return queue()
      .filter((e) => [e.maisonId, e.localCodes && e.localCodes.supplierCode, e.localCodes && e.localCodes.accountCode].join("\u0000") === key)
      .map((e) => e.id);
  }

  // -------------------------------------------------------------------------
  // Planning: resolve arguments, run the policy, decide what to show first.
  // -------------------------------------------------------------------------

  /**
   * Plan the next step without changing app state. The player shows
   * `beforeRoute` + `focusBefore` first, then calls commit(plan).
   */
  async function prepare() {
    if (position >= steps.length) return null;
    const step = steps[position];
    const plan = {
      index: position,
      step,
      beforeRoute: null,
      focusBefore: [],
      notes: [],
      findings: [],
      blocked: false,
      subject: null,
      run: null, // async () => { status, message, result, afterRoute, focusAfter }
    };

    if (step.kind === "narration") return plan;

    if (step.kind === "setup") {
      // The reviewer's own action: not an agent call, so no agent policy.
      try { await planAction(plan, step.op, camelizeKeys(step.input)); }
      catch (err) { plan.run = async () => ({ status: "error", message: err && err.message ? err.message : String(err) }); }
      return plan;
    }

    if (step.kind === "observe") {
      plan.beforeRoute = step.route;
      plan.run = async () => ({
        status: "ok",
        message: "Agent read the " + routeLabel(step.route) + ".",
        result: step.route === "#report" ? report() : null,
        afterRoute: step.route,
        focusAfter: [],
      });
      return plan;
    }

    const op = step.kind === "action" ? step.op : null;
    const args = camelizeKeys(step.input);

    // G1 first: an out-of-scope call is never even resolved against the data.
    const scope = checkScope(op, step.tool);
    if (scope.length > 0 && (enforce || !op)) {
      // Without an app operation the call cannot run in either mode; in
      // Observe mode it is reported as "would block" rather than blocked.
      if (!enforce) for (const f of scope) f.severity = "would-block";
      plan.findings.push(...scope);
      plan.blocked = true;
      return plan;
    }

    try {
      await planAction(plan, op, args);
    } catch (err) {
      plan.run = async () => ({ status: "error", message: err && err.message ? err.message : String(err) });
      return plan;
    }

    const findings = checkAction(plan.subject, ctx.history);
    plan.findings.push(...findings);
    if (findings.some((f) => f.severity === "block")) {
      if (enforce) plan.blocked = true;
      else for (const f of plan.findings) if (f.severity === "block") f.severity = "would-block";
    }
    return plan;
  }

  async function planAction(plan, op, args) {
    switch (op) {
      case "loadExtract":
      case "loadFinanceExtract": {
        const maison = normalizeMaison(args.maisonId ?? args.maison ?? args.maisonCode);
        const csv = await csvFor(args, maison);
        const finance = op === "loadFinanceExtract" || detectFinanceFormat(csv);
        if (!finance && !maison) throw new Error("load_extract needs a maison_id.");
        plan.subject = { op, tool: plan.step.tool };
        plan.beforeRoute = "#load";
        plan.focusBefore = maison ? [{ type: "seed", id: maison }] : [];
        plan.run = async () => {
          const beforeIds = new Set(queue().map((e) => e.id));
          const res = finance ? ops.loadFinanceExtract(csv) : ops.loadExtract(maison, csv);
          if (finance && res && res.ok === false) return { status: "error", message: res.error, result: res };
          const added = queue().filter((e) => !beforeIds.has(e.id)).map((e) => e.id);
          const originalRun = originalRunId(plan.step.traceResult);
          if (originalRun && res && res.runId && originalRun !== res.runId) {
            ctx.runMap.set(originalRun, res.runId);
            plan.notes.push("Trace run " + originalRun + " is replayed as " + res.runId + "; later ids are remapped.");
          }
          return {
            status: "ok",
            message: (finance ? "Loaded finance export" : "Loaded " + maison + " extract") + ": "
              + (res.consolidatedAdded || 0) + " consolidated, " + (res.exceptionsAdded || 0) + " to the Exception Queue.",
            result: res,
            afterRoute: added.length > 0 ? "#exceptions" : "#report",
            focusAfter: added.map((id) => ({ type: "exception", id })),
          };
        };
        return;
      }

      case "querySql": {
        const query = String(args.query ?? args.sql ?? args.statement ?? args.q ?? "").trim();
        if (!query) throw new Error("The SQL call has no query.");
        plan.subject = { op, tool: plan.step.tool, sql: query };
        plan.beforeRoute = routeForSql(query);
        plan.run = async () => {
          if (!checkReadOnly(query).ok) {
            return { status: "skipped", message: "Not executed: SQL writes never reach the governed data. Under Enforce this is blocked.", afterRoute: plan.beforeRoute };
          }
          if (typeof sql !== "function") return { status: "error", message: "No SQL engine is available in this replay." };
          let res;
          try { res = await sql(getState(), query); }
          catch (err) { return { status: "error", message: "SQL error: " + (err && err.message ? err.message : String(err)) }; }
          for (const row of res.rows) for (const v of Object.values(row)) if (typeof v === "number") ctx.replayNumbers.add(Math.round(v * 100) / 100);
          const focus = [];
          for (const row of res.rows) {
            if (row.exception_id) focus.push({ type: "exception", id: row.exception_id });
            else if (row.mapping_id) focus.push({ type: "mapping", id: row.mapping_id });
          }
          return {
            status: "ok",
            message: "Query returned " + res.rows.length + " row(s)" + (res.truncated ? " (truncated)" : "") + ".",
            result: res,
            afterRoute: plan.beforeRoute,
            focusAfter: focus,
          };
        };
        return;
      }

      case "describeSchema": {
        const table = args.tableName ?? args.table ?? null;
        plan.subject = { op, tool: plan.step.tool };
        plan.run = async () => {
          const rows = describeSchema(table);
          return { status: "ok", message: "Schema" + (table ? " of " + table : "") + ": " + rows.length + " row(s).", result: { columns: Object.keys(rows[0] || {}), rows } };
        };
        return;
      }

      case "approveMapping":
      case "addMapping": {
        let excId = null;
        let exc = null;
        const rawExc = args.exceptionId ?? args.exception;
        if (op === "approveMapping" && rawExc != null) {
          const r = resolveExceptionId(rawExc, args);
          if (r.note) plan.notes.push(r.note);
          excId = r.id;
          exc = excId ? queue().find((e) => e.id === excId) : null;
          if (!exc) throw new Error(r.note);
        }
        const draft = buildDraft(args, exc);
        if (!exc) {
          const firstId = exceptionsMatching(draft)[0];
          exc = firstId ? queue().find((e) => e.id === firstId) : null;
        }
        const affected = exceptionsMatching(draft);
        plan.subject = { op, tool: plan.step.tool, draft, exception: exc };
        plan.beforeRoute = affected.length > 0 ? "#exceptions" : "#mappings";
        plan.focusBefore = affected.map((id) => ({ type: "exception", id }));
        plan.run = async () => {
          const res = excId ? ops.approveMapping(excId, draft, actor) : ops.addMapping(draft, actor);
          if (!res || !res.ok) return { status: "error", message: "Rejected by the app (G4): " + ((res && (res.message || res.error)) || "approval failed."), result: res };
          const requeued = res.requeuedCount
            ? " " + res.requeuedCount + " went back to the queue after validation (" + res.requeued.map((x) => x.reason).join(", ") + ")."
            : "";
          return {
            status: "ok",
            message: "Approved " + draft.maisonId + " " + draft.localSupplierCode + "/" + draft.localAccountCode
              + " → " + draft.lvmhSupplierId + "/" + draft.lvmhAccountCode + "; " + res.resolvedCount + " record(s) consolidated." + requeued,
            result: res,
            afterRoute: res.requeuedCount ? "#exceptions" : "#mappings",
            focusAfter: res.requeuedCount
              ? res.requeued.map((x) => ({ type: "exception", id: x.id }))
              : res.entry ? [{ type: "mapping", id: res.entry.id }] : [],
          };
        };
        return;
      }

      case "resolveException":
      case "rejectResolution": {
        const r = resolveExceptionId(args.exceptionId ?? args.exception ?? args.id, args);
        if (r.note) plan.notes.push(r.note);
        if (!r.id) throw new Error(r.note);
        const exc = queue().find((e) => e.id === r.id);
        const given = String(args.reason ?? args.note ?? args.comment ?? "").trim();
        plan.subject = { op, tool: plan.step.tool, exception: exc, reason: given };
        const reason = given || (op === "resolveException" ? "" : "Held by agent");
        plan.beforeRoute = "#exceptions";
        plan.focusBefore = [{ type: "exception", id: r.id }];
        plan.run = async () => {
          const res = op === "resolveException" ? ops.resolveException(r.id, reason, actor) : ops.rejectResolution(r.id, reason, actor);
          if (!res || !res.ok) return { status: "error", message: "Rejected by the app (G4): " + ((res && (res.message || res.error)) || "operation failed."), result: res };
          return op === "resolveException"
            ? { status: "ok", message: "Cleared " + r.id + " by override: \"" + reason + "\".", result: res, afterRoute: "#exceptions", focusAfter: [] }
            : { status: "ok", message: "Put " + r.id + " on hold: \"" + reason + "\".", result: res, afterRoute: "#exceptions", focusAfter: [{ type: "exception", id: r.id }] };
        };
        return;
      }

      case "deleteMapping": {
        const table = getState().mappingTable || [];
        let id = args.mappingId ?? args.id ?? null;
        if (!table.some((m) => m.id === id)) {
          const d = camelizeKeys(args.draft || args);
          const hit = table.find((m) => m.maisonId === normalizeMaison(d.maisonId ?? d.maison)
            && m.localSupplierCode === d.localSupplierCode && m.localAccountCode === d.localAccountCode);
          if (!hit) throw new Error("Mapping " + (id || "(none given)") + " not found in the replayed table.");
          if (id) plan.notes.push("Trace mapping " + id + " → " + hit.id + " (matched by local codes).");
          id = hit.id;
        }
        const reason = String(args.reason ?? args.note ?? "").trim();
        plan.subject = { op, tool: plan.step.tool };
        plan.beforeRoute = "#mappings";
        plan.focusBefore = [{ type: "mapping", id }];
        plan.run = async () => {
          const res = ops.deleteMapping(id, reason, actor);
          if (!res || !res.ok) return { status: "error", message: (res && res.error) || "Delete failed.", result: res };
          return { status: "ok", message: "Deleted mapping " + id + ".", result: res, afterRoute: "#mappings", focusAfter: [] };
        };
        return;
      }

      default:
        throw new Error("No app operation is mapped to tool \"" + plan.step.tool + "\".");
    }
  }

  function buildDraft(args, exc) {
    const d = args.draft && typeof args.draft === "object" ? camelizeKeys(args.draft) : args;
    const local = (exc && exc.localCodes) || {};
    let lvmhSupplierId = d.lvmhSupplierId;
    let lvmhAccountCode = d.lvmhAccountCode;
    if ((!lvmhSupplierId || !lvmhAccountCode) && exc && exc.recommendation && exc.recommendation.suggestion) {
      lvmhSupplierId = lvmhSupplierId || exc.recommendation.suggestion.lvmhSupplierId;
      lvmhAccountCode = lvmhAccountCode || exc.recommendation.suggestion.lvmhAccountCode;
    }
    const draft = {
      maisonId: normalizeMaison(d.maisonId ?? d.maison) || (exc && exc.maisonId),
      localSupplierCode: d.localSupplierCode ?? local.supplierCode,
      localAccountCode: d.localAccountCode ?? local.accountCode,
      lvmhSupplierId,
      lvmhAccountCode,
      origin: "agent",
    };
    for (const k of ["maisonId", "localSupplierCode", "localAccountCode", "lvmhSupplierId", "lvmhAccountCode"]) {
      if (draft[k] == null || draft[k] === "") throw new Error("Mapping is missing " + k + " (not in the call, and no agent suggestion to fall back on).");
    }
    return draft;
  }

  async function csvFor(args, maison) {
    const inline = args.csvText ?? args.csv ?? args.content ?? args.data;
    if (typeof inline === "string" && inline.trim() !== "") return inline;
    let path = args.file ?? args.path ?? args.filename ?? args.filePath;
    if (path) {
      // Extracts are served from seed/. A path from the recording machine
      // (absolute, a URL, or a bare file name) resolves to its file name there.
      path = String(path);
      if (!/^seed\/[^/]+$/.test(path)) path = "seed/" + path.split(/[\\/]/).pop();
    } else {
      const seeded = getState().seedExtracts || {};
      if (maison && typeof seeded[maison] === "string" && seeded[maison] !== "") return seeded[maison];
      if (!maison) throw new Error("The load call has no CSV text, file, or maison to fall back on.");
      path = "seed/" + maison.toLowerCase() + "_extract.csv";
    }
    if (ctx.csvCache.has(path)) return ctx.csvCache.get(path);
    let text;
    try { text = await fetchText(path); }
    catch (err) { throw new Error("Could not read " + path + " referenced by the trace: " + (err && err.message ? err.message : err)); }
    ctx.csvCache.set(path, text);
    return text;
  }

  // -------------------------------------------------------------------------
  // Execution.
  // -------------------------------------------------------------------------

  function facts() {
    const r = report();
    const s = getState();
    const figures = [];
    if (r) {
      figures.push(r.totalSpendEur);
      for (const x of r.spendBySupplier || []) figures.push(x.spendEur);
      for (const x of r.spendByCategory || []) figures.push(x.spendEur);
    }
    const maisons = {};
    for (const c of s.consolidated || []) {
      if (!c || !c.lvmhSupplierId) continue;
      (maisons[c.lvmhSupplierId] = maisons[c.lvmhSupplierId] || new Set()).add(c.maisonId);
    }
    const maisonsBySupplier = {};
    for (const [k, v] of Object.entries(maisons)) maisonsBySupplier[k] = v.size;
    // Figures the agent could legitimately cite: report totals plus any number
    // the governed data returned to its SQL in this replay.
    for (const n of ctx.replayNumbers) figures.push(n);
    return { consolidated: (s.consolidated || []).length, exceptions: (s.exceptionQueue || []).length, figures, maisonsBySupplier };
  }

  /** Execute a prepared plan, advance, and return the step outcome. */
  async function commit(plan) {
    if (!plan) return null;
    const step = plan.step;
    const before = summarize();
    const findings = plan.findings.slice();
    let out;

    if (plan.blocked && enforce) {
      ctx.blockedSoFar += 1;
      out = { status: "blocked", message: "Blocked by policy: the call never reached the governed data.", afterRoute: plan.beforeRoute };
    } else if (plan.blocked) {
      out = { status: "skipped", message: "Not executed: this tool is outside the app, so there is nothing to replay. Under Enforce it is blocked.", afterRoute: plan.beforeRoute };
    } else if (!plan.run) {
      out = { status: step.kind === "narration" ? "narration" : "skipped", message: "" };
    } else {
      try { out = await plan.run(); }
      catch (err) { out = { status: "error", message: err && err.message ? err.message : String(err) }; }
    }

    if (out.status === "ok" && step.kind !== "setup") {
      findings.push(...(step.op === "querySql" ? checkSqlResult(step, out.result, ctx) : checkResult(step, out.result, ctx)));
      if (step.kind === "action" && AUDITED_OPS.has(step.op)) {
        findings.push({ policy: "G7", severity: "pass", message: "Recorded in the Audit Trail as \"" + actor + "\"." });
      }
    }

    if (step.kind === "narration") {
      if (step.role === "agent") findings.push(...checkClaims(step.text, facts(), ctx.groundTexts));
      if (step.role === "user" || step.role === "agent") ctx.history.push({ role: step.role, text: step.text });
    }
    if (step.traceResult && step.traceResult.text) {
      ctx.groundTexts.push(step.traceResult.text);
      // Remember which invoice each exception id stood for in what the agent
      // read, so later calls naming that id resolve to the same record.
      const seen = step.op === "querySql" ? rowsFrom(step.traceResult.text) : null;
      for (const row of seen || []) {
        if (row && row.exception_id && row.invoice_ref) ctx.idHints.set(row.exception_id, { invoiceRef: row.invoice_ref, maison: row.maison || null });
      }
    }
    if (step.kind === "setup" && step.input && step.input.run_id && out.result && out.result.runId) {
      ctx.runMap.set(String(step.input.run_id), out.result.runId);
    }

    const after = summarize();
    const outcome = {
      index: plan.index,
      step,
      status: out.status,
      message: out.message || "",
      result: out.result || null,
      notes: plan.notes,
      findings,
      governance: governanceOf(out.status, findings),
      beforeRoute: plan.beforeRoute,
      afterRoute: out.afterRoute || plan.beforeRoute,
      focusBefore: plan.focusBefore,
      focusAfter: out.focusAfter || [],
      before,
      after,
      delta: diff(before, after),
      diverged: divergence(step, out.status),
    };
    outcomes[plan.index] = outcome;
    position = plan.index + 1;
    return outcome;
  }

  async function step() {
    return commit(await prepare());
  }

  /** Reset to clean state and silently replay up to (not including) `index`. */
  async function seek(index) {
    const target = Math.max(0, Math.min(index, steps.length));
    await reset();
    ctx = freshContext();
    position = 0;
    outcomes.fill(null);
    while (position < target) await step();
    return position;
  }

  /** Governance summary of everything replayed so far. */
  function governanceReport() {
    const done = outcomes.filter(Boolean);
    const calls = done.filter((o) => o.step.kind === "action" || o.step.kind === "unsupported");
    const items = [];
    for (const o of done) for (const f of o.findings) {
      if (f.severity === "pass" || f.severity === "info") continue;
      items.push({ index: o.index, tool: o.step.tool || null, role: o.step.role || null, ...f });
    }
    return {
      enforce,
      actor,
      replayed: done.length,
      total: steps.length,
      actions: calls.length,
      executed: calls.filter((o) => o.status === "ok").length,
      blocked: calls.filter((o) => o.status === "blocked").length,
      rejectedByApp: calls.filter((o) => o.status === "error" && /\(G4\)/.test(o.message)).length,
      wouldBlock: done.filter((o) => o.findings.some((f) => f.severity === "would-block")).length,
      flagged: done.filter((o) => o.findings.some((f) => f.severity === "flag")).length,
      findings: items,
      final: summarize(),
    };
  }

  return {
    steps,
    outcomes,
    get position() { return position; },
    get done() { return position >= steps.length; },
    get enforce() { return enforce; },
    prepare,
    commit,
    step,
    seek,
    summarize,
    governanceReport,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function governanceOf(status, findings) {
  if (status === "blocked") return "blocked";
  if (status === "error" && findings.length === 0) return "rejected";
  if (findings.some((f) => f.severity === "would-block")) return "would-block";
  if (findings.some((f) => f.severity === "flag")) return "flagged";
  if (findings.some((f) => f.severity === "pass")) return "passed";
  return null;
}

function normalizeMaison(v) {
  if (v == null || v === "") return null;
  const key = String(v).toUpperCase().replace(/[^A-Z]/g, "");
  return MAISON_ALIASES[key] || String(v).toUpperCase();
}

// The run id the ORIGINAL session reported for a load, read from the trace's
// tool_result: a JSON `runId`/`run_id` field, else the first "run-N" token.
function originalRunId(traceResult) {
  const text = traceResult && traceResult.text;
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    const v = obj && (obj.runId ?? obj.run_id);
    if (v) return String(v);
  } catch { /* not JSON */ }
  const m = /\b(run-\d+)\b/.exec(text);
  return m ? m[1] : null;
}

function diff(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = Math.round(((b[k] || 0) - (a[k] || 0)) * 100) / 100;
  return out;
}

// Flag when the replay disagrees with the trace on success vs. error.
function divergence(step, status) {
  if (!step.traceResult || (status !== "ok" && status !== "error")) return null;
  const traceErr = step.traceResult.isError;
  if (traceErr && status === "ok") return "The original call failed, but it succeeded on replay.";
  if (!traceErr && status === "error") return "The original call succeeded, but it failed on replay.";
  return null;
}

function routeLabel(route) {
  return ({ "#load": "Load Extracts view", "#exceptions": "Exception Queue", "#mappings": "Mapping Table", "#report": "Group Report", "#sourcing": "Strategic Sourcing analysis" })[route] || route;
}
