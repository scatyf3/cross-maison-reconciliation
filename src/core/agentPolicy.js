// src/core/agentPolicy.js
//
// Agent governance policy. Pure: no DOM, no storage.
//
// When an AI agent's trace is replayed, every tool call passes through this
// policy before it reaches the controller, the same way a production gateway
// would sit between an agent and the governed data. Three layers:
//
//   Preventive  G1 tool scope, G2 evidence for mappings, G3 override authority
//               -> violations are BLOCKED (in Enforce mode) and never run.
//               G4 hard controls are the app's own checks (conflicting or
//               invalid mappings, overriding an unmapped record); they reject
//               the call no matter who makes it.
//   Detective   G5 result integrity, G6 grounded claims
//               -> run after the fact; violations are FLAGGED.
//   Accountability
//               G7 attribution: every executed agent action is written to the
//               Audit Trail under the agent's identity (done by the engine).
//
// The policy only decides; the replay engine applies the decision.

export const POLICIES = Object.freeze({
  G1: { id: "G1", name: "Tool scope", layer: "Preventive",
    rule: "Agents may load extracts, read views, approve evidenced mappings and put records on hold. They may not delete governed mappings or call tools outside the app." },
  G2: { id: "G2", name: "Evidence for mappings", layer: "Preventive",
    rule: "An agent may approve a mapping only if the recommender suggested exactly those LVMH codes, or a person confirmed them in the conversation. Otherwise the mapping goes to a human reviewer as a proposal." },
  G3: { id: "G3", name: "Override authority", layer: "Preventive",
    rule: "Clearing a validation exception (duplicate PO, missing goods receipt, price variance) is a human decision. An agent override needs a written reason and a person's explicit confirmation for that invoice or PO." },
  G4: { id: "G4", name: "Hard controls", layer: "Preventive",
    rule: "The app rejects conflicting or invalid mappings and overrides of unmapped records, whoever calls them." },
  G5: { id: "G5", name: "Result integrity", layer: "Detective",
    rule: "What the agent saw in each tool result must match what the governed replay produces." },
  G6: { id: "G6", name: "Grounded claims", layer: "Detective",
    rule: "Figures and status claims in the agent's messages must match the data and appear in a tool result the agent actually read." },
  G7: { id: "G7", name: "Attribution", layer: "Accountability",
    rule: "Every action the agent executes is recorded in the Audit Trail under the agent's identity." },
});

/** Operations an agent is allowed to request at all (G1). */
const AGENT_ALLOWED_OPS = new Set([
  "loadExtract", "loadFinanceExtract", "approveMapping", "addMapping", "resolveException", "rejectResolution",
]);

const AFFIRMATIVE = /^\s*(yes|yep|yeah|correct|confirmed?|approved?|go ahead|do it|ok(ay)?|sure|right|that'?s right|是|对|可以|确认|没错|同意)\b/i;

/**
 * Pre-execution check for one planned agent action.
 *
 * @param {Object} subject   what the engine resolved for the call:
 *   { op, tool, draft?, exception?, reason? }
 * @param {Object[]} history narration seen so far: [{ role: "user"|"agent", text }]
 * @returns {Object[]} findings [{ policy, severity: "block", message, evidence? }]
 */
export function checkAction(subject, history) {
  const findings = [];
  const op = subject.op;

  if (!op || !AGENT_ALLOWED_OPS.has(op)) {
    findings.push(finding("G1", "block", scopeMessage(op, subject.tool)));
    return findings;
  }

  if (op === "approveMapping" || op === "addMapping") {
    const d = subject.draft || {};
    const sugg = subject.exception && subject.exception.recommendation;
    const suggested = sugg && sugg.status === "SUGGESTED" && sugg.suggestion
      && sugg.suggestion.lvmhSupplierId === d.lvmhSupplierId
      && sugg.suggestion.lvmhAccountCode === d.lvmhAccountCode;
    if (suggested) return findings;
    // The confirmation must cover this exact pairing: the LVMH id AND the
    // local supplier code. A "yes" to a different mapping does not count.
    const quote = humanConfirmation(history, { all: [d.lvmhSupplierId, d.localSupplierCode] });
    if (quote) return [finding("G2", "pass", "Confirmed by a person: \"" + clip(quote) + "\"")];
    const conf = sugg && typeof sugg.confidence === "number" ? " (recommender: " + (sugg.status || "no suggestion") + ", best confidence " + sugg.confidence + ")" : "";
    findings.push(finding("G2", "block",
      "Mapping " + d.maisonId + " " + d.localSupplierCode + "/" + d.localAccountCode + " → " + d.lvmhSupplierId + "/" + d.lvmhAccountCode
      + " is not backed by a recommender suggestion" + conf + ", and no person confirmed " + d.localSupplierCode + " → " + d.lvmhSupplierId + " in the conversation. It goes to a reviewer as a proposal instead."));
    return findings;
  }

  if (op === "resolveException") {
    const exc = subject.exception;
    const rec = (exc && exc.record) || {};
    if (!subject.reason || subject.reason.trim().length < 8) {
      findings.push(finding("G3", "block", "An override must carry a written reason; this call gave " + (subject.reason ? "only \"" + subject.reason + "\"" : "none") + "."));
    }
    const quote = humanConfirmation(history, { any: [rec.invoiceRef, rec.poRef] });
    if (!quote) {
      findings.push(finding("G3", "block",
        "Clearing a " + ((exc && exc.reason) || "validation") + " exception (" + (rec.invoiceRef || exc && exc.id) + ") needs a person's explicit confirmation, and none was given in the conversation."));
    } else if (findings.length === 0) {
      findings.push(finding("G3", "pass", "Signed off by a person: \"" + clip(quote) + "\""));
    }
    return findings;
  }

  return findings;
}

/**
 * Post-execution check: does the result the agent saw in its trace match the
 * replay? Only numeric/boolean fields both sides report are compared.
 *
 * @param {Object} step          the trace step (with traceResult)
 * @param {Object|null} replayed the replay's own result object
 * @param {{ blockedSoFar: number }} ctx
 */
export function checkResult(step, replayed, ctx) {
  if (!step.traceResult || !replayed) return [];
  let seen;
  try { seen = JSON.parse(step.traceResult.text); } catch { return []; }
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) return [];
  const keys = ["consolidatedAdded", "exceptionsAdded", "resolvedCount", "requeuedCount", "totalSpendEur", "exceptionsRemaining", "ok"];
  const diffs = [];
  for (const k of keys) {
    const a = k === "exceptionsRemaining" ? (seen.counts && seen.counts[k]) ?? seen[k] : seen[k];
    const b = k === "exceptionsRemaining" ? (replayed.counts && replayed.counts[k]) ?? replayed[k] : replayed[k];
    if (a === undefined || b === undefined) continue;
    const same = typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.005 : a === b;
    if (!same) diffs.push(k + ": agent saw " + fmt(a) + ", replay produced " + fmt(b));
  }
  if (diffs.length === 0) return [];
  const why = ctx && ctx.blockedSoFar > 0
    ? " Expected here: an earlier step was blocked, so the governed data diverged from the agent's run."
    : " Nothing was blocked before this step, so the agent was working from different data (stale extract, edited trace, or a fabricated result).";
  return [finding("G5", ctx && ctx.blockedSoFar > 0 ? "info" : "flag", diffs.join("; ") + "." + why)];
}

/**
 * Check the claims in one agent message against the data at that point.
 *
 * @param {string} text            agent message
 * @param {Object} facts           { consolidated, exceptions, figures: number[] } from the live data
 * @param {string[]} groundTexts   tool-result texts the agent has seen so far
 */
export function checkClaims(text, facts, groundTexts) {
  const out = [];
  const t = String(text || "");

  // Euro figures: each must appear in something the agent read, and in the data.
  const grounded = new Set();
  for (const g of groundTexts) for (const n of numbersIn(g)) grounded.add(n.toFixed(2));
  const real = new Set((facts.figures || []).map((n) => Number(n).toFixed(2)));
  const re = /(?:€|EUR\s?)\s?(\d[\d,]*(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(t))) {
    const v = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v) || v < 100) continue;
    const key = v.toFixed(2);
    const inRead = grounded.has(key);
    const inData = real.has(key);
    if (!inRead || !inData) {
      out.push(finding("G6", "flag", "Claims " + m[0].trim() + ": "
        + (inRead ? "it appeared in a tool result" : "it does not appear in any tool result the agent read")
        + (inData ? ", and it matches the data." : ", and it matches no figure in the governed data.")));
    }
  }

  // "Queue is empty" style claims.
  if (/(queue (is )?(now )?(empty|clear)|nothing (is )?left in the queue|no (open )?exceptions (left|remain)|cleared the (whole |entire )?queue|all exceptions (are |have been )?(resolved|cleared))/i.test(t) && facts.exceptions > 0) {
    out.push(finding("G6", "flag", "Claims the Exception Queue is clear, but " + facts.exceptions + " exception(s) remain."));
  }

  // "All N lines are consolidated" / "N lines consolidated".
  const c = /(?:all )?(\d+) (?:lines|records|invoices)\b[^.]*?\bconsolidated/i.exec(t);
  if (c && Number(c[1]) !== facts.consolidated) {
    out.push(finding("G6", "flag", "Claims " + c[1] + " lines are consolidated; the data has " + facts.consolidated + "."));
  }

  // "<supplier> serves all three Maisons" style claims.
  const words = { one: 1, two: 2, three: 3, four: 4 };
  const sm = /(LVMH-SUP-\d+)[^.]*?\b(?:all (three|3)|(one|two|three|four|\d+)) Maisons?\b/i.exec(t);
  if (sm && facts.maisonsBySupplier) {
    const claimed = sm[2] ? 3 : (words[sm[3].toLowerCase()] ?? Number(sm[3]));
    const actual = facts.maisonsBySupplier[sm[1]] || 0;
    if (Number.isFinite(claimed) && claimed !== actual) {
      out.push(finding("G6", "flag", "Claims " + sm[1] + " serves " + claimed + " Maison(s); in the data it serves " + actual + "."));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Find a person's confirmation in the conversation. A user turn confirms when
 * it names the terms itself, or when it is an affirmative reply ("yes", "go
 * ahead") to the agent message right before it that named them.
 *
 * @param {Object[]} history  [{ role, text }]
 * @param {{ all?: string[], any?: string[] }} terms
 *        all: every term must be named; any: at least one must be
 * @returns {string|null} the confirming user text
 */
export function humanConfirmation(history, terms) {
  const all = ((terms && terms.all) || []).filter(Boolean).map((x) => String(x).toLowerCase());
  const any = ((terms && terms.any) || []).filter(Boolean).map((x) => String(x).toLowerCase());
  if (all.length === 0 && any.length === 0) return null;
  const covers = (text) => {
    const lower = text.toLowerCase();
    return all.every((w) => lower.includes(w)) && (any.length === 0 || any.some((w) => lower.includes(w)));
  };
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== "user") continue;
    const text = String(h.text || "");
    if (covers(text)) return text;
    if (AFFIRMATIVE.test(text)) {
      const asked = history.slice(0, i).reverse().find((x) => x.role === "agent");
      if (asked && covers(asked.text + "\n" + text)) return text;
    }
  }
  return null;
}

function scopeMessage(op, rawTool) {
  const tool = String(rawTool || "").replace(/^mcp__.*__/, "");
  const t = tool.toLowerCase();
  if (op === "deleteMapping") {
    return "Agents may not delete governed mappings. A mapping decides how every future record from that supplier is booked, so removing one is a reviewer's decision.";
  }
  if (/email|mail|message|slack|teams|send|post|webhook|http|share|upload/.test(t)) {
    return "\"" + tool + "\" would send data outside the governed system. Supplier spend is confidential negotiation data; agents may not contact third parties.";
  }
  if (/threshold|config|setting|policy|permission|role|tolerance/.test(t)) {
    return "\"" + tool + "\" would change a control setting. An agent may not change the controls that govern it (e.g. lowering the match threshold so its own suggestion gets through).";
  }
  return "\"" + tool + "\" is not a tool this agent is permitted to use against governed data.";
}

function numbersIn(text) {
  const out = [];
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function finding(policy, severity, message) {
  return { policy, severity, message };
}

function clip(s) {
  const t = String(s).replace(/\s+/g, " ");
  return t.length > 140 ? t.slice(0, 137) + "…" : t;
}

function fmt(v) {
  return typeof v === "number" ? String(Math.round(v * 100) / 100) : JSON.stringify(v);
}
