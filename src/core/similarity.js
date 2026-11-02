// src/core/similarity.js
//
// Pure string-similarity helpers for the Recommendation_Agent. These functions
// implement Steps 1 and 2 of the "Recommendation / Similarity Algorithm" in the
// design: term normalization/tokenization, normalized Levenshtein similarity,
// token-overlap (Jaccard) similarity, and the per-field combined similarity.
//
// All functions are deterministic, side-effect free, and operate on plain data
// so they can be unit- and property-tested in Node and reused by the UI.
//
// Requirements: 11.2

/**
 * Clamp a number to the inclusive range [0, 1]. Non-finite inputs (NaN,
 * Infinity) collapse to 0 so downstream scores stay well-defined.
 * @param {number} value
 * @returns {number} the value constrained to [0, 1]
 */
export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalize a term for comparison: coerce to string, lowercase, trim, and
 * strip every non-alphanumeric character so only the comparable "core" of the
 * code remains.
 *
 *   normalizeTerm("SUP-1042")  -> "sup1042"
 *   normalizeTerm("  6110-FR ") -> "6110fr"
 *   normalizeTerm(null)        -> ""
 *
 * @param {unknown} term
 * @returns {string} the normalized string (empty string for null/undefined)
 */
export function normalizeTerm(term) {
  if (term === null || term === undefined) return "";
  return String(term)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Tokenize a term on non-alphanumeric boundaries, lowercasing each token and
 * dropping empty fragments.
 *
 *   tokenize("SUP-1042")  -> ["sup", "1042"]
 *   tokenize("6110-FR")   -> ["6110", "fr"]
 *   tokenize("")          -> []
 *
 * @param {unknown} term
 * @returns {string[]} the ordered list of lowercase tokens
 */
export function tokenize(term) {
  if (term === null || term === undefined) return [];
  return String(term)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Compute the Levenshtein edit distance between two strings using the classic
 * two-row dynamic-programming approach (O(len(a) * len(b)) time, O(min) space).
 * @param {string} a
 * @param {string} b
 * @returns {number} the minimum number of single-character edits from a to b
 */
export function levenshteinDistance(a, b) {
  const s = a == null ? "" : String(a);
  const t = b == null ? "" : String(b);

  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  // Previous and current rows of the DP matrix.
  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);

  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j++) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    // Swap rows for the next iteration.
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[t.length];
}

/**
 * Normalized Levenshtein similarity in [0, 1] on the normalized forms of the
 * two terms: `1 - levenshtein(a, b) / max(len(a), len(b))`. Returns 1.0 when
 * both normalized strings are empty (two "empty" codes are identical).
 *
 * Inputs are normalized via {@link normalizeTerm} before comparison, so
 * punctuation and case never affect the score.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} similarity in [0, 1]
 */
export function levenshteinSimilarity(a, b) {
  const na = normalizeTerm(a);
  const nb = normalizeTerm(b);

  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1; // both empty -> identical

  const distance = levenshteinDistance(na, nb);
  return clamp01(1 - distance / maxLen);
}

/**
 * Token-overlap (Jaccard) similarity in [0, 1] over the token sets of the two
 * terms: `|tokens(a) ∩ tokens(b)| / |tokens(a) ∪ tokens(b)|`. Returns 1.0 when
 * both token sets are empty (nothing to disagree on).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} Jaccard similarity in [0, 1]
 */
export function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  if (setA.size === 0 && setB.size === 0) return 1; // both empty -> identical

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 1;

  return clamp01(intersection / union);
}

/**
 * Per-field similarity combining normalized Levenshtein and Jaccard equally:
 * `fieldSimilarity = 0.5 * levenshteinSim + 0.5 * jaccard`, clamped to [0, 1].
 *
 * This is the building block Step 3 of the algorithm combines across the
 * supplier and account fields.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} combined per-field similarity in [0, 1]
 */
export function fieldSimilarity(a, b) {
  const lev = levenshteinSimilarity(a, b);
  const jac = jaccardSimilarity(a, b);
  return clamp01(0.5 * lev + 0.5 * jac);
}
