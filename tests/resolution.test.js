// Integration: exception resolution paths (override + mapping) and derived counts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { useInMemoryBackend, resetAll, seedIfEmpty } from "../src/store/browserStore.js";
import * as ctl from "../src/ui/appController.js";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSV = readFileSync(join(ROOT, "LVMH_Finance_Approved_Transactions.csv"), "utf8");

test("override and mapping both clear exceptions; counts stay derived", () => {
  useInMemoryBackend(); resetAll(); seedIfEmpty({ mappingTable: [] });
  const st = ctl.getState();
  st.mappingTable = []; st.exceptionQueue = []; st.consolidated = []; st.auditTrail = [];
  st.meta = { ...st.meta, reviewerId: "reviewer-01" };
  const res = ctl.loadFinanceExtract(CSV);
  assert.equal(res.ok, true);
  let s = ctl.getState();
  assert.ok(s.exceptionQueue.every((e) => e.advice), "every exception has advice");
  const r0 = ctl.buildCurrentReport();
  assert.equal(r0.counts.autoNormalized + r0.counts.financeJudgment, s.consolidated.length);
  assert.equal(r0.counts.exceptionsRemaining, s.exceptionQueue.length);
  // override a price variance
  const price = s.exceptionQueue.find((e) => e.reason === "PRICE_MISMATCH");
  assert.ok(price, "has a price variance");
  const ov = ctl.resolveException(price.id, "within tolerance");
  assert.equal(ov.ok, true);
  // NO_MAPPING cannot be overridden
  s = ctl.getState();
  const noMap = s.exceptionQueue.find((e) => e.reason === "NO_MAPPING");
  const blocked = ctl.resolveException(noMap.id, "x");
  assert.equal(blocked.ok, false, "override blocked for NO_MAPPING");
  // resolve it via mapping approval
  const draft = { maisonId: noMap.maisonId, localSupplierCode: noMap.localCodes.supplierCode, localAccountCode: noMap.localCodes.accountCode, lvmhSupplierId: noMap.record.globalSupplierId || "SUP-001", lvmhAccountCode: "ACCT-X", origin: "manual" };
  const am = ctl.approveMapping(noMap.id, draft, "reviewer-01");
  assert.equal(am.ok, true);
  // final reconciliation
  s = ctl.getState();
  const rF = ctl.buildCurrentReport();
  assert.equal(rF.counts.autoNormalized + rF.counts.financeJudgment, s.consolidated.length);
  assert.equal(rF.counts.exceptionsRemaining, s.exceptionQueue.length);
  assert.equal(rF.rows.length, s.consolidated.length);
  assert.ok(rF.counts.financeJudgment >= 2, "override + mapping counted as judgment");
});
