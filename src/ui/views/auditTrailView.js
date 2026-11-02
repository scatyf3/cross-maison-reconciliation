// src/ui/views/auditTrailView.js
//
// Audit Trail view for the Cross-Maison P2P Reconciliation prototype.
//
// Displays the append-only Audit_Trail (state.auditTrail) to the
// Finance_Reviewer (Req 13.4). Each entry records the acting reviewer, the
// change timestamp, the action (ADD / CHANGE), the prior mapping value, the new
// mapping value, and the P2P_Record processing id that prompted the change
// (Req 13.2). The underlying log is append-only — existing entries are never
// rewritten or removed (Req 13.3) — so this view renders existing entries
// as-is. For readability it lists the NEWEST entry first; it does not mutate
// the stored trail to do so (it iterates a shallow copy in reverse), preserving
// the append-only log order on disk.
//
// Pure-presentation view module: reads live state, builds DOM, performs no
// mutations and no storage writes. Prior/new mapping values are rendered via
// `textContent` as compact summaries (never innerHTML), so stored values cannot
// inject markup (XSS-safe by construction).
//
// Contract: exports `render(container, state, handlers)`.
//
// Requirements: 13.4, 17.2

/**
 * Render the Audit Trail view into `container`.
 *
 * @param {Element} container  the app root element to render into
 * @param {Object} state       the live app state (reads `state.auditTrail`)
 * @param {Object} [handlers]  controller callbacks (unused by this read-only view)
 * @returns {void}
 */
export function render(container, state, handlers) {
  if (typeof document === "undefined" || !container) return;

  const trail = Array.isArray(state && state.auditTrail)
    ? state.auditTrail
    : [];

  container.innerHTML = "";

  const section = document.createElement("section");
  section.className = "view view-audit";

  const heading = document.createElement("h2");
  heading.textContent = "Audit Trail";
  section.appendChild(heading);

  const caption = document.createElement("p");
  caption.className = "view-caption";
  caption.textContent =
    "Append-only log of every Mapping Table change. Newest first; entries are " +
    "never modified or removed once written.";
  section.appendChild(caption);

  if (trail.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No audit entries yet.";
    section.appendChild(empty);
    container.appendChild(section);
    return;
  }

  section.appendChild(buildTable(trail));
  container.appendChild(section);
}

/**
 * Build the audit table. Iterates a reversed shallow copy so the newest entry
 * shows first WITHOUT mutating the append-only source array.
 * @param {Object[]} trail
 * @returns {HTMLTableElement}
 */
function buildTable(trail) {
  const table = document.createElement("table");
  table.className = "audit-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of [
    "Actor",
    "Timestamp",
    "Action",
    "Prior Value",
    "New Value",
    "Prompted By (processing id)",
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const newestFirst = trail.slice().reverse();
  for (const entry of newestFirst) {
    tbody.appendChild(buildRow(entry));
  }
  table.appendChild(tbody);

  return table;
}

/**
 * Build one table row for an Audit_Trail entry.
 * @param {Object} entry
 * @returns {HTMLTableRowElement}
 */
function buildRow(entry) {
  const row = document.createElement("tr");
  const action = entry && entry.action ? String(entry.action) : "unknown";
  row.className = "audit-row";
  row.dataset.action = action;

  appendCell(row, text(entry && entry.actor));
  appendCell(row, text(entry && entry.timestamp));

  const actionCell = appendCell(row, action);
  actionCell.className = `action action-${action.toLowerCase()}`;

  appendCell(row, summarizeMapping(entry && entry.priorValue));
  appendCell(row, summarizeMapping(entry && entry.newValue));
  appendCell(row, text(entry && entry.promptedByProcessingId));

  return row;
}

/**
 * Create a `<td>`, set its text safely, append it to `row`, and return it.
 * @param {HTMLTableRowElement} row
 * @param {string} value
 * @returns {HTMLTableCellElement}
 */
function appendCell(row, value) {
  const td = document.createElement("td");
  td.textContent = value;
  row.appendChild(td);
  return td;
}

/**
 * Render a nullable scalar as display text, with an em-dash placeholder for
 * absent values. Returned as a plain string for `textContent` (XSS-safe).
 * @param {*} value
 * @returns {string}
 */
function text(value) {
  if (value === undefined || value === null || value === "") return "\u2014";
  return String(value);
}

/**
 * Summarize a mapping value (priorValue / newValue) as a compact one-line
 * string: "MAISON local(S/A) -> LVMH(supplier/account)". A null priorValue
 * (an ADD action has no prior) renders as an em-dash. Unknown shapes fall back
 * to a JSON summary so nothing is silently dropped. Returned as a plain string
 * so the caller assigns it via `textContent` (never innerHTML).
 * @param {Object|null} value  a Mapping_Entry-shaped object, or null
 * @returns {string}
 */
function summarizeMapping(value) {
  if (value === undefined || value === null) return "\u2014";
  if (typeof value !== "object") return String(value);

  const hasMappingShape =
    "maisonId" in value ||
    "localSupplierCode" in value ||
    "lvmhSupplierId" in value;

  if (hasMappingShape) {
    const maison = scalar(value.maisonId);
    const localSupplier = scalar(value.localSupplierCode);
    const localAccount = scalar(value.localAccountCode);
    const lvmhSupplier = scalar(value.lvmhSupplierId);
    const lvmhAccount = scalar(value.lvmhAccountCode);
    return (
      `${maison} ${localSupplier}/${localAccount} ` +
      `\u2192 ${lvmhSupplier}/${lvmhAccount}`
    );
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A scalar field as text with an em-dash placeholder for absent values.
 * @param {*} value
 * @returns {string}
 */
function scalar(value) {
  if (value === undefined || value === null || value === "") return "\u2014";
  return String(value);
}
