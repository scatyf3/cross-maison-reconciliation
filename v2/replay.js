// v2/replay.js — replay a recorded agent trace through the governance
// gateway, in the agent panel. The reviewer's data is set aside on start and
// restored exactly on exit; the replay runs on fresh seed data.

import * as controller from "../src/ui/appController.js";
import { snapshotAll, restoreAll } from "../src/store/browserStore.js";
import { parseTrace } from "../src/core/agentTrace.js";
import { createReplayEngine } from "../src/ui/replay/replayEngine.js";
import { h, clear, toast } from "./dom.js";
import { emit, shell, fetchText, runSql } from "./bus.js";
import { renderOutcome, renderReport, focusOutcome } from "./feed.js";

const LIBRARY = [
  "seed/traces/01_governed_agent.json",
  "seed/traces/02_guessed_mapping.json",
  "seed/traces/03_forced_queue_clearing.json",
  "seed/traces/04_unverified_numbers.json",
  "seed/traces/05_out_of_scope.json",
];
const SPEEDS = [0.5, 1, 2, 4];

let root = null;
let s = null; // session
let library = null; // [{ path, text, meta, error }]

export function mountReplay(container) {
  root = container;
  document.addEventListener("keydown", onKeys);
  renderPicker();
}

export function isReplaying() {
  return !!s;
}

// ---------------------------------------------------------------------------
// Picker.
// ---------------------------------------------------------------------------

async function loadLibrary() {
  if (library) return library;
  library = await Promise.all(LIBRARY.map(async (path) => {
    try {
      const text = await fetchText(path);
      return { path, text, meta: parseTrace(text).meta };
    } catch (err) {
      return { path, text: null, meta: {}, error: err.message };
    }
  }));
  return library;
}

async function renderPicker() {
  clear(root).append(h("p.muted.pad", "Loading traces…"));
  const lib = await loadLibrary();
  let enforce = true;
  let pending = null;

  const preview = h("p.picker__preview", { "aria-live": "polite" });
  const startBtn = h("button.btn.btn--primary.btn--block", { type: "button", disabled: true }, "Start replay");

  const choose = (text, name, card) => {
    for (const c of list.querySelectorAll(".trace")) c.classList.toggle("is-selected", c === card);
    pending = null;
    startBtn.disabled = true;
    preview.className = "picker__preview";
    try {
      const { steps, warnings, format } = parseTrace(text);
      const n = (k) => steps.filter((x) => x.kind === k).length;
      preview.textContent = steps.length + " steps: " + n("action") + " tool calls, " + n("narration") + " messages"
        + (n("unsupported") ? ", " + n("unsupported") + " calls to tools outside the app" : "") + (n("setup") ? ", " + n("setup") + " reviewer loads" : "") + " · " + format;
      const extra = warnings.filter((w) => !/no app mapping/.test(w));
      if (extra.length) { preview.textContent += " · " + extra.join(" "); preview.classList.add("is-warn"); }
      pending = { text, name };
      startBtn.disabled = steps.length === 0;
    } catch (err) {
      preview.textContent = err.message;
      preview.classList.add("is-error");
    }
  };

  const list = h("div.traces");
  for (const t of lib) {
    const good = /^✓/.test(t.meta.title || "");
    const card = h("button.trace", { type: "button", disabled: !t.text, "data-good": good ? "yes" : "no" },
      h("span.trace__title", (t.meta.title || t.path.split("/").pop()).replace(/^[✓✗]\s*/, "")),
      h("span.trace__tag", good ? "governed" : "misbehaving"),
      h("span.trace__desc", t.error ? "Could not load: " + t.error : shorten(t.meta.description || "", 190)));
    card.addEventListener("click", () => choose(t.text, t.meta.title || t.path, card));
    list.append(card);
  }

  const file = h("input", { type: "file", accept: ".json,.jsonl,.ndjson,.txt,application/json" });
  file.addEventListener("change", async () => { const f = file.files && file.files[0]; if (f) choose(await f.text(), f.name, null); });
  const paste = h("textarea.input.is-mono", { rows: "4", placeholder: "…or paste trace JSON / JSONL", spellcheck: "false" });
  paste.addEventListener("input", () => choose(paste.value, "pasted trace", null));

  const mode = h("div.seg", { role: "radiogroup", "aria-label": "Governance mode" });
  const setMode = (v) => { enforce = v; for (const b of mode.children) b.setAttribute("aria-checked", String((b.dataset.v === "enforce") === v)); };
  mode.append(
    h("button.seg__btn", { type: "button", role: "radio", "data-v": "enforce", onclick: () => setMode(true) }, h("strong", "Enforce"), h("span", "violations are blocked")),
    h("button.seg__btn", { type: "button", role: "radio", "data-v": "observe", onclick: () => setMode(false) }, h("strong", "Observe"), h("span", "everything runs; shows the damage")));
  setMode(true);

  startBtn.addEventListener("click", () => { if (pending) start(pending.text, pending.name, enforce); });

  clear(root).append(h("div.picker",
    h("p.picker__lead", "Replay a recorded agent session step by step. Each tool call passes the agent policy before it touches the data, then runs through the real app. Your data is set aside and restored when you exit."),
    list,
    h("details.more", h("summary", "Your own trace"), h("p.muted", "Anthropic Messages JSON, or Claude Code / Agent SDK JSONL."), file, paste),
    h("h3.picker__h", "Governance mode"), mode,
    preview, startBtn));
}

// ---------------------------------------------------------------------------
// Session.
// ---------------------------------------------------------------------------

async function start(text, name, enforce) {
  const parsed = parseTrace(text);
  s = {
    parsed,
    title: (parsed.meta.title || name || "trace").replace(/^[✓✗]\s*/, ""),
    enforce,
    engine: null,
    snapshot: snapshotAll(),
    playing: false,
    token: 0,
    speed: 1,
    chain: Promise.resolve(),
  };
  s.engine = makeEngine();
  shell.replaying = true;
  emit("mode", { replaying: true });
  buildSession();
  await serial(async () => { await s.engine.seek(0); });
  emit("changed");
  emit("show", { table: "exception_queue" });
  renderFeed();
}

function makeEngine() {
  return createReplayEngine({
    steps: s.parsed.steps,
    ops: controller,
    reset: controller.resetToSeed,
    getState: controller.getState,
    enforce: s.enforce,
    actor: s.parsed.meta.agent || "agent",
    sql: runSql,
    fetchText,
  });
}

export async function exitReplay() {
  if (!s) return;
  const snap = s.snapshot;
  s.token += 1;
  s = null;
  restoreAll(snap);
  controller.reloadStateFromStore();
  shell.replaying = false;
  emit("mode", { replaying: false });
  emit("changed");
  emit("show", { table: "exception_queue" });
  renderPicker();
  toast("Replay closed. Your data is restored.");
}

function serial(fn) {
  const run = s.chain.then(fn, fn);
  s.chain = run.catch(() => {});
  return run;
}

let ui = null;

function buildSession() {
  const btn = (label, title, onclick) => h("button.ctrl", { type: "button", title, "aria-label": title, onclick }, label);
  ui = {};
  ui.play = btn("▶", "Play (space)", () => (s.playing ? pause() : play()));
  ui.speed = h("button.ctrl.ctrl--text", { type: "button", title: "Playback speed", onclick: () => { s.speed = SPEEDS[(SPEEDS.indexOf(s.speed) + 1) % SPEEDS.length]; ui.speed.textContent = s.speed + "×"; } }, "1×");
  ui.counter = h("span.counter");
  ui.track = h("div.track", { role: "group", "aria-label": "Steps" });
  ui.feed = h("div.feed", { "aria-live": "polite" });
  ui.mode = h("button.mode-pill", { type: "button", title: "Switch mode and replay from the start", onclick: toggleMode });

  clear(root).append(h("div.session",
    h("div.session__head",
      h("div.session__title", h("span.session__name", s.title), ui.mode),
      h("button.btn.btn--small", { type: "button", onclick: exitReplay }, "Exit replay")),
    h("div.controls",
      btn("⏮", "Restart", () => jumpTo(0)),
      btn("◀", "Previous step (←)", prev),
      ui.play,
      btn("▶|", "Next step (→)", next),
      btn("⏭", "Run to end", () => jumpTo(s.engine.steps.length)),
      ui.speed, ui.counter),
    ui.track,
    ui.feed));
  updateMode();
}

function updateMode() {
  ui.mode.dataset.mode = s.enforce ? "enforce" : "observe";
  ui.mode.textContent = s.enforce ? "Enforce" : "Observe";
}

async function toggleMode() {
  pause();
  s.enforce = !s.enforce;
  s.engine = makeEngine();
  updateMode();
  await jumpTo(0);
  toast("Replaying in " + (s.enforce ? "Enforce" : "Observe") + " mode from the start.");
}

function renderFeed() {
  if (!s) return;
  const e = s.engine;
  const done = e.outcomes.slice(0, e.position).filter(Boolean);
  clear(ui.feed);
  if (s.parsed.meta.description) ui.feed.append(h("div.sysline.sysline--intro", s.parsed.meta.description));
  done.forEach((o, i) => ui.feed.append(renderOutcome(o, { active: i === done.length - 1 })));
  if (e.done) ui.feed.append(renderReport(e.governanceReport(), (i) => jumpTo(i + 1)));
  else if (done.length === 0) ui.feed.append(h("p.muted.pad", "Press ▶ to play, or step through with →."));
  renderTrack();
  const last = ui.feed.lastElementChild;
  if (last) last.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderTrack() {
  const e = s.engine;
  clear(ui.track);
  e.steps.forEach((step, i) => {
    const o = e.outcomes[i];
    const gov = o ? (o.status === "blocked" ? "blocked" : o.governance || o.status) : "pending";
    ui.track.append(h("button.tick", {
      type: "button",
      "data-kind": step.kind,
      "data-gov": i < e.position ? gov : "pending",
      class: i === e.position - 1 ? "is-current" : "",
      title: "Step " + (i + 1) + ": " + (step.kind === "narration" ? step.role : step.tool || step.kind),
      onclick: () => jumpTo(i + 1),
    }));
  });
  ui.counter.textContent = e.position + " / " + e.steps.length;
  ui.play.textContent = s.playing ? "⏸" : "▶";
}

/** Play one step: beat 1 shows the target, beat 2 commits and shows the effect. */
async function stepOnce(animate) {
  return serial(async () => {
    if (!s || s.engine.done) return null;
    const token = s.token;
    const plan = await s.engine.prepare();
    if (!plan) return null;
    if (animate && plan.focusBefore && plan.focusBefore.length) {
      const table = { "#exceptions": "exception_queue", "#mappings": "mapping_table" }[plan.beforeRoute];
      if (table) emit("show", { table, focus: plan.focusBefore.map((f) => ({ id: f.id, tone: plan.blocked ? "blocked" : "focus" })) });
      await wait(650 / s.speed);
      if (!s || s.token !== token) return null;
    }
    const o = await s.engine.commit(plan);
    if (!s || s.token !== token) return null;
    emit("changed");
    if (o.step.kind !== "narration" && o.step.kind !== "setup") focusOutcome(o);
    renderFeed();
    return o;
  });
}

async function play() {
  if (!s) return;
  if (s.engine.done) await jumpTo(0);
  s.playing = true;
  const token = ++s.token;
  renderTrack();
  while (s && s.playing && s.token === token && !s.engine.done) {
    const o = await stepOnce(true);
    if (!o || !s || s.token !== token) break;
    await wait(dwell(o) / s.speed);
  }
  if (s && s.token === token) { s.playing = false; renderTrack(); }
}

function dwell(o) {
  if (o.step.kind === "narration") return o.step.role === "thinking" ? 500 : 900 + Math.min(1600, o.step.text.length * 12);
  if (o.status === "blocked" || o.governance === "flagged" || o.governance === "would-block") return 2600;
  return 1400;
}

function pause() {
  if (!s) return;
  s.playing = false;
  s.token += 1;
  renderTrack();
}

async function next() {
  if (!s) return;
  pause();
  await stepOnce(false);
}

async function prev() {
  if (!s) return;
  await jumpTo(Math.max(0, s.engine.position - 1));
}

async function jumpTo(index) {
  if (!s) return;
  pause();
  await serial(async () => {
    await s.engine.seek(index);
  });
  emit("changed");
  const last = s.engine.outcomes[s.engine.position - 1];
  if (last && last.step.kind !== "narration") focusOutcome(last);
  renderFeed();
}

function onKeys(e) {
  if (!s || !root || root.hidden || root.closest("[hidden]")) return;
  if (e.target.closest("input, textarea, select, [contenteditable]")) return;
  if (e.key === " ") { e.preventDefault(); s.playing ? pause() : play(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shorten(t, n) {
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
}
