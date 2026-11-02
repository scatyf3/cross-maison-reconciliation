// src/core/validation.js
//
// Validation_Module for the Cross-Maison P2P Reconciliation prototype. It runs
// the three validation checks a P2P_Record must satisfy before it can be
// consolidated into the LVMH common data structure:
//
//   1. Required-field presence (Req 7.1, 7.2, 7.3)
//        supplierCode, accountCode, poRef, receiptRef, invoiceRef,
//        quantity, price, currency must all be present -> else MISSING_FIELD
//        naming the offending field.
//
//   2. The 3-way match (Req 8.2, 8.3, 8.4, 8.5, 8.6)
//        Compares the purchase-order, receipt, and invoice SIDES on price,
//        currency, and quantity. The common extract carries one top-level
//        price/currency/quantity per record; to exercise 3-way-match semantics
//        the record may carry optional per-side fields
//        (poPrice/receiptPrice/invoicePrice, poQuantity/receiptQuantity/
//        invoiceQuantity, poCurrency/receiptCurrency/invoiceCurrency). When a
//        per-side field is absent it DEFAULTS to the top-level value, so a
//        well-formed record (only top-level values set) matches by
//        construction. A missing PO/receipt/invoice reference -> MISSING_REFERENCE;
//        a price diff greater than PRICE_MATCH_TOLERANCE (0.00) -> PRICE_MISMATCH;
//        currencies not all identical -> CURRENCY_MISMATCH; quantities not all
//        equal -> QUANTITY_MISMATCH.
//
//   3. Duplicate purchase-order detection (Req 9.1, 9.2, 9.3)
//        Scoped PER Maison on poRef. When a prior record in the same Maison
//        shares this record's poRef, the LATER record is flagged DUPLICATE_PO
//        and the detail retains references to both conflicting records.
//
// Every check is a PURE function over plain data. Failing records are never
// mutated: their field values are returned unchanged and only a separate
// result object carries the failure reason (Req 7.3, 8.2-8.5). The module has
// no DOM, storage, or network access.
//
// Requirements: 7.1, 7.2, 7.3, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 9.2, 9.3

import { ExceptionReason, PRICE_MATCH_TOLERANCE } from "./constants.js";

/**
 * The required fields a P2P_Record must carry to pass required-field
 * validation (Req 7.1). costCenter is intentionally NOT required.
 * @type {readonly string[]}
 */
export const REQUIRED_FIELDS = Object.freeze([
  "supplierCode",
  "accountCode",
  "poRef",
  "receiptRef",
  "invoiceRef",
  "quantity",
  "price",
  "currency",
]);

/**
 * The three sides compared by the 3-way match.
 * @type {readonly string[]}
 */
const SIDES = Object.freeze(["po", "receipt", "invoice"]);

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} passed            True when the check passed.
 * @property {string} [reason]           An ExceptionReason value when failed.
 * @property {Object} [detail]           Check-specific context on failure
 *                                       (offending field, per-side diffs, or
 *                                       conflicting record references).
 */

/**
 * Determine whether a value counts as "present" for required-field validation.
 * Absent means `undefined`, `null`, or an empty/whitespace-only string. Numeric
 * zero and the number 0 are considered present (a price or quantity of 0 is a
 * value, not a missing field).
 *
 * @param {*} value
 * @returns {boolean} true when the value is present
 */
function isPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * Verify that every required field is present on the record (Req 7.1). Returns
 * a pass, or a failure naming the first absent field with reason MISSING_FIELD
 * (Req 7.2). The record is not modified (Req 7.3).
 *
 * @param {Object} record  a P2P_Record
 * @returns {ValidationResult}
 */
export function validateRequiredFields(record) {
  const source = record ?? {};
  for (const field of REQUIRED_FIELDS) {
    if (!isPresent(source[field])) {
      return {
        passed: false,
        reason: ExceptionReason.MISSING_FIELD,
        detail: { field },
      };
    }
  }
  return { passed: true };
}

/**
 * Resolve the value for one side of a 3-way-match dimension, defaulting to the
 * record's top-level value when the per-side field is absent. For example the
 * PO price resolves from `poPrice`, falling back to `price`.
 *
 * @param {Object} record       a P2P_Record
 * @param {string} side         "po" | "receipt" | "invoice"
 * @param {string} dimension    "Price" | "Currency" | "Quantity"
 * @param {string} topLevelKey  the top-level fallback field name
 * @returns {*} the resolved per-side value
 */
function sideValue(record, side, dimension, topLevelKey) {
  const perSideKey = `${side}${dimension}`;
  const perSide = record[perSideKey];
  return isPresent(perSide) ? perSide : record[topLevelKey];
}

/**
 * Coerce a possibly-string numeric value to a Number for comparison. Returns
 * NaN for values that cannot be parsed, which the caller treats as a mismatch.
 *
 * @param {*} value
 * @returns {number}
 */
function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/**
 * Perform the 3-way match across the purchase-order, receipt, and invoice sides
 * (Req 8.1). The check proceeds in a fixed order so the single most relevant
 * failure reason is reported:
 *
 *   1. MISSING_REFERENCE  if poRef, receiptRef, or invoiceRef is absent (Req 8.2)
 *   2. PRICE_MISMATCH     if the absolute difference between any two side prices
 *                         exceeds PRICE_MATCH_TOLERANCE (0.00) (Req 8.3)
 *   3. CURRENCY_MISMATCH  if the three side currencies are not all identical (Req 8.4)
 *   4. QUANTITY_MISMATCH  if the three side quantities are not all equal (Req 8.5)
 *
 * When all three prices match within tolerance, all three currencies are
 * identical, and all three quantities are equal, the match passes (Req 8.6).
 * Per-side values default to the top-level price/currency/quantity, so a record
 * carrying only the single top-level values passes by construction. The record
 * is never modified.
 *
 * @param {Object} record  a P2P_Record (optionally with per-side fields)
 * @returns {ValidationResult}
 */
export function threeWayMatch(record) {
  const source = record ?? {};

  // 1. Missing reference (Req 8.2)
  const referenceBySide = {
    po: source.poRef,
    receipt: source.receiptRef,
    invoice: source.invoiceRef,
  };
  for (const side of SIDES) {
    if (!isPresent(referenceBySide[side])) {
      return {
        passed: false,
        reason: ExceptionReason.MISSING_REFERENCE,
        detail: { side, reference: `${side}Ref` },
      };
    }
  }

  // Resolve per-side values (defaulting to top-level).
  const prices = SIDES.map((side) =>
    toNumber(sideValue(source, side, "Price", "price")),
  );
  const currencies = SIDES.map((side) =>
    sideValue(source, side, "Currency", "currency"),
  );
  const quantities = SIDES.map((side) =>
    toNumber(sideValue(source, side, "Quantity", "quantity")),
  );

  // 2. Price mismatch: abs diff between ANY two sides > tolerance (Req 8.3)
  for (let i = 0; i < prices.length; i += 1) {
    for (let j = i + 1; j < prices.length; j += 1) {
      const a = prices[i];
      const b = prices[j];
      const diff = Math.abs(a - b);
      if (Number.isNaN(diff) || diff > PRICE_MATCH_TOLERANCE) {
        return {
          passed: false,
          reason: ExceptionReason.PRICE_MISMATCH,
          detail: {
            prices: { po: prices[0], receipt: prices[1], invoice: prices[2] },
            diff: Number.isNaN(diff) ? null : diff,
          },
        };
      }
    }
  }

  // 3. Currency mismatch: not all identical (Req 8.4)
  const allCurrenciesIdentical = currencies.every((c) => c === currencies[0]);
  if (!allCurrenciesIdentical) {
    return {
      passed: false,
      reason: ExceptionReason.CURRENCY_MISMATCH,
      detail: {
        currencies: {
          po: currencies[0],
          receipt: currencies[1],
          invoice: currencies[2],
        },
      },
    };
  }

  // 4. Quantity mismatch: not all equal (Req 8.5)
  const allQuantitiesEqual = quantities.every((q) => q === quantities[0]);
  if (!allQuantitiesEqual || quantities.some((q) => Number.isNaN(q))) {
    return {
      passed: false,
      reason: ExceptionReason.QUANTITY_MISMATCH,
      detail: {
        quantities: {
          po: quantities[0],
          receipt: quantities[1],
          invoice: quantities[2],
        },
      },
    };
  }

  // All three dimensions agree (Req 8.6).
  return { passed: true };
}

/**
 * Detect a duplicate purchase order within the SAME Maison (Req 9.1, 9.2). The
 * check is scoped per Maison: a prior record counts as a conflict only when it
 * shares both this record's maisonId and its poRef. The LATER record (this one)
 * is the duplicate; the earliest matching prior record is reported as the
 * conflict so both records can be referenced on the exception (Req 9.3).
 *
 * Identical poRefs across DIFFERENT Maisons are not duplicates. When poRef is
 * absent this check passes (a missing reference is handled by the 3-way match).
 *
 * @param {Object} record                 the record being validated (later)
 * @param {Object[]} priorRecordsInMaison  records already processed; only those
 *                                         in the same Maison are considered
 * @returns {ValidationResult}
 */
export function detectDuplicatePO(record, priorRecordsInMaison) {
  const source = record ?? {};
  const prior = Array.isArray(priorRecordsInMaison)
    ? priorRecordsInMaison
    : [];

  if (!isPresent(source.poRef)) {
    return { passed: true };
  }

  const conflict = prior.find(
    (other) =>
      other &&
      other.maisonId === source.maisonId &&
      isPresent(other.poRef) &&
      other.poRef === source.poRef,
  );

  if (conflict) {
    return {
      passed: false,
      reason: ExceptionReason.DUPLICATE_PO,
      detail: {
        poRef: source.poRef,
        maisonId: source.maisonId,
        conflictingProcessingIds: [
          conflict.processingId ?? null,
          source.processingId ?? null,
        ],
        conflictingRecords: [
          { processingId: conflict.processingId ?? null, poRef: conflict.poRef },
          { processingId: source.processingId ?? null, poRef: source.poRef },
        ],
      },
    };
  }

  return { passed: true };
}

/**
 * Compose all validation checks for a single P2P_Record and return a single
 * result. Checks run in order and the FIRST failure short-circuits, so the
 * returned reason is the most specific applicable failure:
 *
 *   1. Required fields  -> MISSING_FIELD
 *   2. 3-way match      -> MISSING_REFERENCE | PRICE_MISMATCH
 *                          | CURRENCY_MISMATCH | QUANTITY_MISMATCH
 *   3. Duplicate PO     -> DUPLICATE_PO
 *
 * The record is never mutated; the result is a fresh object of the shape
 * `{ passed, reason?, detail? }` where `reason` is an ExceptionReason value
 * (Req 7.3, 8.2-8.5, 9.3). `context.priorRecordsInMaison` supplies the records
 * already processed, used only for duplicate detection.
 *
 * @param {Object} record   a P2P_Record
 * @param {Object} [context]  { priorRecordsInMaison?: Object[] }
 * @returns {{ passed: boolean, reason?: string, detail?: Object }}
 */
export function validateRecord(record, context = {}) {
  const priorRecordsInMaison = context.priorRecordsInMaison ?? [];

  const requiredResult = validateRequiredFields(record);
  if (!requiredResult.passed) {
    return {
      passed: false,
      reason: requiredResult.reason,
      detail: requiredResult.detail,
    };
  }

  const matchResult = threeWayMatch(record);
  if (!matchResult.passed) {
    return {
      passed: false,
      reason: matchResult.reason,
      detail: matchResult.detail,
    };
  }

  const duplicateResult = detectDuplicatePO(record, priorRecordsInMaison);
  if (!duplicateResult.passed) {
    return {
      passed: false,
      reason: duplicateResult.reason,
      detail: duplicateResult.detail,
    };
  }

  return { passed: true };
}
