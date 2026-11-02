// src/ui/views/loadExtractsView.js
// Load Extracts view (route "#load"). Single upload panel, auto format detect.
// Exports render(container, state, handlers). Req 17.2.

let lastLoad = null;

function looksLikeFinanceExport(csvText) {
  const first = String(csvText || "").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  return ["Maison", "Supplier Local ID", "Global Supplier ID", "PO Status", "RPA First Pass"]
    .every((n) => first.includes(n));
}

export function render(container, state, handlers) {
  if (typeof document === "undefined" || !container) return;
  container.innerHTML = "";
  const section = el("section", { class: "view view-load" });
  section.appendChild(el("h2", { text: "Load Extracts" }));
  section.appendChild(el("p", { class: "view-intro", text: "Upload a transactions CSV. The format is detected automatically." }));

  const panel = el("div", { class: "upload-panel card" });
  const form = el("form", { class: "upload-form" });
  let pendingCsv = "";

  const dropzone = el("div", { class: "dropzone" });
  dropzone.setAttribute("tabindex", "0");
  dropzone.setAttribute("role", "button");
  dropzone.setAttribute("aria-label", "Upload a CSV file: click to browse or drop a file here");
  dropzone.appendChild(el("div", { class: "dropzone__icon", text: "\u2191" }));
  const dzText = el("p", { class: "dropzone__text", text: "Drag & drop a CSV file here, or click to browse" });
  const dzFile = el("p", { class: "dropzone__file muted", text: "" });
  dzFile.hidden = true;
  dropzone.appendChild(dzText);
  dropzone.appendChild(dzFile);
  const fileInput = el("input", { type: "file", class: "input-file-hidden", accept: ".csv,text/csv,text/plain" });
  fileInput.style.display = "none";
  dropzone.appendChild(fileInput);
  form.appendChild(dropzone);

  const loadBtn = el("button", { type: "submit", class: "btn btn--primary btn-load", text: "Load file" });
  loadBtn.disabled = true;
  form.appendChild(loadBtn);
  const error = el("p", { class: "form-error", text: "" });
  error.hidden = true;
  form.appendChild(error);

  const readFile = (file) => {
    if (!file || typeof FileReader === "undefined") return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingCsv = typeof reader.result === "string" ? reader.result : "";
      dzFile.textContent = "Selected: " + file.name;
      dzFile.hidden = false;
      dzText.textContent = "Drop another file to replace, or click to browse";
      loadBtn.disabled = pendingCsv.trim() === "";
      error.hidden = true;
    };
    reader.readAsText(file);
  };

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", () => { const f = fileInput.files && fileInput.files[0]; if (f) readFile(f); });
  ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add("is-dragover"); }));
  ["dragleave", "dragend"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove("is-dragover"); }));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove("is-dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pendingCsv.trim() === "") { showError(error, "Drop or choose a CSV file before loading."); return; }
    error.hidden = true;
    dispatchLoad(handlers, pendingCsv, section);
  });
  panel.appendChild(form);
  section.appendChild(panel);

  const seedMeta = Array.isArray(state && state.seedExtractMeta) ? state.seedExtractMeta : [];
  const seedExtracts = state && state.seedExtracts && typeof state.seedExtracts === "object" ? state.seedExtracts : {};
  if (seedMeta.length > 0) {
    const sample = el("details", { class: "sample-data" });
    sample.appendChild(el("summary", { text: "No file handy? Try the built-in sample data" }));
    const list = el("div", { class: "sample-buttons" });
    for (const meta of seedMeta) {
      if (!meta || !meta.id) continue;
      const csvText = seedExtracts[meta.id];
      const btn = el("button", { type: "button", class: "btn btn-load-seed", text: "Load " + (meta.label || meta.id) });
      btn.disabled = !(typeof csvText === "string" && csvText.length > 0);
      btn.addEventListener("click", () => { runNineColumn(handlers, meta.id, csvText, section); });
      list.appendChild(btn);
    }
    sample.appendChild(list);
    section.appendChild(sample);
  }

  if (lastLoad && lastLoad.result) section.appendChild(buildSummary(lastLoad.title, lastLoad.result));
  container.appendChild(section);
}

function dispatchLoad(handlers, csvText, section) {
  if (looksLikeFinanceExport(csvText)) {
    if (!handlers || typeof handlers.loadFinanceExtract !== "function") return;
    let result;
    try { result = handlers.loadFinanceExtract(csvText); }
    catch (err) { result = { ok: false, error: err && err.message ? err.message : String(err) }; }
    if (result && result.ok) {
      lastLoad = { title: "Finance export: " + (result.maisons || []).length + " Maison(s)", result: {
        consolidatedAdded: result.consolidatedAdded, exceptionsAdded: result.exceptionsAdded,
        parseErrors: result.parseErrors || [], runId: result.mappingEntriesImported + " mappings imported" } };
      refreshSummary(section);
    } else {
      const err = section.querySelector(".form-error");
      if (err) showError(err, (result && result.error) || "Finance load failed.");
    }
    return;
  }
  runNineColumn(handlers, "IMPORT", csvText, section);
}

function runNineColumn(handlers, maisonId, csvText, section) {
  if (!handlers || typeof handlers.loadExtract !== "function") return;
  let result;
  try { result = handlers.loadExtract(maisonId, csvText); }
  catch (err) { result = { error: err && err.message ? err.message : String(err) }; }
  lastLoad = { title: maisonId, result };
  refreshSummary(section);
}

function refreshSummary(section) {
  if (!section || !section.isConnected || !lastLoad) return;
  const existing = section.querySelector(".load-summary");
  const summary = buildSummary(lastLoad.title, lastLoad.result);
  if (existing) existing.replaceWith(summary); else section.appendChild(summary);
}

function buildSummary(title, result) {
  const box = el("div", { class: "load-summary card" });
  box.appendChild(el("h3", { text: "Last load" }));
  if (result && result.error) {
    const errP = el("p", { class: "summary-error" });
    errP.appendChild(el("strong", { text: "Load failed: " }));
    errP.appendChild(document.createTextNode(String(result.error)));
    box.appendChild(errP);
    return box;
  }
  const parseErrors = Array.isArray(result && result.parseErrors) ? result.parseErrors : [];
  const dl = el("dl", { class: "summary-stats" });
  appendStat(dl, "Source", title);
  if (result && result.runId != null) appendStat(dl, "Detail", String(result.runId));
  appendStat(dl, "Records consolidated", String((result && result.consolidatedAdded) || 0));
  appendStat(dl, "Exceptions added", String((result && result.exceptionsAdded) || 0));
  appendStat(dl, "Parse errors", String(parseErrors.length));
  box.appendChild(dl);
  box.appendChild(el("p", { class: "summary-next muted", text: "Next: review flagged records in the Exception Queue, then see the Group Report." }));
  if (parseErrors.length > 0) {
    const errList = el("ul", { class: "parse-errors" });
    for (const pe of parseErrors) {
      const rowNum = pe && (pe.rowNumber != null ? pe.rowNumber : (pe.row != null ? pe.row : pe.line));
      const reason = pe && (pe.reason || pe.message || "");
      errList.appendChild(el("li", { text: (rowNum != null ? "Row " + rowNum + ": " : "") + String(reason) }));
    }
    box.appendChild(errList);
  }
  return box;
}

function appendStat(dl, term, value) {
  dl.appendChild(el("dt", { text: term }));
  dl.appendChild(el("dd", { text: value }));
}

function showError(node, message) { node.textContent = message; node.hidden = false; }

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

export function resetLastLoad() { lastLoad = null; }