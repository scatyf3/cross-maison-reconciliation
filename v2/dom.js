// v2/dom.js — tiny DOM + formatting helpers shared by the v2 shell.
// Everything that can come from data or an agent is set with textContent.

/**
 * h("div.card.is-open", { title: "x", onclick }, child, "text", [more])
 * Class names can ride on the tag ("div.a.b"); attrs starting with "on" are
 * listeners; `text` sets textContent; null/false children are skipped.
 */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = String(tag).split(".");
  const node = document.createElement(name || "div");
  if (classes.length) node.className = classes.join(" ");
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "class") node.className = [node.className, v].filter(Boolean).join(" ");
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const EUR = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const EUR2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

export const fmt = {
  eur: (v) => (Number.isFinite(Number(v)) ? EUR.format(Number(v)) : "—"),
  eur2: (v) => (Number.isFinite(Number(v)) ? EUR2.format(Number(v)) : "—"),
  num: (v) => (Number.isFinite(Number(v)) ? NUM.format(Number(v)) : String(v ?? "—")),
  pct: (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) + "%" : "—"),
  time: (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  },
  signed: (v, f = NUM.format) => (v > 0 ? "+" : v < 0 ? "−" : "±") + f(Math.abs(v)),
};

/** Plain-language name for a snake_case column or tool. */
export function humanize(s) {
  return String(s || "").replace(/^mcp__.*__/, "").replace(/_/g, " ");
}

/** Session storage that never throws (private mode, blocked storage). */
export const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

let toastTimer = null;
export function toast(message, tone = "info") {
  let node = document.getElementById("v2-toast");
  if (!node) {
    node = h("div.toast", { id: "v2-toast", role: "status", "aria-live": "polite" });
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-on"), 3600);
}
