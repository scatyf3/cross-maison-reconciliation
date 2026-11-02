// src/core/csv.js
//
// CSV_Parser / CSV_Serializer for the Cross-Maison P2P Reconciliation
// prototype. Handles RFC-4180-style CSV: quoted fields, embedded commas,
// escaped quotes ("" inside a quoted field), and either \r\n or \n line
// endings. The common LVMH extract format defines nine columns in a fixed
// order (see COLUMN_ORDER).
//
// parseCsv(csvText) validates every field against the type/range rules and
// returns { records, parseErrors }. Malformed rows (missing a required column
// or violating a type/range rule) are excluded and recorded as one parse error
// each, while parsing of the remaining rows continues.
//
// serializeCsv(records) writes records back to CSV text in the fixed nine-
// column order with a header row. parseCsv/serializeCsv round-trip is value-
// preserving across all nine fields (design Property 1): parsed field values
// are kept as their original string text, so re-serializing and re-parsing
// reproduces the same values.
//
// Requirements: 4.2, 4.5, 4.6, 4.7

import { COLUMN_ORDER, ParseErrorReason, FIELD_BOUNDS } from "./constants.js";

/**
 * @typedef {Object} ParseError
 * @property {number} rowNumber  1-based source row number (header is row 1).
 * @property {string} column     The offending or missing column name (or "row").
 * @property {string} reason     A ParseErrorReason value.
 */

/**
 * @typedef {Object} ParseResult
 * @property {Object[]} records      One object per valid data row, keyed by COLUMN_ORDER.
 * @property {ParseError[]} parseErrors  One entry per malformed data row.
 */

/**
 * Split a single physical CSV line into fields, honouring RFC-4180 quoting:
 *   - A field may be wrapped in double quotes.
 *   - Inside a quoted field, a comma and the quote character are literal; an
 *     escaped quote is written as two double quotes ("").
 *   - Unquoted fields are taken verbatim up to the next comma.
 *
 * Note: this helper operates on a line with its newline(s) already stripped.
 * Multi-line quoted fields are reassembled by the tokenizer in parseCsv before
 * this helper is called, so every value passed here represents one logical row.
 *
 * @param {string} line
 * @returns {string[]} the ordered field values (quotes removed, escapes decoded)
 */
export function splitCsvLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          // Escaped quote -> literal double quote.
          field += '"';
          i += 2;
          continue;
        }
        // Closing quote.
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      fields.push(field);
      field = "";
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  fields.push(field);
  return fields;
}

/**
 * Escape a single field value for CSV output per RFC-4180. A field is quoted
 * when it contains a comma, a double quote, or a CR/LF; embedded quotes are
 * doubled.
 *
 * @param {*} value  coerced to string (null/undefined become "")
 * @returns {string} the CSV-ready field
 */
export function escapeCsvField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Tokenize raw CSV text into an array of logical rows, where each row is the
 * array of fields produced by splitCsvLine. Quoted fields may span physical
 * line breaks; this tokenizer reassembles them. Both \r\n and \n endings are
 * handled, and a trailing newline does not produce an empty final row.
 *
 * @param {string} csvText
 * @returns {string[][]} logical rows, each an array of field strings
 */
function tokenizeRows(csvText) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  const n = csvText.length;

  const pushRow = () => {
    rows.push(splitCsvLine(current));
    current = "";
  };

  while (i < n) {
    const ch = csvText[i];

    if (ch === '"') {
      // Track quote state so newlines inside quotes stay in the same row.
      if (inQuotes && csvText[i + 1] === '"') {
        current += '""';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
      i += 1;
      continue;
    }

    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      // Consume \r\n as a single line ending.
      if (ch === "\r" && csvText[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      pushRow();
      continue;
    }

    current += ch;
    i += 1;
  }

  // Flush the final row unless the text ended exactly on a line break.
  if (current.length > 0 || rows.length === 0) {
    pushRow();
  }

  return rows;
}

/**
 * Validate a quantity field against FIELD_BOUNDS.quantity.
 * @param {string} raw
 * @returns {boolean} true when valid
 */
function isValidQuantity(raw) {
  const { min, max } = FIELD_BOUNDS.quantity;
  if (!/^\d+$/.test(raw)) {
    return false;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validate a price field against FIELD_BOUNDS.price (decimal, <= 2 dp, range).
 * @param {string} raw
 * @returns {boolean} true when valid
 */
function isValidPrice(raw) {
  const { min, max, maxDecimalPlaces } = FIELD_BOUNDS.price;
  // Optional fractional part with at most `maxDecimalPlaces` digits.
  const decimalRe = new RegExp(`^\\d+(\\.\\d{1,${maxDecimalPlaces}})?$`);
  if (!decimalRe.test(raw)) {
    return false;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Validate a currency field against FIELD_BOUNDS.currency (3-letter A-Z).
 * @param {string} raw
 * @returns {boolean} true when valid
 */
function isValidCurrency(raw) {
  return FIELD_BOUNDS.currency.pattern.test(raw);
}

/**
 * Determine whether a data row violates a type/range rule, returning the first
 * offending column and reason, or null when the typed fields are all valid.
 *
 * @param {Object} record  a record keyed by COLUMN_ORDER
 * @returns {{ column: string, reason: string } | null}
 */
function findTypeRangeError(record) {
  if (!isValidQuantity(record.quantity)) {
    return { column: "quantity", reason: ParseErrorReason.TYPE_RANGE };
  }
  if (!isValidPrice(record.price)) {
    return { column: "price", reason: ParseErrorReason.TYPE_RANGE };
  }
  if (!isValidCurrency(record.currency)) {
    return { column: "currency", reason: ParseErrorReason.TYPE_RANGE };
  }
  return null;
}

/**
 * Parse CSV text into typed P2P records, collecting one parse error per
 * malformed data row while continuing to parse the rest.
 *
 * The first row is the header and MUST contain exactly the nine known column
 * names in the fixed COLUMN_ORDER. A header that is missing or out of order is
 * reported and no data rows are produced.
 *
 * Field values are retained as their original string text so that a
 * serialize -> parse round trip preserves all nine values exactly.
 *
 * @param {string} csvText
 * @returns {ParseResult}
 */
export function parseCsv(csvText) {
  const records = [];
  const parseErrors = [];

  if (typeof csvText !== "string" || csvText.length === 0) {
    parseErrors.push({
      rowNumber: 1,
      column: "header",
      reason: ParseErrorReason.MISSING_COLUMN,
    });
    return { records, parseErrors };
  }

  const rows = tokenizeRows(csvText);
  const header = rows[0];

  // The header must be exactly the nine columns in the fixed order.
  const headerValid =
    header.length === COLUMN_ORDER.length &&
    COLUMN_ORDER.every((name, idx) => header[idx] === name);

  if (!headerValid) {
    // Identify the first expected column that is missing / misplaced.
    const missing = COLUMN_ORDER.find((name, idx) => header[idx] !== name);
    parseErrors.push({
      rowNumber: 1,
      column: missing ?? "header",
      reason: ParseErrorReason.MISSING_COLUMN,
    });
    return { records, parseErrors };
  }

  for (let r = 1; r < rows.length; r += 1) {
    const fields = rows[r];
    const rowNumber = r + 1; // 1-based, header is row 1

    // Skip genuinely blank lines (a single empty field) without an error.
    if (fields.length === 1 && fields[0] === "") {
      continue;
    }

    // A row with the wrong number of columns is missing (or has an extra)
    // required column; report the first column it cannot supply.
    if (fields.length !== COLUMN_ORDER.length) {
      const column =
        fields.length < COLUMN_ORDER.length
          ? COLUMN_ORDER[fields.length]
          : COLUMN_ORDER[COLUMN_ORDER.length - 1];
      parseErrors.push({
        rowNumber,
        column,
        reason: ParseErrorReason.MISSING_COLUMN,
      });
      continue;
    }

    const record = {};
    for (let c = 0; c < COLUMN_ORDER.length; c += 1) {
      record[COLUMN_ORDER[c]] = fields[c];
    }

    const typeError = findTypeRangeError(record);
    if (typeError) {
      parseErrors.push({
        rowNumber,
        column: typeError.column,
        reason: typeError.reason,
      });
      continue;
    }

    records.push(record);
  }

  return { records, parseErrors };
}

/**
 * Serialize records into CSV text in the fixed nine-column order, with a header
 * row. Values are read by COLUMN_ORDER key; missing keys serialize as empty.
 * Uses \n line endings and does not emit a trailing newline, so the output is
 * round-trip stable through parseCsv.
 *
 * @param {Object[]} records  records keyed (at least) by COLUMN_ORDER
 * @returns {string} CSV text
 */
export function serializeCsv(records) {
  const list = Array.isArray(records) ? records : [];
  const lines = [COLUMN_ORDER.map(escapeCsvField).join(",")];

  for (const record of list) {
    const row = COLUMN_ORDER.map((column) =>
      escapeCsvField(record ? record[column] : "")
    );
    lines.push(row.join(","));
  }

  return lines.join("\n");
}
