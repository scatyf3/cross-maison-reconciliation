// src/ui/views/mappingTableView.js
// Mapping Table view (route "#mappings"). The authoritative, governed list of
// approved Maison->LVMH mappings. The reviewer can manually ADD a mapping and
// DELETE any row; both actions are audited by the controller. Req 5.5, 17.2.

const COLUMNS = [
  { key: "maisonId", label: "Maison" },
  { key: "localSupplierCode", label: "Local Supplier" },
  { key: "localAccountCode", label: "Local Account" },
  { key: "lvmhSupplierId", label: "LVMH Supplier ID" },
  { key: "lvmhAccountCode", label: "LVMH Account Code" },
  { key: "status", label: "Status" },
  { key: "origin", label: "Origin" },
  { key: "approvedBy", label: "Approved By" },
];

export function render(container, state, handlers) {
  if (typeof document === "undefined" || !container) return;
  const mappingTable = Array.isArray(state && state.mappingTable) ? state.mappingTable : [];
  container.innerHTML = "";

  const section = el("section", { class: "view view-mappings" });
  section.appendChild(el("h2", { text: "Mapping Table" }));
  section.appendChild(el("p", { class: "view-caption", text: "This is the governed standard of approved Maison-to-LVMH supplier mappings. Records that match an approved mapping are normalized automatically. You can add a new mapping or delete an existing one below, and every change is saved to the change history." }));

  section.appendChild(buildAddForm(handlers));

  if (mappingTable.length === 0) {
    section.appendChild(el("p", { class: "empty-state", text: "No mappings yet. Add one above, or approve an unknown-supplier exception." }));
    section.appendChild(buildHistory(state));
    container.appendChild(section);
    return;
  }
  section.appendChild(buildTable(mappingTable, handlers));
  section.appendChild(buildHistory(state));
  container.appendChild(section);
}

function buildAddForm(handlers) {
  const wrap = el("div", { class: "mapping-add card" });
  wrap.appendChild(el("h3", { text: "Add a mapping" }));
  const form = el("form", { class: "mapping-add__form" });
  const fields = [
    { key: "maisonId", label: "Maison" },
    { key: "localSupplierCode", label: "Local supplier" },
    { key: "localAccountCode", label: "Local account" },
    { key: "lvmhSupplierId", label: "LVMH supplier id" },
    { key: "lvmhAccountCode", label: "LVMH account code" },
  ];
  const inputs = {};
  for (const fdef of fields) {
    const field = el("label", { class: "field" });
    field.appendChild(el("span", { class: "field-label", text: fdef.label }));
    const input = el("input", { type: "text", class: "input-" + fdef.key });
    field.appendChild(input);
    inputs[fdef.key] = input;
    form.appendChild(field);
  }
  const btn = el("button", { type: "submit", class: "btn btn--primary btn-add-mapping", text: "Add mapping" });
  form.appendChild(btn);
  const msg = el("p", { class: "form-error", text: "" });
  msg.hidden = true;
  form.appendChild(msg);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = {};
    for (const k of Object.keys(inputs)) draft[k] = (inputs[k].value || "").trim();
    const empty = Object.keys(inputs).find((k) => draft[k] === "");
    if (empty) { showMsg(msg, "All five fields are required.", true); return; }
    if (!handlers || typeof handlers.addMapping !== "function") { showMsg(msg, "Add is not available.", true); return; }
    let result;
    try { result = handlers.addMapping(draft); }
    catch (err) { result = { ok: false, error: err && err.message ? err.message : String(err) }; }
    if (result && result.ok) {
      const resolved = result.resolvedCount || 0;
      showMsg(msg, "Mapping added." + (resolved ? " " + resolved + " queued record(s) resolved." : ""), false);
      for (const k of Object.keys(inputs)) inputs[k].value = "";
    } else {
      showMsg(msg, "Could not add: " + ((result && (result.message || result.error)) || "unknown error") + ".", true);
    }
  });
  wrap.appendChild(form);
  return wrap;
}

function buildTable(entries, handlers) {
  const wrap = el("div", { class: "table-wrap" });
  const table = el("table", { class: "mapping-table" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of COLUMNS) headRow.appendChild(el("th", { text: col.label }));
  headRow.appendChild(el("th", { text: "Actions" }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const entry of entries) tbody.appendChild(buildRow(entry, handlers));
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildRow(entry, handlers) {
  const row = el("tr", { class: "mapping-row" });
  const status = entry && entry.status ? String(entry.status) : "unknown";
  row.className = status === "approved" ? "mapping-row approved" : "mapping-row draft";
  if (entry && entry.id != null) row.setAttribute("data-mapping-id", String(entry.id));
  for (const col of COLUMNS) {
    const td = el("td", { text: cellText(entry, col.key) });
    if (col.key === "status") td.className = "status status-" + status;
    row.appendChild(td);
  }
  const actions = el("td", { class: "mapping-actions" });
  const del = el("button", { type: "button", class: "btn btn--danger btn-delete-mapping", text: "Delete" });
  del.addEventListener("click", () => {
    const label = (entry.maisonId || "") + " " + (entry.localSupplierCode || "");
    const ok = typeof window !== "undefined" && window.confirm ? window.confirm("Delete mapping for " + label + "? This is recorded in the Audit Trail.") : true;
    if (!ok) return;
    if (!handlers || typeof handlers.deleteMapping !== "function") return;
    try { handlers.deleteMapping(entry.id, "manual delete"); }
    catch (err) { /* no-op; view re-renders from state */ }
  });
  actions.appendChild(del);
  row.appendChild(actions);
  return row;
}

function cellText(entry, key) {
  const value = entry ? entry[key] : undefined;
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

function showMsg(node, message, isError) {
  node.textContent = message;
  node.className = isError ? "form-error" : "form-success";
  node.hidden = false;
}

// Collapsible change history: the Audit Trail of every mapping change, folded
// into this screen (it is entirely about mapping-table changes). Newest first;
// the underlying log is append-only.
function buildHistory(state) {
  const trail = Array.isArray(state && state.auditTrail) ? state.auditTrail : [];
  const details = el("details", { class: "mapping-history" });
  details.appendChild(el("summary", { class: "mapping-history__summary", text: "Mapping Action History (" + trail.length + ")" }));
  const body = el("div", { class: "mapping-history__body" });
  if (trail.length === 0) {
    body.appendChild(el("p", { class: "empty-state", text: "No changes recorded yet." }));
    details.appendChild(body);
    return details;
  }
  const tw = el("div", { class: "table-wrap" });
  const table = el("table", { class: "audit-table" });
  const thead = el("thead"); const hr = el("tr");
  for (const lbl of ["When", "Who", "Action", "Detail"]) hr.appendChild(el("th", { text: lbl }));
  thead.appendChild(hr); table.appendChild(thead);
  const tb = el("tbody");
  for (const e of trail.slice().reverse()) {
    const tr = el("tr");
    tr.appendChild(el("td", { text: histText(e.timestamp) }));
    tr.appendChild(el("td", { text: histText(e.actor) }));
    tr.appendChild(el("td", { text: histText(e.action) }));
    tr.appendChild(el("td", { text: histDetail(e) }));
    tb.appendChild(tr);
  }
  table.appendChild(tb); tw.appendChild(table); body.appendChild(tw); details.appendChild(body);
  return details;
}

function histText(v) { return v === undefined || v === null || v === "" ? "-" : String(v); }

function histDetail(e) {
  const fmt = (m) => m ? [m.maisonId, m.localSupplierCode, m.lvmhSupplierId].filter(Boolean).join(" / ") : "";
  if (e.action === "ADD") return "Added " + fmt(e.newValue);
  if (e.action === "DELETE") return "Deleted " + fmt(e.priorValue);
  if (e.action === "OVERRIDE") return "Override: " + ((e.newValue && e.newValue.note) || "");
  if (e.action === "IMPORT") return "Imported " + ((e.newValue && e.newValue.importedCount) || 0) + " mappings";
  return "";
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
