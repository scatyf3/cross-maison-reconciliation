# Seed Maison Extracts

These CSV files are the seeded sample Maison extracts (Req 3). Each uses the
fixed nine-column common LVMH extract format in order (see
`src/core/constants.js` `COLUMN_ORDER`):

```
supplierCode,accountCode,costCenter,poRef,receiptRef,invoiceRef,quantity,price,currency
```

The starter Mapping_Table lives at `src/seed/starterMappingTable.json` and is
loaded on first run alongside these extracts.

## Which rows exercise which path

### `lv_extract.csv` — auto-normalized path (Req 3.5)
Local codes `SUP-1042` / account `6110` / `EUR`, consistent 3-way match.
The starter Mapping_Table has an **approved** LV entry for the tuple
`(LV, SUP-1042, 6110) → LVMH-SUP-000123 / ACCT-6110`, so **all 5 rows
auto-normalize** with no reviewer action and flow straight to consolidation.

### `dior_extract.csv` — ambiguous-mapping path (Req 3.5)
Local codes `VND-87` / account `6110-FR` / `EUR`. There is **no exact approved
mapping** for the tuple `(DIOR, VND-87, 6110-FR)`, so **all 4 rows** route to
the Exception_Queue with reason `NO_MAPPING`. The starter Mapping_Table holds
two approved Dior entries that are textually close, giving the
Recommendation_Agent a near-miss candidate to surface with evidence:
- `(DIOR, VND-85, 6110-FR)` — supplier code differs by one character.
- `(DIOR, VND-87, 6110)` — exact supplier match, account one token shorter.

### `fendi_extract.csv` — validation-failure path (Req 3.5)
Local codes `77821` / account `61-10` / `USD`. Because the common extract
carries a single price/quantity/currency per row, the three 3-way-match sides
default to equal values and cannot mismatch through these nine columns alone;
so the failure cases here are driven by a duplicate PO and a missing reference
instead:

| Row (data line) | poRef | What it exercises |
| --- | --- | --- |
| 1 | `PO-FND-7001` | clean — first occurrence of this PO |
| 2 | `PO-FND-7002` | clean |
| 3 | `PO-FND-7001` | **`DUPLICATE_PO`** — repeats row 1's PO within Fendi (Req 9.2) |
| 4 | `PO-FND-7004` | **`MISSING_REFERENCE` / `MISSING_FIELD`** — empty `receiptRef` (Req 7.2 / 8.2) |
| 5 | `PO-FND-7005` | clean |

Note: Fendi has **no** approved mapping for `(FENDI, 77821, 61-10)` either, so
the clean Fendi rows also land in the Exception_Queue as `NO_MAPPING`; the rows
above additionally demonstrate the duplicate-PO and missing-field failures.
