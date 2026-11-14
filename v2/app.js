// v2/app.js — boot the shared controller, then mount the data workspace and
// the agent panel. The controller, store, pipeline, policy and replay engine
// are the same modules v1 uses; only the UI differs.

import * as controller from "../src/ui/appController.js";
import { mountData } from "./data.js";
import { mountLive } from "./live.js";
import { mountReplay, isReplaying, exitReplay } from "./replay.js";
import { emit, on } from "./bus.js";
import { toast } from "./dom.js";

async function main() {
  const root = document.getElementById("v2");
  try {
    await controller.boot();
  } catch (err) {
    toast("Could not start: " + ((err && err.message) || err), "error");
    return;
  }

  mountData(root);
  mountLive(document.getElementById("agent-live"));
  mountReplay(document.getElementById("agent-replay"));
  wireTabs();
  wireMobile();
  wireTop();
}

function wireTabs() {
  const tabs = { live: document.getElementById("tab-live"), replay: document.getElementById("tab-replay") };
  const panes = { live: document.getElementById("agent-live"), replay: document.getElementById("agent-replay") };
  const select = (name) => {
    for (const k of Object.keys(tabs)) {
      tabs[k].setAttribute("aria-selected", String(k === name));
      panes[k].hidden = k !== name;
    }
  };
  tabs.live.addEventListener("click", () => select("live"));
  tabs.replay.addEventListener("click", () => select("replay"));
  on("ask", () => { select("live"); showPanel("agent"); });
  on("mode", ({ replaying } = {}) => { tabs.replay.dataset.live = replaying ? "yes" : ""; });
}

function showPanel(name) {
  document.body.dataset.panel = name;
  for (const b of document.querySelectorAll(".mobile-tabs button")) b.setAttribute("aria-current", String(b.dataset.panel === name));
}

function wireMobile() {
  showPanel("work");
  for (const b of document.querySelectorAll(".mobile-tabs button")) b.addEventListener("click", () => showPanel(b.dataset.panel));
  on("select", () => showPanel("work"));
}

function wireTop() {
  document.getElementById("export-btn").addEventListener("click", () => {
    const res = controller.exportReport();
    toast(res.downloaded ? "Group report downloaded." : "Export prepared, but the download was blocked.", res.downloaded ? "ok" : "warn");
  });

  // Two-step confirm instead of a modal dialog.
  const reset = document.getElementById("reset-btn");
  let armed = null;
  reset.addEventListener("click", async () => {
    if (!armed) {
      reset.textContent = "Click to confirm";
      reset.classList.add("is-armed");
      armed = setTimeout(() => { armed = null; reset.textContent = "Reset"; reset.classList.remove("is-armed"); }, 3500);
      return;
    }
    clearTimeout(armed);
    armed = null;
    reset.textContent = "Reset";
    reset.classList.remove("is-armed");
    if (isReplaying()) await exitReplay();
    await controller.resetToSeed({ preload: true });
    emit("changed");
    emit("show", { table: "exception_queue" });
    toast("Reset to the seeded sample data.");
  });
}

main();
