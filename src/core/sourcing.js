// src/core/sourcing.js
// Strategic sourcing analysis (client-side, no AI key needed). Pure functions
// over a Group_Report: spend concentration, umbrella/consolidated-contract
// candidates, tail spend, and single-source risk, each turned into a short,
// explainable recommendation. This is deterministic and transparent (the rules
// are visible), and it is the always-on core of the Strategic Sourcing view.

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function pct(part, whole) { return whole > 0 ? round2((part / whole) * 100) : 0; }

// Build the analysis object from a Group_Report (see reporting.js shape).
export function analyzeSourcing(report) {
  const r = report || {};
  const rows = Array.isArray(r.rows) ? r.rows : [];
  const bySupplier = (Array.isArray(r.spendBySupplier) ? r.spendBySupplier : []).slice();
  const byCategory = (Array.isArray(r.spendByCategory) ? r.spendByCategory : []).slice();
  const total = Number(r.totalSpendEur) || bySupplier.reduce((s, x) => s + (Number(x.spendEur) || 0), 0);

  // Suppliers used across multiple Maisons = umbrella-contract candidates.
  const maisonsBySupplier = new Map();
  for (const row of rows) {
    const id = row.lvmhSupplierId || "(unmapped)";
    const set = maisonsBySupplier.get(id) || new Set();
    if (row.maisonId) set.add(row.maisonId);
    maisonsBySupplier.set(id, set);
  }

  const supplierSpend = bySupplier.map((x) => ({
    lvmhSupplierId: x.lvmhSupplierId,
    name: x.standardSupplierName || x.lvmhSupplierId,
    spendEur: round2(x.spendEur),
    sharePct: pct(x.spendEur, total),
    maisons: (maisonsBySupplier.get(x.lvmhSupplierId) || new Set()).size,
  }));

  // 1. Concentration: cumulative share of the top suppliers.
  let cum = 0;
  const topConcentration = [];
  for (const s of supplierSpend) {
    cum += s.sharePct;
    topConcentration.push({ ...s, cumulativePct: round2(cum) });
    if (cum >= 80 || topConcentration.length >= 5) break;
  }

  // 2. Umbrella candidates: a supplier serving 2+ Maisons (consolidate to one
  //    Group contract to leverage combined volume).
  const umbrellaCandidates = supplierSpend
    .filter((s) => s.maisons >= 2)
    .sort((a, b) => b.spendEur - a.spendEur);

  // 3. Category consolidation: a category whose spend is split across several
  //    suppliers is a candidate to consolidate onto fewer suppliers.
  const suppliersPerCategory = new Map();
  for (const row of rows) {
    const cat = row.spendCategory || row.lvmhAccountCode || "(uncategorized)";
    const set = suppliersPerCategory.get(cat) || new Set();
    if (row.lvmhSupplierId) set.add(row.lvmhSupplierId);
    suppliersPerCategory.set(cat, set);
  }
  const categoryConsolidation = byCategory
    .map((c) => ({
      spendCategory: c.spendCategory,
      spendEur: round2(c.spendEur),
      sharePct: pct(c.spendEur, total),
      supplierCount: (suppliersPerCategory.get(c.spendCategory) || new Set()).size,
    }))
    .filter((c) => c.supplierCount >= 2)
    .sort((a, b) => b.spendEur - a.spendEur);

  // 4. Tail spend: the smallest suppliers that together make up little spend.
  const ascending = supplierSpend.slice().sort((a, b) => a.spendEur - b.spendEur);
  const tail = [];
  let tailSum = 0;
  for (const s of ascending) {
    if (tailSum + s.spendEur > total * 0.2) break;
    tail.push(s);
    tailSum += s.spendEur;
  }

  // 5. Single-source risk: categories served by exactly one supplier.
  const singleSource = [...suppliersPerCategory.entries()]
    .filter(([, set]) => set.size === 1)
    .map(([cat, set]) => ({ spendCategory: cat, lvmhSupplierId: [...set][0] }));

  return {
    totalSpendEur: round2(total),
    supplierCount: supplierSpend.length,
    categoryCount: byCategory.length,
    topConcentration,
    umbrellaCandidates,
    categoryConsolidation,
    tail: { suppliers: tail, totalEur: round2(tailSum), sharePct: pct(tailSum, total) },
    singleSource,
    recommendations: buildRecommendations({ total, supplierSpend, topConcentration, umbrellaCandidates, categoryConsolidation, tail, tailSum, singleSource }),
  };
}

// Turn the findings into short, plain-English recommendations.
function buildRecommendations(a) {
  const recs = [];
  const money = (n) => "EUR " + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (a.umbrellaCandidates.length > 0) {
    const names = a.umbrellaCandidates.slice(0, 3).map((s) => s.name + " (" + s.maisons + " Maisons, " + money(s.spendEur) + ")").join("; ");
    recs.push({
      title: "Negotiate Group umbrella contracts",
      detail: "These suppliers are used by multiple Maisons, so combined volume can be leveraged into a single Group-wide contract for better pricing and terms: " + names + ".",
    });
  }
  if (a.topConcentration.length > 0) {
    const top = a.topConcentration[0];
    const n = a.topConcentration.length;
    const share = a.topConcentration[n - 1].cumulativePct;
    recs.push({
      title: "Manage spend concentration",
      detail: "The top " + n + " supplier(s) account for about " + share + "% of total spend; " + top.name + " alone is " + top.sharePct + "%. Prioritize these relationships for strategic negotiation, and keep a qualified backup to avoid over-dependence.",
    });
  }
  if (a.categoryConsolidation.length > 0) {
    const c = a.categoryConsolidation[0];
    recs.push({
      title: "Consolidate fragmented categories",
      detail: c.spendCategory + " is spread across " + c.supplierCount + " suppliers (" + money(c.spendEur) + "). Consolidating onto fewer preferred suppliers can cut admin cost and unlock volume discounts.",
    });
  }
  if (a.tail.length > 0) {
    recs.push({
      title: "Rationalize tail spend",
      detail: a.tail.length + " small suppliers together make up only " + money(a.tailSum) + " of spend. Consider consolidating or moving them to a catalog/P-card to reduce processing overhead.",
    });
  }
  if (a.singleSource.length > 0) {
    const cats = a.singleSource.slice(0, 3).map((s) => s.spendCategory).join(", ");
    recs.push({
      title: "Mitigate single-source risk",
      detail: "These categories currently rely on a single supplier: " + cats + ". Qualify an alternate source or add contractual protections to reduce supply risk.",
    });
  }
  if (recs.length === 0) recs.push({ title: "No sourcing signals yet", detail: "Load and consolidate transactions first; the analysis runs on the Group Report data." });
  return recs;
}

// Compact prompt payload for the optional LLM panel: only the aggregated
// summary (no raw invoice rows), so the data sent out is minimal.
export function sourcingPromptData(report) {
  const a = analyzeSourcing(report);
  return {
    totalSpendEur: a.totalSpendEur,
    supplierCount: a.supplierCount,
    categoryCount: a.categoryCount,
    spendBySupplier: (report && report.spendBySupplier || []).map((s) => ({ supplier: s.standardSupplierName || s.lvmhSupplierId, spendEur: round2(s.spendEur), lines: s.lines })),
    spendByCategory: (report && report.spendByCategory || []).map((c) => ({ category: c.spendCategory, spendEur: round2(c.spendEur), lines: c.lines })),
    umbrellaCandidates: a.umbrellaCandidates.map((s) => ({ supplier: s.name, maisons: s.maisons, spendEur: s.spendEur })),
  };
}
