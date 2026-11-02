// src/ui/views/exceptionQueueView.js
//
// Exception Queue view for the Cross-Maison P2P Reconciliation prototype
// (route "#exceptions", Req 17.2).
//
// For every entry in `state.exceptionQueue` this view renders, per record:
//   - the originating Maison, the local codes (supplierCode / accountCode),
//     and the reason the record entered the queue (Req 10.2);
//   - for NO_MAPPING entries, the Recommendation_Agent's output:
//       * SUGGESTED  -> the suggested LVMH supplier/account, the confidence,
//                       and the Supporting_Evidence (matched terms with
//                       per-term similarity, and the Mapping_Table history
//                       used) (Req 11.4);
//       * NO_SUGGESTION -> an indication that no suggestion met the threshold,
//                       presenting the record for manual mapping (Req 11.6);
//       * ERROR      -> an error indication that no suggestion could be
//                       produced, while the record stays queued (Req 11.7);
//   - Approve controls: a one-click "Approve suggestion" (when a suggestion
//     exists) and a manual form to enter an LVMH supplier id + account code,
//     both calling `handlers.approveMapping(exceptionId, draft, reviewerId)`;
//   - a Reject control that captures a reason and calls
//     `handlers.rejectResolution(exceptionId, reason)` (Req 12.4).
//
// This module is a pure VIEW: it only reads `state`, renders DOM, and calls
// back through `handlers`. Every dynamic value is written with `textContent` /
// DOM APIs — never innerHTML interpolation — so no Maison/seed/reviewer string
// can inject markup (XSS-safe by construction).
//
// Contract: exports `render(container, state, handlers)`.
//
// Requirements: 10.2, 11.6, 11.7, 17.2

/** @type {string} the NO_MAPPING exception reason this view reacts to. */
const NO_MAPPING = "NO_MAPPING";

/**
 * Render the Exception Queue view into `container`.
 *
 * @param {Element} container  the app root element to render into
 * @param {Object} state       the controller's live state (read-only here)
 * @param {Object} handlers    controller callbacks
 * @returns {void}
 */
export function render(container, state, handlers) {
  if (typeof document === "undefined" || !container) return;

  container.innerHTML = "";

  const queue = Array.isArray(state && state.exceptionQueue)
    ? state.exceptionQueue
    : [];
  const reviewerId =
    state && state.meta && state.meta.reviewerId
      ? state.meta.reviewerId
      : undefined;

  const section = el("section", { class: "view view-exceptions" });
  section.appendChild(
    el("h2", { text: `Exception Queue (${queue.length})` }),
  );

  if (queue.length === 0) {
    section.appendChild(
      el("p", {
        class: "empty",
        text: "No records are in the Exception Queue.",
      }),
    );
    container.appendChild(section);
    return;
  }

  const list = el("ul", { class: "exception-list" });
  for (const entry of queue) {
    if (!entry) continue;
    list.appendChild(buildEntry(entry, handlers, reviewerId));
  }
  section.appendChild(list);
  container.appendChild(section);
}

/**
 * Build the <li> for a single Exception_Queue entry.
 *
 * @param {Object} entry     an ExceptionEntry
 * @param {Object} handlers
 * @param {string} [reviewerId]
 * @returns {Element}
 */
const REASON_LABELS = {
  NO_MAPPING: "No approved mapping",
  MISSING_FIELD: "Missing field",
  MISSING_REFERENCE: "Missing reference",
  PRICE_MISMATCH: "Price variance",
  CURRENCY_MISMATCH: "Currency mismatch",
  QUANTITY_MISMATCH: "Quantity over receipt",
  DUPLICATE_PO: "Duplicate PO",
  NORMALIZATION_FAILED: "Normalization failed",
};

function reasonLabel(reason) {
  return REASON_LABELS[reason] || String(reason || "Exception");
}

function buildEntry(entry, handlers, reviewerId) {
  const reason = String(entry.reason || "");
  const item = el("li", { class: "exception-card" });
  item.setAttribute("data-exception-id", String(entry.id || ""));
  item.setAttribute("data-reason", reason);
  if (entry.status && entry.status !== "open") item.classList.add("is-on-hold");

  // --- Card header: Maison + reason badge (Req 10.2) ---------------------
  const header = el("div", { class: "exc-card__header" });
  const titleWrap = el("div", { class: "exc-card__titlewrap" });
  titleWrap.appendChild(el("span", { class: "exc-card__maison", text: String(entry.maisonId ?? "-") }));
  const localCodes = entry.localCodes || {};
  const supplierCode = localCodes.supplierCode != null ? localCodes.supplierCode : (entry.record && entry.record.supplierCode);
  titleWrap.appendChild(el("span", { class: "exc-card__supplier", text: String(supplierCode ?? "-") }));
  header.appendChild(titleWrap);
  const badge = el("span", { class: "exc-card__badge badge", text: reasonLabel(reason) });
  badge.classList.add("reason-" + (reason || "unknown").toLowerCase());
  if (entry.status && entry.status !== "open") {
    header.appendChild(el("span", { class: "exc-card__status badge badge--warning", text: entry.holdCount > 1 ? ("On hold ×" + entry.holdCount) : "On hold" }));
  }
  header.appendChild(badge);
  item.appendChild(header);

  // --- Card body: identity grid ------------------------------------------
  const body = el("div", { class: "exc-card__body" });
  const accountCode = localCodes.accountCode != null ? localCodes.accountCode : (entry.record && entry.record.accountCode);
  const dl = el("dl", { class: "exc-identity" });
  appendStat(dl, "Local supplier", String(supplierCode ?? "-"));
  appendStat(dl, "Local account", String(accountCode ?? "-"));
  if (entry.record && entry.record.invoiceRef) appendStat(dl, "Invoice", String(entry.record.invoiceRef));
  if (entry.record && entry.record.poRef) appendStat(dl, "PO", String(entry.record.poRef));
  body.appendChild(dl);
  if (entry.rejectionReason) {
    body.appendChild(el("p", { class: "exc-hold-note", text: "On hold: " + String(entry.rejectionReason) }));
  }
  // The raw reasonDetail object is intentionally not dumped here; the clean
  // advice block (headline/detail/action) below conveys the same information.
  if (entry.reason === NO_MAPPING) body.appendChild(buildRecommendation(entry));
  body.appendChild(buildControls(entry, handlers, reviewerId));
  item.appendChild(body);

  return item;
}

/**
 * Build the recommendation block for a NO_MAPPING entry, covering the three
 * recommendation states (SUGGESTED / NO_SUGGESTION / ERROR).
 *
 * @param {Object} entry
 * @returns {Element}
 */
function buildRecommendation(entry) {
  const box = el("div", { class: "exc-recommendation" });
  box.appendChild(el("h4", { text: "Agent recommendation" }));

  const rec = entry.recommendation;

  // No recommendation attached at all — treat like "no suggestion".
  if (!rec) {
    box.classList.add("rec-none");
    box.appendChild(
      el("p", {
        class: "rec-note",
        text: "No suggestion met the threshold. Map this record manually.",
      }),
    );
    return box;
  }

  const status = rec.status;

  if (status === "ERROR") {
    // Req 11.7 — error indication; record stays queued for manual mapping.
    box.classList.add("rec-error");
    const p = el("p", { class: "rec-note rec-error-note" });
    p.appendChild(el("strong", { text: "Error: " }));
    p.appendChild(
      document.createTextNode(
        "no suggestion could be produced. Map this record manually.",
      ),
    );
    box.appendChild(p);
    if (rec.error) {
      box.appendChild(el("p", { class: "rec-error-detail", text: String(rec.error) }));
    }
    return box;
  }

  if (status === "SUGGESTED" && rec.suggestion) {
    // Req 11.2/11.3/11.4 — present the suggestion, confidence, and evidence.
    box.classList.add("rec-suggested");
    const s = rec.suggestion;

    const summary = el("dl", { class: "rec-summary" });
    appendStat(summary, "LVMH supplier", String(s.lvmhSupplierId ?? "-"));
    appendStat(summary, "LVMH account", String(s.lvmhAccountCode ?? "-"));
    appendStat(summary, "Confidence", formatConfidence(rec.confidence));
    box.appendChild(summary);

    const evidence = rec.evidence;
    if (evidence) {
      box.appendChild(buildEvidence(evidence));
    }
    return box;
  }

  // NO_SUGGESTION (or any unrecognized non-error status) — Req 11.6.
  box.classList.add("rec-none");
  const note = el("p", { class: "rec-note" });
  note.textContent = "No suggestion met the threshold. Map this record manually.";
  box.appendChild(note);
  if (rec.evidence && typeof rec.evidence.threshold === "number") {
    box.appendChild(
      el("p", {
        class: "rec-threshold",
        text: `Best confidence ${formatConfidence(
          rec.confidence,
        )} < threshold ${formatConfidence(rec.evidence.threshold)}.`,
      }),
    );
  }
  return box;
}

/**
 * Build the Supporting_Evidence block: matched terms with per-term similarity,
 * and the Mapping_Table history used (Req 11.4).
 *
 * @param {Object} evidence  a SupportingEvidence object
 * @returns {Element}
 */
function buildEvidence(evidence) {
  const details = el("details", { class: "rec-evidence" });
  details.appendChild(el("summary", { text: "Supporting evidence" }));

  // Matched terms table.
  const matched = Array.isArray(evidence.matchedTerms)
    ? evidence.matchedTerms
    : [];
  if (matched.length > 0) {
    details.appendChild(el("h5", { text: "Matched terms" }));
    const table = el("table", { class: "evidence-terms" });
    const thead = el("thead");
    const headRow = el("tr");
    for (const h of ["Field", "Record", "Candidate", "Similarity"]) {
      headRow.appendChild(el("th", { text: h }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const term of matched) {
      const row = el("tr");
      row.appendChild(el("td", { text: String(term.field ?? "-") }));
      row.appendChild(el("td", { text: String(term.recordValue ?? "-") }));
      row.appendChild(el("td", { text: String(term.candidateValue ?? "-") }));
      row.appendChild(
        el("td", { text: formatConfidence(term.similarity) }),
      );
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    details.appendChild(table);
  }

  // History used.
  const history = Array.isArray(evidence.historyUsed)
    ? evidence.historyUsed
    : [];
  if (history.length > 0) {
    details.appendChild(el("h5", { text: "History used" }));
    const ul = el("ul", { class: "evidence-history" });
    for (const h of history) {
      const idPart = h.mappingEntryId != null ? `entry ${h.mappingEntryId}` : "entry -";
      const timesPart = `used ${h.timesUsed != null ? h.timesUsed : 0}×`;
      const whenPart = h.approvedAt ? `, approved ${h.approvedAt}` : "";
      ul.appendChild(el("li", { text: `${idPart}: ${timesPart}${whenPart}` }));
    }
    details.appendChild(ul);
  }

  // Method / threshold footnote.
  const foot = el("p", { class: "evidence-method" });
  const parts = [];
  if (evidence.method) parts.push(`method: ${evidence.method}`);
  if (typeof evidence.threshold === "number") {
    parts.push(`threshold: ${formatConfidence(evidence.threshold)}`);
  }
  if (parts.length > 0) {
    foot.textContent = parts.join(" · ");
    details.appendChild(foot);
  }

  return details;
}

/**
 * Build the Approve / Reject controls for an entry.
 *
 * @param {Object} entry
 * @param {Object} handlers
 * @param {string} [reviewerId]
 * @returns {Element}
 */
function buildControls(entry, handlers, reviewerId) {
  const controls = el("div", { class: "exc-controls" });

  const feedback = el("p", { class: "exc-feedback" });
  feedback.hidden = true;

  const rec = entry.recommendation;
  const hasSuggestion =
    entry.reason === NO_MAPPING &&
    rec &&
    rec.status === "SUGGESTED" &&
    rec.suggestion;

  // Advisory line (present for every exception) explaining the fix.
  if (entry.advice) {
    const adv = el("div", { class: "exc-advice" });
    adv.appendChild(el("p", { class: "exc-advice__headline", text: entry.advice.headline || "" }));
    if (entry.advice.detail) adv.appendChild(el("p", { class: "exc-advice__detail", text: entry.advice.detail }));
    if (entry.advice.action) adv.appendChild(el("p", { class: "exc-advice__action", text: entry.advice.action }));
    controls.appendChild(adv);
  }

  // For non-mapping exceptions, the reviewer approves-with-reason (override)
  // which clears the record into the report; no mapping form is shown.
  if (entry.reason !== NO_MAPPING) {
    const ovForm = el("form", { class: "override-form" });
    const ovReason = el("input", { type: "text", class: "input-override-reason", placeholder: "Approval note (e.g. variance within tolerance)" });
    ovForm.appendChild(labeled("Approve with reason", ovReason));
    const ovBtn = el("button", { type: "submit", class: "btn btn--primary btn-resolve", text: "Approve & clear" });
    ovForm.appendChild(ovBtn);
    ovForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const note = (ovReason.value || "").trim();
      if (note === "") { showFeedback(feedback, "Enter an approval note before clearing.", true); return; }
      if (!handlers || typeof handlers.resolveException !== "function") return;
      let result;
      try { result = handlers.resolveException(entry.id, note); }
      catch (err) { result = { ok: false, error: err && err.message ? err.message : String(err) }; }
      if (result && result.ok) showFeedback(feedback, "Approved and moved to the Group Report.", false);
      else showFeedback(feedback, "Could not approve: " + ((result && (result.message || result.error)) || "unknown error") + ".", true);
    });
    controls.appendChild(ovForm);
  } else {

  // --- Approve the agent suggestion ---------------------------------------
  if (hasSuggestion) {
    const approveSuggestionBtn = el("button", {
      type: "button",
      class: "btn btn-approve-suggestion",
      text: "Approve suggestion",
    });
    approveSuggestionBtn.addEventListener("click", () => {
      const s = rec.suggestion;
      const draft = {
        maisonId: entry.maisonId ?? s.maisonId,
        localSupplierCode:
          s.localSupplierCode ??
          (entry.localCodes && entry.localCodes.supplierCode),
        localAccountCode:
          s.localAccountCode ??
          (entry.localCodes && entry.localCodes.accountCode),
        lvmhSupplierId: s.lvmhSupplierId,
        lvmhAccountCode: s.lvmhAccountCode,
        origin: "agent_suggestion",
      };
      applyApprove(handlers, entry.id, draft, reviewerId, feedback);
    });
    controls.appendChild(approveSuggestionBtn);
  }

  // --- Manual mapping form (collapsible to keep the card clean) -----------
  const manualDetails = el("details", { class: "manual-map" });
  manualDetails.appendChild(el("summary", { class: "manual-map__summary", text: "Map manually" }));
  const manualForm = el("form", { class: "manual-map-form" });

  const supplierInput = el("input", {
    type: "text",
    class: "input-lvmh-supplier",
    placeholder: "LVMH supplier id",
  });
  const accountInput = el("input", {
    type: "text",
    class: "input-lvmh-account",
    placeholder: "LVMH account code",
  });
  // Pre-fill from a suggestion, if present, as a convenience.
  if (hasSuggestion) {
    if (rec.suggestion.lvmhSupplierId != null) {
      supplierInput.value = rec.suggestion.lvmhSupplierId;
    }
    if (rec.suggestion.lvmhAccountCode != null) {
      accountInput.value = rec.suggestion.lvmhAccountCode;
    }
  }
  manualForm.appendChild(labeled("LVMH supplier id", supplierInput));
  manualForm.appendChild(labeled("LVMH account code", accountInput));

  const approveManualBtn = el("button", {
    type: "submit",
    class: "btn btn-approve-manual",
    text: "Approve mapping",
  });
  manualForm.appendChild(approveManualBtn);

  manualForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const lvmhSupplierId = (supplierInput.value || "").trim();
    const lvmhAccountCode = (accountInput.value || "").trim();
    if (lvmhSupplierId === "" || lvmhAccountCode === "") {
      showFeedback(
        feedback,
        "Enter both an LVMH supplier id and an LVMH account code.",
        true,
      );
      return;
    }
    const draft = {
      maisonId: entry.maisonId,
      localSupplierCode:
        (entry.localCodes && entry.localCodes.supplierCode) ??
        (entry.record && entry.record.supplierCode),
      localAccountCode:
        (entry.localCodes && entry.localCodes.accountCode) ??
        (entry.record && entry.record.accountCode),
      lvmhSupplierId,
      lvmhAccountCode,
      origin: "manual",
    };
    applyApprove(handlers, entry.id, draft, reviewerId, feedback);
  });
  manualDetails.appendChild(manualForm);
    controls.appendChild(manualDetails);
  }

  // --- Reject (on hold for correction, Req 12.4) ---------------------------
  const rejectForm = el("form", { class: "reject-form" });
  const reasonInput = el("input", {
    type: "text",
    class: "input-reject-reason",
    placeholder: "Reason for rejection",
  });
  rejectForm.appendChild(labeled("Reject reason", reasonInput));
  const rejectBtn = el("button", {
    type: "submit",
    class: "btn btn-reject",
    text: "Reject",
  });
  rejectForm.appendChild(rejectBtn);

  rejectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const reason = (reasonInput.value || "").trim();
    if (reason === "") {
      showFeedback(feedback, "Enter a reason before rejecting.", true);
      return;
    }
    if (!handlers || typeof handlers.rejectResolution !== "function") return;
    let result;
    try {
      result = handlers.rejectResolution(entry.id, reason);
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (result && result.ok) {
      showFeedback(feedback, "On hold for correction, moved to the back of the queue.", false);
    } else {
      showFeedback(
        feedback,
        `Could not reject: ${(result && (result.message || result.error)) || "unknown error"}.`,
        true,
      );
    }
  });
  controls.appendChild(rejectForm);

  controls.appendChild(feedback);
  return controls;
}

/**
 * Call the controller's approveMapping and reflect the outcome in `feedback`.
 *
 * @param {Object} handlers
 * @param {string} exceptionId
 * @param {Object} draft
 * @param {string} [reviewerId]
 * @param {Element} feedback
 * @returns {void}
 */
function applyApprove(handlers, exceptionId, draft, reviewerId, feedback) {
  if (!handlers || typeof handlers.approveMapping !== "function") return;
  let result;
  try {
    result = handlers.approveMapping(exceptionId, draft, reviewerId);
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (result && result.ok) {
    const resolved = result.resolvedCount != null ? result.resolvedCount : 0;
    showFeedback(
      feedback,
      `Mapping approved and added to the Mapping Table. ${resolved} record(s) moved to the Group Report.`,
      false,
    );
  } else {
    const detail =
      (result && (result.message || result.error)) || "unknown error";
    showFeedback(feedback, `Approval rejected: ${detail}.`, true);
  }
}

/**
 * Wrap an input in a <label> with text.
 * @param {string} text
 * @param {Element} input
 * @returns {Element}
 */
function labeled(text, input) {
  const label = el("label", { class: "field" });
  label.appendChild(el("span", { class: "field-label", text }));
  label.appendChild(input);
  return label;
}

/**
 * Show a feedback message, styled by severity.
 * @param {Element} node
 * @param {string} message
 * @param {boolean} isError
 * @returns {void}
 */
function showFeedback(node, message, isError) {
  node.textContent = message;
  node.className = isError ? "exc-feedback is-error" : "exc-feedback is-ok";
  node.hidden = false;
}

/**
 * Append a term/definition pair to a <dl>.
 * @param {Element} dl
 * @param {string} term
 * @param {string} value
 * @returns {void}
 */
function appendStat(dl, term, value) {
  dl.appendChild(el("dt", { text: term }));
  dl.appendChild(el("dd", { text: value }));
}

/**
 * Format a confidence/similarity number as a 2-dp string, tolerating
 * non-numeric input.
 * @param {*} value
 * @returns {string}
 */
function formatConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toFixed(2);
}

/**
 * Produce a short human-readable string from a structured reason detail
 * object, without assuming a specific schema.
 * @param {*} detail
 * @returns {string}
 */
function summarizeDetail(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail !== "object") return String(detail);
  if (typeof detail.message === "string") return detail.message;
  const parts = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value == null || typeof value === "object") continue;
    parts.push(`${key}: ${value}`);
  }
  return parts.join(", ");
}

/**
 * Tiny DOM element factory. Dynamic text is set via `textContent` so no value
 * is ever interpreted as HTML (XSS-safe). `attrs.text` sets textContent;
 * `attrs.class` sets className; everything else becomes an attribute.
 *
 * @param {string} tag
 * @param {Object} [attrs]
 * @returns {Element}
 */
function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === "text") {
      node.textContent = value;
    } else if (key === "class") {
      node.className = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  return node;
}
