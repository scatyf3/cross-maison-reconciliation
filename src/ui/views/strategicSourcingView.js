// src/ui/views/strategicSourcingView.js
// Strategic Sourcing view (route "#sourcing"). Always-on client-side analysis
// of the Group Report (spend concentration, umbrella-contract candidates, tail
// spend, single-source risk), plus an OPTIONAL 'bring your own Anthropic API
// key' panel that sends the aggregated summary to Claude for a narrative
// strategy. The app works fully without a key; the key path is demo-only and
// the key lives in the browser. Exports render(container, state, handlers).

import { buildCurrentReport } from "../appController.js";
import { analyzeSourcing, sourcingPromptData } from "../../core/sourcing.js";
import { askClaude, DEFAULT_MODEL } from "../../core/llmClient.js";

export function render(container, state, handlers) {
  if (typeof document === "undefined" || !container) return;
  container.innerHTML = "";
  const section = el("section", { class: "view view-sourcing" });
  section.appendChild(el("h2", { text: "Strategic Sourcing" }));
  section.appendChild(el("p", { class: "view-caption", text: "Sourcing strategy derived from the Group Report: spend analysis, umbrella-contract leverage, and supply-risk signals." }));

  let report = null;
  try { report = buildCurrentReport(); } catch (e) { report = null; }
  if (!report || !report.rows || report.rows.length === 0) {
    section.appendChild(el("p", { class: "empty-state", text: "No consolidated data yet. Load transactions first, then return here." }));
    container.appendChild(section);
    return;
  }

  const a = analyzeSourcing(report);
  section.appendChild(buildRecommendations(a));
  section.appendChild(buildTables(a));
  section.appendChild(buildAiPanel(report));
  container.appendChild(section);
}

function buildRecommendations(a) {
  const wrap = el("div", { class: "sourcing-recs" });
  wrap.appendChild(el("h3", { text: "Recommendations" }));
  for (const r of a.recommendations) {
    const card = el("div", { class: "sourcing-rec card" });
    card.appendChild(el("p", { class: "sourcing-rec__title", text: r.title }));
    card.appendChild(el("p", { class: "sourcing-rec__detail", text: r.detail }));
    wrap.appendChild(card);
  }
  return wrap;
}

function buildTables(a) {
  const wrap = el("div", { class: "sourcing-tables" });
  // Umbrella candidates
  wrap.appendChild(el("h3", { text: "Umbrella-contract candidates (suppliers across multiple Maisons)" }));
  if (a.umbrellaCandidates.length === 0) wrap.appendChild(el("p", { class: "empty-state", text: "None identified." }));
  else wrap.appendChild(table(["Supplier", "Maisons", "Spend (EUR)", "Share %"], a.umbrellaCandidates.map((s) => [s.name, s.maisons, money(s.spendEur), s.sharePct + "%"])));
  // Concentration
  wrap.appendChild(el("h3", { text: "Spend concentration (top suppliers)" }));
  wrap.appendChild(table(["Supplier", "Spend (EUR)", "Share %", "Cumulative %"], a.topConcentration.map((s) => [s.name, money(s.spendEur), s.sharePct + "%", s.cumulativePct + "%"])));
  // Single source
  if (a.singleSource.length > 0) {
    wrap.appendChild(el("h3", { text: "Single-source categories (supply risk)" }));
    wrap.appendChild(table(["Spend Category", "Sole Supplier"], a.singleSource.map((s) => [s.spendCategory, s.lvmhSupplierId])));
  }
  return wrap;
}

function buildAiPanel(report) {
  const details = el("details", { class: "sourcing-ai" });
  details.appendChild(el("summary", { class: "sourcing-ai__summary", text: "Optional: Agentic AI Strategy Advance (Please bring your own Anthropic API key)" }));
  const body = el("div", { class: "sourcing-ai__body" });

  const note = el("p", { class: "sourcing-ai__note muted", text: "This sends only the aggregated spend summary (no raw invoice rows) directly from your browser to Anthropic. Your API key stays in this browser and is not stored or sent anywhere else. This is for demo use; for production a server-side proxy should hold the key. A ChatGPT/Claude subscription is not an API key; create one at console.anthropic.com." });
  body.appendChild(note);

  const form = el("form", { class: "sourcing-ai__form" });
  const keyField = labeled("Anthropic API key", el("input", { type: "password", class: "input-api-key", placeholder: "sk-ant-..." }));
  const modelField = labeled("Model", el("input", { type: "text", class: "input-model", value: DEFAULT_MODEL }));
  form.appendChild(keyField.wrap);
  form.appendChild(modelField.wrap);
  const btn = el("button", { type: "submit", class: "btn btn--primary btn-ask-ai", text: "Ask Claude" });
  form.appendChild(btn);
  body.appendChild(form);

  const status = el("p", { class: "sourcing-ai__status", text: "" });
  status.hidden = true;
  body.appendChild(status);
  const output = el("div", { class: "sourcing-ai__output" });
  body.appendChild(output);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = (keyField.input.value || "").trim();
    const model = (modelField.input.value || "").trim() || DEFAULT_MODEL;
    if (apiKey === "") { show(status, "Enter an Anthropic API key first.", true); return; }
    show(status, "Contacting Claude...", false);
    output.innerHTML = "";
    btn.disabled = true;
    try {
      const data = sourcingPromptData(report);
      const text = await askClaude({ apiKey, model, data });
      status.hidden = true;
      output.appendChild(renderAiText(text));
    } catch (err) {
      show(status, "AI request failed: " + (err && err.message ? err.message : String(err)), true);
    } finally {
      btn.disabled = false;
    }
  });
  details.appendChild(body);
  return details;
}

// Render the AI reply as paragraphs (plain text, no HTML injection).
function renderAiText(text) {
  const box = el("div", { class: "ai-reply" });
  for (const para of String(text || "").split(/\n{2,}/)) {
    if (para.trim() === "") continue;
    box.appendChild(el("p", { text: para.trim() }));
  }
  if (box.children.length === 0) box.appendChild(el("p", { text: "(No response text.)" }));
  return box;
}

function table(headers, rows) {
  const tw = el("div", { class: "table-wrap" });
  const t = el("table", { class: "summary-table" });
  const thead = el("thead"); const hr = el("tr");
  for (const h of headers) hr.appendChild(el("th", { text: h }));
  thead.appendChild(hr); t.appendChild(thead);
  const tb = el("tbody");
  for (const r of rows) { const tr = el("tr"); for (const c of r) tr.appendChild(el("td", { text: scalar(c) })); tb.appendChild(tr); }
  t.appendChild(tb); tw.appendChild(t); return tw;
}

function labeled(text, input) {
  const wrap = el("label", { class: "field" });
  wrap.appendChild(el("span", { class: "field-label", text }));
  wrap.appendChild(input);
  return { wrap, input };
}

function show(node, msg, isError) { node.textContent = msg; node.className = isError ? "sourcing-ai__status is-error" : "sourcing-ai__status"; node.hidden = false; }
function money(v) { const n = Number(v); if (!Number.isFinite(n)) return "-"; return "EUR " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function scalar(v) { if (v === undefined || v === null || v === "") return "-"; return String(v); }

function el(tag, attrs) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value);
  }
  return node;
}
