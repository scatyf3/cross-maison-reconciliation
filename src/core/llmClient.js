// src/core/llmClient.js
// Optional, browser-side client for Anthropic's Messages API. Used only when
// the reviewer supplies their own API key in the Strategic Sourcing view. The
// app works fully without this. No key is stored; it is passed in per call.
//
// Note: Anthropic blocks direct browser calls by default, so we send the
// 'anthropic-dangerous-direct-browser-access' header to opt in. This is
// acceptable for a class demo (key is visible in the browser); production
// should proxy through a backend that holds the key.

export const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// Build the sourcing-advisor prompt from the aggregated summary data.
function buildPrompt(data) {
  return [
    "You are a procurement strategy advisor for LVMH group finance.",
    "Using ONLY the aggregated spend summary below (EUR), produce a concise",
    "strategic sourcing recommendation. Cover: (1) spend analysis and",
    "concentration, (2) where to leverage Group-wide umbrella/consolidated",
    "contracts across Maisons, (3) supply risk and mitigation. Be specific and",
    "reference the suppliers/categories by name. Keep it under ~250 words.",
    "",
    "SPEND SUMMARY (JSON):",
    JSON.stringify(data, null, 2),
  ].join("\n");
}

// Call Anthropic and return the assistant's text. Throws on HTTP/parse errors.
export async function askClaude({ apiKey, model, data }) {
  if (typeof fetch === "undefined") throw new Error("fetch is not available in this environment.");
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 700,
    messages: [{ role: "user", content: buildPrompt(data) }],
  };
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = resp.status + " " + resp.statusText;
    try { const err = await resp.json(); if (err && err.error && err.error.message) msg = err.error.message; } catch (e) {}
    throw new Error(msg);
  }
  const json = await resp.json();
  const parts = (json && Array.isArray(json.content)) ? json.content : [];
  const text = parts.filter((p) => p && p.type === "text").map((p) => p.text).join("\n").trim();
  return text || "(The model returned no text.)";
}
