// src/core/constants.js
//
// Shared constants and enumerated vocabularies for the Cross-Maison P2P
// Reconciliation prototype. These definitions are the single source of truth
// used by the pure core modules, the UI shell, the tests, and audit entries,
// so that every layer speaks one vocabulary.
//
// Requirements: 4.2, 7.2, 8.2, 8.3, 8.4, 8.5, 9.2

/**
 * The common LVMH extract format: nine columns in a fixed order.
 * Used by the CSV parser/serializer (header + column order), validation
 * (required-field checks), reporting, and seed data.
 * Requirements: 4.2
 * @type {readonly string[]}
 */
export const COLUMN_ORDER = Object.freeze([
  "supplierCode",
  "accountCode",
  "costCenter",
  "poRef",
  "receiptRef",
  "invoiceRef",
  "quantity",
  "price",
  "currency",
]);

/**
 * Reasons a P2P_Record is routed to the Exception_Queue.
 * - NO_MAPPING ............ no approved Mapping_Entry matches the record
 * - MISSING_FIELD ......... a required field is absent (Req 7.2)
 * - MISSING_REFERENCE ..... a PO/receipt/invoice reference is absent (Req 8.2)
 * - PRICE_MISMATCH ........ 3-way match price disagreement (Req 8.3)
 * - CURRENCY_MISMATCH ..... 3-way match currency disagreement (Req 8.4)
 * - QUANTITY_MISMATCH ..... 3-way match quantity disagreement (Req 8.5)
 * - DUPLICATE_PO .......... duplicate purchase order within a Maison (Req 9.2)
 * - NORMALIZATION_FAILED .. re-normalization after approval failed
 * @readonly
 */
export const ExceptionReason = Object.freeze({
  NO_MAPPING: "NO_MAPPING",
  MISSING_FIELD: "MISSING_FIELD",
  MISSING_REFERENCE: "MISSING_REFERENCE",
  PRICE_MISMATCH: "PRICE_MISMATCH",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  QUANTITY_MISMATCH: "QUANTITY_MISMATCH",
  DUPLICATE_PO: "DUPLICATE_PO",
  NORMALIZATION_FAILED: "NORMALIZATION_FAILED",
});

/**
 * Reasons the CSV_Parser rejects (excludes) a row while continuing to parse.
 * - MISSING_COLUMN .. a required column is absent from the row (Req 4.5)
 * - TYPE_RANGE ...... a value violates the type/range rules (Req 4.6)
 * @readonly
 */
export const ParseErrorReason = Object.freeze({
  MISSING_COLUMN: "MISSING_COLUMN",
  TYPE_RANGE: "TYPE_RANGE",
});

/**
 * Field type and range bounds for the typed columns.
 * - quantity: integer in [0, 999,999,999]
 * - price:    decimal in [0.00, 999,999,999.99] with at most 2 decimal places
 * - currency: a 3-letter A–Z (ISO 4217-style) code
 * Requirements: 4.2, 8.3
 * @readonly
 */
export const FIELD_BOUNDS = Object.freeze({
  quantity: Object.freeze({
    type: "integer",
    min: 0,
    max: 999_999_999,
  }),
  price: Object.freeze({
    type: "decimal",
    min: 0,
    max: 999_999_999.99,
    maxDecimalPlaces: 2,
  }),
  currency: Object.freeze({
    type: "code",
    length: 3,
    pattern: /^[A-Z]{3}$/,
  }),
});

/**
 * The absolute tolerance for 3-way price matching: prices must be equal
 * within 0.00 (Req 8.3), i.e. no difference is allowed.
 * @type {number}
 */
export const PRICE_MATCH_TOLERANCE = 0.0;

/**
 * Default similarity threshold for the Recommendation_Agent. A candidate is
 * surfaced as a suggestion only when its confidence is at or above this value.
 * Requirements: 11.6 (default 0.70)
 * @type {number}
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

/**
 * The common presentation currency for the Group_Report. The prototype does
 * not perform FX conversion; this is the common-currency label (Req 15.1).
 * @type {string}
 */
export const COMMON_CURRENCY = "EUR";
