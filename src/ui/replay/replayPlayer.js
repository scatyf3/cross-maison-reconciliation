// src/ui/replay/replayPlayer.js
//
// Governed trace replay: the browser half of the replay feature.
//
//   openTraceDialog() ... pick a trace (bundled governance examples, a file, or
//                         a paste) and a governance mode.
//   startReplay() ....... set the reviewer's data aside (snapshotAll), put the
//                         app on clean seed state, and show the player bar.
//   exitReplay() ........ restore the reviewer's data exactly (restoreAll).
//
// Each step plays in two beats so the viewer can follow the interaction:
//   1. go to the view the agent is about to act on and outline its targets;
//   2. pass the call through the agent policy. If it is blocked, mark the
//      targets red and stop there: nothing reaches the data. Otherwise run it
//      through the real controller, move to where the effect lands, mark what
//      changed, and show the deltas and any detective findings.
// At the end (or any time) a governance report sums up what was executed,
// blocked, refused by the app, and flagged, with links back to each step.
//
// Main-content clicks are disabled while replaying so manual actions cannot
// desync the replay; the nav still works. All trace content is rendered with
// textContent (never innerHTML).

import * as controller from "../appController.js";
import { snapshotAll, restoreAll } from "../../store/browserStore.js";
import { parseTrace } from "../../core/agentTrace.js";
import { POLICIES } from "../../core/agentPolicy.js";
import { createReplayEngine } from "./replayEngine.js";
import { createSqlRunner, loadSqlJsFromCdn } from "./sqlRunner.js";

let sqlRunnerPromise = null;
/** The agent's SQL runs in SQLite, loaded from the CDN on first use. */
async function runSql(state, query) {
  if (!sqlRunnerPromise) sqlRunnerPromise = loadSqlJsFromCdn().then(createSqlRunner).catch((err) => { sqlRunnerPromise = null; throw err; });
  return (await sqlRunnerPromise).run(state, query);
}

const LIBRARY = [
  "seed/traces/01_governed_agent.json",
  "seed/traces/02_guessed_mapping.json",
  "seed/traces/03_forced_queue_clearing.json",
  "seed/traces/04_unverified_numbers.json",
  "seed/traces/05_out_of_scope.json",
];
const SPEEDS = [0.5, 1, 2, 4];

let session = null;

// ---------------------------------------------------------------------------
// Dialog.
// ---------------------------------------------------------------------------

export function openTraceDialog() {
  if (typeof document === "undefined") return;
  if (document.querySelector(".replay-dialog")) return;

  const overlay = el("div", { class: "replay-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "replay-dialog-title" });
  const box = el("div", { class: "replay-dialog__box" });
  overlay.appendChild(box);

  box.appendChild(el("h2", { id: "replay-dialog-title", class: "replay-dialog__title", text: "Replay an agent trace through governance" }));
  box.appendChild(el("p", { class: "replay-dialog__lead", text:
    "Each tool call the agent made is passed through the agent policy before it touches the governed data, then run through the real app. "
    + "The replay starts from clean seed data. Your current data is set aside and restored when you exit." }));

  let pending = null; // { text, name }
  const preview = el("p", { class: "replay-dialog__preview", "aria-live": "polite" });

  // Bundled examples.
  box.appendChild(el("h3", { class: "replay-dialog__h", text: "Governance examples" }));
  const lib = el("div", { class: "replay-lib", role: "radiogroup", "aria-label": "Bundled traces" });
  box.appendChild(lib);

  // Own trace.
  const own = el("details", { class: "replay-dialog__own" });
  own.appendChild(el("summary", { text: "Or replay your own trace" }));
  own.appendChild(el("p", { class: "muted replay-dialog__formats", text: "Anthropic Messages JSON (an array, or { messages: [...] }) or Claude Code / Agent SDK JSONL." }));
  const fileInput = el("input", { type: "file", accept: ".json,.jsonl,.ndjson,.txt,application/json", class: "replay-dialog__file" });
  own.appendChild(labeled("Trace file", fileInput));
  const textarea = el("textarea", { class: "replay-dialog__paste", rows: "5", placeholder: "…or paste the trace JSON / JSONL here", spellcheck: "false" });
  own.appendChild(labeled("Paste", textarea));
  box.appendChild(own);

  for (const path of LIBRARY) {
    const card = el("button", { type: "button", class: "replay-lib__item", role: "radio", "aria-checked": "false" });
    const name = path.split("/").pop();
    card.appendChild(el("span", { class: "replay-lib__title", text: name }));
    card.appendChild(el("span", { class: "replay-lib__desc muted", text: "Loading…" }));
    lib.appendChild(card);
    let text = null;
    fetch(path, { cache: "no-cache" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status + " " + r.statusText))))
      .then((t) => {
        text = t;
        const { meta } = parseTrace(t);
        card.firstChild.textContent = meta.title || name;
        card.lastChild.textContent = meta.description || "";
        card.classList.toggle("is-bad", /^✗/.test(meta.title || ""));
      })
      .catch((err) => { card.lastChild.textContent = "Could not load: " + err.message; card.disabled = true; });
    card.addEventListener("click", () => {
      if (!text) return;
      deselect();
      card.classList.add("is-selected");
      card.setAttribute("aria-checked", "true");
      fileInput.value = "";
      textarea.value = "";
      check(text, name);
    });
  }

  // Mode.
  const modeWrap = el("fieldset", { class: "replay-mode" });
  modeWrap.appendChild(el("legend", { text: "Governance mode" }));
  const enforceRadio = radio("replay-mode", "enforce", true, "Enforce", "violations are blocked before they reach the data");
  const observeRadio = radio("replay-mode", "observe", false, "Observe", "everything runs; shows what would happen with no governance");
  modeWrap.appendChild(enforceRadio.wrap);
  modeWrap.appendChild(observeRadio.wrap);
  box.appendChild(modeWrap);

  box.appendChild(preview);

  const actions = el("div", { class: "replay-dialog__actions" });
  const cancelBtn = el("button", { type: "button", class: "btn", text: "Cancel" });
  const startBtn = el("button", { type: "button", class: "btn btn--primary", text: "Start replay" });
  startBtn.disabled = true;
  actions.appendChild(el("span", { class: "replay-dialog__spacer" }));
  actions.appendChild(cancelBtn);
  actions.appendChild(startBtn);
  box.appendChild(actions);

  function deselect() {
    for (const c of lib.children) { c.classList.remove("is-selected"); c.setAttribute("aria-checked", "false"); }
  }

  function check(text, name) {
    pending = null;
    startBtn.disabled = true;
    preview.className = "replay-dialog__preview";
    if (!text || !text.trim()) { preview.textContent = ""; return; }
    try {
      const { format, steps, warnings } = parseTrace(text);
      const n = (k) => steps.filter((s) => s.kind === k).length;
      preview.textContent = name + ": " + steps.length + " steps (" + (n("setup") ? n("setup") + " reviewer loads, " : "") + n("action") + " agent tool calls, " + n("observe") + " reads, "
        + n("narration") + " messages" + (n("unsupported") ? ", " + n("unsupported") + " calls to tools outside the app" : "") + "), " + format + ".";
      const extra = warnings.filter((w) => !/no app mapping/.test(w));
      if (extra.length) { preview.textContent += " " + extra.join(" "); preview.className = "replay-dialog__preview is-warning"; }
      pending = { text, name };
      startBtn.disabled = steps.length === 0;
    } catch (err) {
      preview.textContent = err && err.message ? err.message : String(err);
      preview.className = "replay-dialog__preview is-error";
    }
  }

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    textarea.value = "";
    deselect();
    check(await f.text(), f.name);
  });
  textarea.addEventListener("input", () => { fileInput.value = ""; deselect(); check(textarea.value, "pasted trace"); });

  const close = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  startBtn.addEventListener("click", async () => {
    if (!pending) return;
    const { text, name } = pending;
    const enforce = enforceRadio.input.checked;
    close();
    await startReplay(text, name, { enforce });
  });

  document.body.appendChild(overlay);
  const first = lib.querySelector("button");
  if (first) first.focus();
}

// ---------------------------------------------------------------------------
// Session lifecycle.
// ---------------------------------------------------------------------------

export async function startReplay(text, sourceName, { enforce = true } = {}) {
  if (session) await exitReplay();
  const parsed = parseTrace(text);

  session = {
    parsed,
    engine: null,
    snapshot: snapshotAll(),
    prevHash: controller.getState().currentRoute || "#load",
    playing: false,
    token: 0,
    speed: 1,
    chain: Promise.resolve(),
    sourceName: parsed.meta.title || sourceName || "trace",
    enforce,
  };
  session.engine = makeEngine(enforce);
  document.body.classList.add("is-replaying");
  buildBar();
  await session.engine.seek(0);
  await navigate("#load");
  renderIntro();
  renderTimeline();
  updateControls();
}

function makeEngine(enforce) {
  return createReplayEngine({
    steps: session.parsed.steps,
    ops: controller,
    reset: controller.resetToSeed,
    getState: controller.getState,
    enforce,
    actor: session.parsed.meta.agent || "agent",
    sql: runSql,
    fetchText: async (path) => {
      const resp = await fetch(path, { cache: "no-cache" });
      if (!resp.ok) throw new Error(resp.status + " " + resp.statusText);
      return resp.text();
    },
  });
}

/** Switch Enforce <-> Observe and replay the same trace from the start. */
async function toggleMode() {
  if (!session) return;
  pause();
  session.enforce = !session.enforce;
  session.engine = makeEngine(session.enforce);
  updateModeBadge();
  await jumpTo(0, false);
}

export async function exitReplay() {
  if (!session) return;
  const s = session;
  s.token += 1;
  session = null;
  restoreAll(s.snapshot);
  controller.reloadStateFromStore();
  if (s.bar) s.bar.remove();
  document.removeEventListener("keydown", onKeys);
  document.body.classList.remove("is-replaying");
  document.body.style.removeProperty("--replay-bar-h");
  setHash(s.prevHash);
  await controller.route(s.prevHash);
}

// ---------------------------------------------------------------------------
// Playback.
// ---------------------------------------------------------------------------

// Steps and seeks mutate app state, so they run strictly one at a time: a
// second click waits for the first to finish instead of preparing the same
// step twice.
function serial(fn) {
  const s = session;
  if (!s) return Promise.resolve(null);
  const run = s.chain.then(fn, fn);
  s.chain = run.catch(() => null);
  return run;
}

function playStep(animate) {
  return serial(() => playStepNow(animate));
}

async function playStepNow(animate) {
  const s = session;
  if (!s || s.engine.done) return null;
  const token = s.token;
  const plan = await s.engine.prepare();
  if (!plan || !alive(token)) return null;

  renderStep(plan, null);
  renderTimeline(plan.index);
  if (plan.beforeRoute) {
    await navigate(plan.beforeRoute);
    if (!alive(token)) return null;
    highlight(plan.focusBefore, plan.blocked && s.engine.enforce ? "replay-blocked" : "replay-focus");
    if (animate) await wait(1300);
    if (!alive(token)) return null;
  }

  const outcome = await s.engine.commit(plan);
  if (!alive(token)) return outcome;
  if (outcome.status !== "blocked" && outcome.afterRoute && (outcome.afterRoute !== plan.beforeRoute || outcome.step.kind === "action")) {
    await navigate(outcome.afterRoute);
  }
  if (!alive(token)) return outcome;
  if (outcome.status !== "blocked") highlight(outcome.focusAfter, "replay-changed");
  renderStep(plan, outcome);
  renderTimeline();
  updateControls();
  return outcome;
}

function dwellFor(outcome) {
  if (!outcome) return 0;
  if (outcome.step.kind === "narration") {
    const n = outcome.step.text.length + outcome.findings.length * 120;
    return Math.min(8000, Math.max(1600, 900 + n * 22));
  }
  if (outcome.findings.some((f) => f.severity === "block" || f.severity === "would-block" || f.severity === "flag")) return 4200;
  return 2200;
}

async function play() {
  const s = session;
  if (!s || s.playing) return;
  if (s.engine.done) { await jumpTo(0, false); }
  s.playing = true;
  const token = ++s.token;
  updateControls();
  while (session && session.playing && alive(token) && !session.engine.done) {
    const outcome = await playStep(true);
    if (!alive(token)) return;
    if (!session.engine.done) await wait(dwellFor(outcome));
  }
  if (session && alive(token)) {
    session.playing = false;
    updateControls();
    if (session.engine.done) {
      // Let the last step be read before the report replaces it.
      await wait(3500);
      if (session && alive(token)) renderReport(true);
    }
  }
}

function pause() {
  if (!session) return;
  session.playing = false;
  session.token += 1;
  updateControls();
}

async function next() {
  pause();
  if (session.engine.done) { renderReport(true); return; }
  await playStep(false);
}

async function prev() {
  pause();
  const pos = session.engine.position;
  // Show the step before the one currently on screen.
  await jumpTo(Math.max(0, pos - 2), pos - 2 >= 0);
}

/** Rebuild state up to `index` and (optionally) play step `index` visibly. */
async function jumpTo(index, show) {
  const s = session;
  if (!s) return;
  s.token += 1;
  const token = s.token;
  setBusy(true);
  try {
    await serial(() => s.engine.seek(index));
  } finally {
    setBusy(false);
  }
  if (!alive(token)) return;
  if (show) {
    await playStep(false);
  } else {
    await navigate("#load");
    renderIntro();
    renderTimeline();
    updateControls();
  }
}

function alive(token) { return session && session.token === token; }

function wait(ms) {
  const speed = session ? session.speed : 1;
  return new Promise((r) => setTimeout(r, ms / speed));
}

async function navigate(hash) {
  setHash(hash);
  await controller.route(hash);
  await new Promise((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
}

function setHash(hash) {
  // replaceState does not fire hashchange, so the router does not render twice.
  try { history.replaceState(null, "", hash); } catch { /* file:// or sandboxed */ }
}

function highlight(focus, cls) {
  if (!Array.isArray(focus) || focus.length === 0) return;
  let first = null;
  for (const f of focus) {
    const sel = f.type === "exception" ? '[data-exception-id="' + cssEscape(f.id) + '"]'
      : f.type === "mapping" ? '[data-mapping-id="' + cssEscape(f.id) + '"]'
      : f.type === "seed" ? '.btn-load-seed[data-maison="' + cssEscape(f.id) + '"]'
      : null;
    if (!sel) continue;
    const node = document.querySelector(sel);
    if (!node) continue;
    const details = node.closest("details");
    if (details) details.open = true;
    node.classList.add(cls);
    if (!first) first = node;
  }
  if (first) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    first.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }
}

function cssEscape(v) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Player bar.
// ---------------------------------------------------------------------------

function buildBar() {
  const bar = el("section", { class: "replay-bar", "aria-label": "Agent trace replay" });

  const head = el("div", { class: "replay-bar__head" });
  const title = el("div", { class: "replay-bar__title" });
  title.appendChild(el("span", { class: "replay-bar__badge", text: "Replay" }));
  title.appendChild(el("span", { class: "replay-bar__source", text: session.sourceName }));
  const counter = el("span", { class: "replay-bar__counter" });
  title.appendChild(counter);
  head.appendChild(title);
  const headActions = el("div", { class: "replay-bar__head-actions" });
  const modeBtn = el("button", { type: "button", class: "btn replay-mode-btn" });
  modeBtn.addEventListener("click", () => toggleMode());
  const reportBtn = el("button", { type: "button", class: "btn replay-bar__report", text: "Governance report" });
  reportBtn.addEventListener("click", () => { pause(); renderReport(session.engine.done); });
  const exitBtn = el("button", { type: "button", class: "btn replay-bar__exit", text: "Exit replay" });
  exitBtn.addEventListener("click", () => exitReplay());
  headActions.appendChild(modeBtn);
  headActions.appendChild(reportBtn);
  headActions.appendChild(exitBtn);
  head.appendChild(headActions);
  bar.appendChild(head);

  const body = el("div", { class: "replay-bar__body" });
  const card = el("div", { class: "replay-step", "aria-live": "polite" });
  body.appendChild(card);
  const timelineWrap = el("details", { class: "replay-timeline" });
  timelineWrap.open = typeof window !== "undefined" && window.innerWidth > 900;
  timelineWrap.appendChild(el("summary", { text: "Timeline" }));
  const timeline = el("ol", { class: "replay-timeline__list" });
  timelineWrap.appendChild(timeline);
  body.appendChild(timelineWrap);
  bar.appendChild(body);

  const controls = el("div", { class: "replay-bar__controls" });
  const restartBtn = ctrl("⏮", "Restart from the beginning", () => { pause(); jumpTo(0, false); });
  const prevBtn = ctrl("◀", "Previous step", () => prev());
  const playBtn = el("button", { type: "button", class: "btn btn--primary replay-ctrl replay-ctrl--play" });
  playBtn.addEventListener("click", () => (session.playing ? pause() : play()));
  const nextBtn = ctrl("▶|", "Next step", () => next());
  const speedSel = el("select", { class: "replay-speed", "aria-label": "Playback speed" });
  for (const sp of SPEEDS) {
    const o = el("option", { value: String(sp), text: sp + "×" });
    if (sp === 1) o.selected = true;
    speedSel.appendChild(o);
  }
  speedSel.addEventListener("change", () => { session.speed = Number(speedSel.value) || 1; });
  controls.appendChild(restartBtn);
  controls.appendChild(prevBtn);
  controls.appendChild(playBtn);
  controls.appendChild(nextBtn);
  controls.appendChild(speedSel);
  controls.appendChild(el("span", { class: "replay-bar__hint muted", text: "Space play/pause · ← → step · views are read-only while replaying" }));
  bar.appendChild(controls);

  document.body.appendChild(bar);
  session.bar = bar;
  session.ui = { card, timeline, counter, prevBtn, nextBtn, playBtn, restartBtn, modeBtn };
  updateModeBadge();
  document.addEventListener("keydown", onKeys);
  syncBarHeight();
  if (typeof ResizeObserver === "function") new ResizeObserver(syncBarHeight).observe(bar);
}

function updateModeBadge() {
  const b = session && session.ui && session.ui.modeBtn;
  if (!b) return;
  b.textContent = session.enforce ? "🛡 Enforce · switch to Observe" : "👁 Observe · switch to Enforce";
  b.className = "btn replay-mode-btn " + (session.enforce ? "is-enforce" : "is-observe");
  b.title = session.enforce
    ? "Violations are blocked before they reach the data. Switch to see what this agent would do with no governance."
    : "Everything runs; violations are only marked. Switch to see what governance blocks.";
  session.bar.classList.toggle("is-observe", !session.enforce);
}

function syncBarHeight() {
  if (!session || !session.bar) return;
  document.body.style.setProperty("--replay-bar-h", session.bar.offsetHeight + "px");
}

function onKeys(e) {
  if (!session) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.key === " ") { e.preventDefault(); session.playing ? pause() : play(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
  else if (e.key === "Escape") { exitReplay(); }
}

function ctrl(text, label, onClick) {
  const b = el("button", { type: "button", class: "btn replay-ctrl", text, title: label, "aria-label": label });
  b.addEventListener("click", onClick);
  return b;
}

function setBusy(busy) {
  if (!session || !session.ui) return;
  session.bar.classList.toggle("is-busy", busy);
}

function updateControls() {
  if (!session || !session.ui) return;
  const { engine } = session;
  const ui = session.ui;
  const pos = engine.position;
  ui.counter.textContent = "Step " + pos + " / " + engine.steps.length;
  ui.prevBtn.disabled = pos === 0;
  ui.nextBtn.disabled = engine.done && session.ui.card.classList.contains("replay-report");
  ui.playBtn.textContent = session.playing ? "❚❚ Pause" : engine.done ? "↻ Replay again" : pos === 0 ? "▶ Play" : "▶ Resume";
}

function renderIntro() {
  const { card } = session.ui;
  card.innerHTML = "";
  card.className = "replay-step";
  const steps = session.engine.steps;
  const n = (k) => steps.filter((s) => s.kind === k).length;
  const meta = session.parsed.meta;
  if (meta.description) card.appendChild(el("p", { class: "replay-step__text", text: meta.description }));
  card.appendChild(el("p", { class: "replay-step__text muted", text:
    steps.length + " steps (" + (n("setup") ? n("setup") + " reviewer loads, " : "") + n("action") + " agent tool calls, " + n("observe") + " reads, " + n("narration") + " messages"
    + (n("unsupported") ? ", " + n("unsupported") + " calls to tools outside the app" : "") + "). "
    + (session.enforce ? "Mode: Enforce. Policy violations are blocked." : "Mode: Observe. Everything runs; violations are only marked.")
    + " Press Play, or step through with ▶|." }));
  if (!steps.some((x) => x.kind === "setup")) {
    card.appendChild(el("p", { class: "replay-step__note", text: "This trace has no setup, so nothing is loaded before the agent starts. Add a \"setup\" list (the extracts the reviewer loaded) for its queries to return data." }));
  }
}

const ROLE_LABEL = { user: "User", agent: "Agent", thinking: "Agent thinking" };
const VERDICT = {
  blocked: { cls: "is-blocked", icon: "🛡", label: "Blocked by policy" },
  "would-block": { cls: "is-would", icon: "⚠", label: "Would be blocked under Enforce" },
  flagged: { cls: "is-flagged", icon: "⚑", label: "Flagged for review" },
  rejected: { cls: "is-rejected", icon: "✗", label: "Refused by the app" },
};

function renderStep(plan, outcome) {
  const { card } = session.ui;
  const step = plan.step;
  card.innerHTML = "";
  card.className = "replay-step replay-step--" + (step.kind === "narration" ? step.role : step.kind);

  const head = el("div", { class: "replay-step__head" });
  const label = step.kind === "narration" ? ROLE_LABEL[step.role] || "Message"
    : step.kind === "setup" ? "Reviewer · before the agent session"
    : step.op === "querySql" ? "Agent queries data (SQL)"
    : step.kind === "action" ? "Tool call"
    : step.kind === "observe" ? "Agent reads data"
    : "Tool call (outside the app)";
  head.appendChild(el("span", { class: "replay-step__role", text: label }));
  head.appendChild(el("span", { class: "replay-step__index muted", text: "#" + (plan.index + 1) }));
  if (step.timestamp) head.appendChild(el("span", { class: "replay-step__time muted", text: String(step.timestamp) }));
  card.appendChild(head);

  if (step.kind === "narration") {
    for (const para of step.text.split(/\n{2,}/)) card.appendChild(el("p", { class: "replay-step__text", text: para }));
    if (outcome) appendGovernance(card, outcome);
    return;
  }

  if (step.kind === "setup") {
    card.appendChild(el("p", { class: "replay-step__text", text: (step.actor || "The reviewer") + " loads the " + (step.input.maison_id || "") + " extract" + (step.input.file ? " (" + step.input.file + ")" : "") + ". Loading data is a human step; the agent starts from what was loaded." }));
    if (outcome) card.appendChild(el("p", { class: "replay-step__status is-" + outcome.status, text: (outcome.status === "ok" ? "✓ " : "✗ ") + outcome.message }));
    const chips = outcome && deltaChips(outcome.delta);
    if (chips) card.appendChild(chips);
    return;
  }

  const isSql = step.op === "querySql";
  const call = el("p", { class: "replay-step__call" });
  call.appendChild(el("code", { text: step.tool.replace(/^mcp__.*__/, "") }));
  if (step.op && !isSql) call.appendChild(el("span", { class: "muted", text: "  →  " + step.op + "()" }));
  card.appendChild(call);
  const query = isSql ? String(step.input.query ?? step.input.sql ?? step.input.statement ?? "") : "";
  if (isSql) card.appendChild(el("pre", { class: "replay-sql", text: query }));
  const argsText = pretty(step.input);
  const args = !isSql && argsText !== "{}" ? collapsible("Arguments", argsText, !outcome) : null;

  if (!outcome) {
    card.appendChild(el("p", { class: "replay-step__status is-pending", text: "Checking policy…" }));
    if (args) card.appendChild(args);
    return;
  }

  appendGovernance(card, outcome);
  if (outcome.status !== "blocked") {
    const statusText = outcome.status === "ok" ? "✓ " + outcome.message
      : outcome.status === "error" ? "✗ " + outcome.message
      : "⤼ " + (outcome.message || "Skipped.");
    card.appendChild(el("p", { class: "replay-step__status is-" + outcome.status, text: statusText }));
  }
  for (const note of outcome.notes) card.appendChild(el("p", { class: "replay-step__note", text: note }));
  if (outcome.diverged && outcome.status !== "blocked") card.appendChild(el("p", { class: "replay-step__diverged", text: "⚠ " + outcome.diverged }));

  const chips = deltaChips(outcome.delta);
  if (chips) card.appendChild(chips);
  if (isSql && outcome.result && outcome.result.rows) card.appendChild(resultTable(outcome.result));
  if (args) card.appendChild(args);
  if (step.traceResult) {
    card.appendChild(collapsible("What the agent saw in its original run" + (step.traceResult.isError ? " (error)" : ""), prettyText(step.traceResult.text), false));
  }
}

/** Verdict banner + per-policy findings for one step. */
function appendGovernance(card, outcome) {
  const v = VERDICT[outcome.governance];
  const findings = outcome.findings.filter((f) => f.severity !== "info");
  if (v) {
    const banner = el("div", { class: "replay-verdict " + v.cls });
    banner.appendChild(el("span", { class: "replay-verdict__icon", text: v.icon }));
    banner.appendChild(el("span", { class: "replay-verdict__label", text: v.label }));
    card.appendChild(banner);
  }
  if (findings.length > 0) {
    const list = el("ul", { class: "replay-findings" });
    for (const f of findings) {
      const p = POLICIES[f.policy] || { name: f.policy };
      const li = el("li", { class: "replay-finding is-" + f.severity });
      li.appendChild(el("span", { class: "replay-finding__policy", text: f.policy + " " + p.name }));
      li.appendChild(el("span", { class: "replay-finding__msg", text: f.message }));
      list.appendChild(li);
    }
    card.appendChild(list);
  }
  for (const f of outcome.findings.filter((x) => x.severity === "info")) {
    card.appendChild(el("p", { class: "replay-step__note", text: f.policy + ": " + f.message }));
  }
}

/** The end-of-replay governance report (also opened from the bar). */
function renderReport(atEnd) {
  if (!session) return;
  const { card } = session.ui;
  const g = session.engine.governanceReport();
  card.innerHTML = "";
  card.className = "replay-step replay-report";

  const head = el("div", { class: "replay-step__head" });
  head.appendChild(el("span", { class: "replay-step__role", text: "Governance report" }));
  head.appendChild(el("span", { class: "muted", text: (g.enforce ? "Enforce" : "Observe") + " · " + g.actor + (atEnd ? "" : " · after " + g.replayed + " of " + g.total + " steps") }));
  card.appendChild(head);

  const tiles = el("div", { class: "replay-tiles" });
  const tile = (value, label, cls) => {
    const t = el("div", { class: "replay-tile " + (cls || "") });
    t.appendChild(el("span", { class: "replay-tile__value", text: String(value) }));
    t.appendChild(el("span", { class: "replay-tile__label", text: label }));
    tiles.appendChild(t);
  };
  tile(g.executed + " / " + g.actions, "agent tool calls executed");
  if (g.enforce) tile(g.blocked, "blocked by policy", g.blocked ? "is-blocked" : "");
  else tile(g.wouldBlock, "would be blocked", g.wouldBlock ? "is-would" : "");
  tile(g.rejectedByApp, "refused by the app", g.rejectedByApp ? "is-rejected" : "");
  tile(g.flagged, "steps flagged", g.flagged ? "is-flagged" : "");
  card.appendChild(tiles);

  card.appendChild(el("p", { class: "replay-report__final", text:
    "Resulting data: " + g.final.consolidated + " consolidated, " + g.final.exceptions + " in the Exception Queue, Group spend €"
    + g.final.spendEur.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "." }));

  if (g.findings.length === 0) {
    card.appendChild(el("p", { class: "replay-report__clean", text: "✓ No policy violations and no unsupported claims. Every action is attributed to " + g.actor + " in the Audit Trail." }));
  } else {
    const list = el("ul", { class: "replay-findings replay-findings--report" });
    for (const f of g.findings) {
      const p = POLICIES[f.policy] || { name: f.policy, layer: "" };
      const li = el("li", { class: "replay-finding is-" + f.severity });
      const jump = el("button", { type: "button", class: "replay-finding__jump", text: "#" + (f.index + 1) });
      jump.title = "Go to this step";
      jump.addEventListener("click", () => { pause(); jumpTo(f.index, true); });
      li.appendChild(jump);
      li.appendChild(el("span", { class: "replay-finding__policy", text: f.policy + " " + p.name + " · " + p.layer }));
      li.appendChild(el("span", { class: "replay-finding__msg", text: f.message }));
      list.appendChild(li);
    }
    card.appendChild(list);
  }

  const other = el("p", { class: "replay-report__switch" });
  const btn = el("button", { type: "button", class: "btn", text: g.enforce ? "Replay with no governance (Observe)" : "Replay with governance (Enforce)" });
  btn.addEventListener("click", () => toggleMode());
  other.appendChild(btn);
  card.appendChild(other);

  card.appendChild(collapsible("Policies", Object.values(POLICIES).map((p) => p.id + " " + p.name + " (" + p.layer + "): " + p.rule).join("\n\n"), false));
  updateControls();
}

function deltaChips(d) {
  const items = [
    ["consolidated", "Consolidated", (v) => signed(v)],
    ["exceptions", "Exceptions", (v) => signed(v)],
    ["mappings", "Mappings", (v) => signed(v)],
    ["audit", "Audit entries", (v) => signed(v)],
    ["spendEur", "Group spend", (v) => (v > 0 ? "+" : "−") + "€" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
  ].filter(([k]) => d && d[k]);
  if (items.length === 0) return null;
  const wrap = el("div", { class: "replay-deltas" });
  for (const [k, labelText, fmt] of items) {
    const chip = el("span", { class: "replay-delta " + (d[k] > 0 ? "is-up" : "is-down") });
    chip.appendChild(el("span", { class: "replay-delta__label", text: labelText }));
    chip.appendChild(el("span", { class: "replay-delta__value", text: fmt(d[k]) }));
    wrap.appendChild(chip);
  }
  return wrap;
}

function signed(v) { return (v > 0 ? "+" : "−") + Math.abs(v); }

function renderTimeline(activeIndex) {
  const { timeline } = session.ui;
  const { engine } = session;
  const active = activeIndex != null ? activeIndex : engine.position - 1;
  timeline.innerHTML = "";
  engine.steps.forEach((step, i) => {
    const o = engine.outcomes[i];
    const gov = o && o.governance ? " is-gov-" + o.governance : "";
    const li = el("li", { class: "replay-tl" + (i === active ? " is-active" : "") + (o ? " is-" + o.status + gov : " is-future") });
    const b = el("button", { type: "button", class: "replay-tl__btn" });
    b.appendChild(el("span", { class: "replay-tl__icon", text: stepIcon(step, o) }));
    b.appendChild(el("span", { class: "replay-tl__label", text: stepLabel(step) }));
    b.addEventListener("click", () => { pause(); jumpTo(i, true); });
    li.appendChild(b);
    timeline.appendChild(li);
  });
  // Scroll only the list (scrollIntoView would also scroll the bar body and
  // cut off the step card).
  const act = timeline.children[active];
  if (act && timeline.closest("details").open) {
    const top = act.offsetTop - timeline.offsetTop;
    if (top < timeline.scrollTop || top + act.offsetHeight > timeline.scrollTop + timeline.clientHeight) {
      timeline.scrollTop = Math.max(0, top - timeline.clientHeight / 2);
    }
  }
}

function stepIcon(step, o) {
  if (o && o.governance && VERDICT[o.governance]) return VERDICT[o.governance].icon;
  if (o && o.status === "error") return "✗";
  if (step.kind === "narration") return step.role === "user" ? "👤" : step.role === "thinking" ? "💭" : "🤖";
  if (step.kind === "setup") return "📥";
  if (step.op === "querySql") return "🔎";
  if (step.kind === "observe") return "👁";
  if (step.kind === "unsupported") return "⤼";
  return "⚙";
}

function stepLabel(step) {
  if (step.kind === "narration") {
    const t = step.text.replace(/\s+/g, " ");
    return (ROLE_LABEL[step.role] || "") + ": " + (t.length > 80 ? t.slice(0, 77) + "…" : t);
  }
  const args = step.input || {};
  if (step.kind === "setup") return "Reviewer loads " + (args.maison_id || "extract");
  if (step.op === "querySql") {
    const q = String(args.query ?? args.sql ?? "").replace(/\s+/g, " ");
    return "SQL: " + (q.length > 70 ? q.slice(0, 67) + "…" : q);
  }
  const hint = args.maison_id || args.maisonId || args.exception_id || args.exceptionId || args.mapping_id || "";
  return step.tool.replace(/^mcp__.*__/, "") + (hint ? " (" + hint + ")" : "");
}

// ---------------------------------------------------------------------------
// Small DOM helpers.
// ---------------------------------------------------------------------------

/** Rows the governed data returned to the agent's query. */
function resultTable({ columns, rows, truncated }) {
  const wrap = el("div", { class: "replay-sqlresult" });
  wrap.appendChild(el("p", { class: "replay-sqlresult__cap muted", text: "Governed data returned " + rows.length + " row(s)" + (truncated ? " (truncated)" : "") + ":" }));
  if (rows.length === 0) return wrap;
  const cols = columns && columns.length ? columns : Object.keys(rows[0]);
  const t = el("table", { class: "replay-sqlresult__table" });
  const hr = el("tr");
  for (const c of cols) hr.appendChild(el("th", { text: c }));
  const thead = el("thead"); thead.appendChild(hr); t.appendChild(thead);
  const tb = el("tbody");
  for (const row of rows.slice(0, 12)) {
    const tr = el("tr");
    for (const c of cols) tr.appendChild(el("td", { text: row[c] == null ? "NULL" : String(row[c]) }));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  const scroller = el("div", { class: "replay-sqlresult__scroll" });
  scroller.appendChild(t);
  wrap.appendChild(scroller);
  if (rows.length > 12) wrap.appendChild(el("p", { class: "muted replay-sqlresult__cap", text: "+" + (rows.length - 12) + " more" }));
  return wrap;
}

function collapsible(summary, text, open) {
  const d = el("details", { class: "replay-step__details" });
  if (open) d.open = true;
  d.appendChild(el("summary", { text: summary }));
  d.appendChild(el("pre", { class: "replay-step__pre", text: text.length > 6000 ? text.slice(0, 6000) + "\n…(truncated)" : text }));
  return d;
}

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function prettyText(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text); }
}

function labeled(text, input) {
  const wrap = el("label", { class: "field replay-dialog__field" });
  wrap.appendChild(el("span", { class: "field-label", text }));
  wrap.appendChild(input);
  return wrap;
}

function radio(name, value, checked, label, hint) {
  const wrap = el("label", { class: "replay-mode__opt" });
  const input = el("input", { type: "radio", name, value });
  input.checked = checked;
  wrap.appendChild(input);
  const txt = el("span");
  txt.appendChild(el("strong", { text: label }));
  txt.appendChild(el("span", { class: "muted", text: ": " + hint }));
  wrap.appendChild(txt);
  return { wrap, input };
}

function el(tag, attrs) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  return node;
}
