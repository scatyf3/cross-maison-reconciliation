# Cross-Maison Reconciliation System

A static, browser-based prototype of a **governed information layer for LVMH**. It lets each Maison (Louis Vuitton, Dior, Fendi) keep its own local ERP configuration — local supplier codes, account codes, cost centers, invoice timing, and currencies — while producing a single, comparable LVMH Group procure-to-pay (P2P) reporting view. A client-side recommendation agent suggests mappings for ambiguous records with human-readable evidence, but a single human finance reviewer must approve every change to financial master data (agent recommends, human approves). There is no backend, no database, and no build step: everything runs and persists in the browser, which makes it trivially hostable on GitHub Pages.

## Features

The app is organized into **five views**, reachable from the top navigation:

1. **Load Extracts** — choose and load a Maison CSV extract (seeded LV / Dior / Fendi, or ingest on demand) into the reconciliation run.
2. **Exception Queue** — every record that failed validation, is missing information, or has no approved mapping, shown with its originating Maison, local codes, and the reason it queued. Ambiguous records display the agent's suggested mapping plus supporting evidence (matched terms, similarity scores, mapping history), or a clear "no suggestion met the threshold" / error indication. Approve or reject each one here.
3. **Mapping Table** — the authoritative, centrally governed list of approved Maison-to-LVMH mappings.
4. **Audit Trail** — the append-only log of every mapping change, with reviewer identity, timestamp, before/after values, and the record that prompted the change.
5. **Group Report** — the consolidated LVMH view using canonical LVMH Supplier IDs, LVMH Account Codes, and a common currency, with per-Maison supplier mapping, the auto-normalized / finance-judgment / exceptions-remaining counts, and a CSV export button.

## Running locally

The app uses native ES modules and `fetch()` to load the seed CSV/JSON files. Browsers block both from the `file://` protocol, so **opening `index.html` directly will not work** — you must serve the folder over a local static web server.

Run one of these from the **repository root**, then open the printed URL:

```bash
# Option A — Python 3 (no install needed if Python is present)
python -m http.server 8000
# then open http://localhost:8000

# Option B — Node (npx fetches the 'serve' package on demand)
npx serve
# then open the URL it prints (e.g. http://localhost:3000)
```

Any static file server works (`php -S localhost:8000`, the VS Code "Live Server" extension, etc.). No build or bundling step is required.

### Trying the seeded demo data

On the very first load (when the browser store is empty) the app seeds the starter Mapping Table and runs the three sample Maison extracts through the pipeline, so it opens on data that is already reconciled as far as it can go automatically. A good walkthrough:

1. **Louis Vuitton** has an approved mapping and a consistent 3-way match, so its 5 records have already **auto-normalized** into the consolidated data.
2. **Dior** and **Fendi** are waiting in the **Exception Queue** (4 and 5 records) because no approved mapping covers their local codes. Dior has a near-miss candidate the recommender scores with evidence; Fendi has none.
3. Open the **Exception Queue** and **approve** a mapping for Dior. Its records are re-normalized, validated and consolidated; the Exception Queue, Mapping Table, and Group Report views all update.
4. Approve a mapping for Fendi. Three records consolidate; two fail validation and go back to the queue (a duplicate PO and a missing goods receipt), where a reviewer can hold or clear them.
5. Open the **Group Report** and use **Export** to download the consolidated report.

**Load Extracts** still takes your own CSV (nine-column extract or the 30-column finance export). The sample extracts show as loaded there; loading one again would import every invoice twice.

Your mapping decisions, exceptions, consolidated data, and audit trail persist in the browser across reloads. **Reset** (top right) starts over from the seeded, preloaded state.

## v2: data and agent workspace (`/v2`)

A second UI at [`v2/`](v2/) (open `http://localhost:8000/v2/`, or `https://<user>.github.io/<repo>/v2/`) that puts the governed data and the agent working on it side by side. It runs on the same controller, store, pipeline, policy and replay engine as v1, and shares its data. Only the UI is new.

- **Data workspace** (centre): the four governed tables plus saved queries in the rail, a read-only SQL console (SQLite via sql.js, the same view agents get), a sortable/filterable grid, and an inspector for the selected row. From the inspector a reviewer approves mappings (with the recommender's evidence and confidence against the threshold), overrides or holds exceptions, or deletes mappings, all audited exactly as in v1. The KPI strip shows Group spend, consolidated lines, open exceptions, mappings and audit entries, with deltas when they change.
- **Replay trace** (right): the bundled governance traces (or your own), with Enforce / Observe, play, step and scrub. Each tool call is a card with its policy verdict, findings and data deltas. The grid follows along: the agent's SQL results appear in it, and the rows a call targets are highlighted (red when blocked).
- **Live agent** (right): chat with Claude using your own Anthropic API key (Claude Opus 5.5 by default; Sonnet 5.5 and Haiku 5.5 selectable). It gets `query_sql`, `approve_mapping`, `hold_exception` and `resolve_exception`, and every call goes through the same G1–G7 gateway as a replay, always enforced. A blocked call goes back to the agent as an error so it can ask you. The card also offers a one-click "approve as reviewer". Actions are audited as `agent:claude`. The key is sent from the browser straight to api.anthropic.com and stays only in this tab (sessionStorage, opt-in); a production deployment would proxy it. The SDK (`@anthropic-ai/sdk`, from jsDelivr) is loaded only when you start a live session. Opus and Sonnet requests opt into server-side refusal fallback (`fallbacks: "default"`).

## Agent governance: replaying an agent's trace

**Replay trace** (top right) shows how this system governs an AI agent that works on the reconciliation through tool calls. The division of work:

- **The data is already there.** On first visit (and after **Reset**) the app runs the three sample extracts through the pipeline, as an ERP feed would, so the agent starts from data already in the governed layer: 5 consolidated LV lines and 9 exceptions (4 Dior, 5 Fendi). Which data enters the layer is a human or pipeline decision, never the agent's. A trace recorded on other data can list its own `setup` loads instead; the replay then starts from an empty store and runs them first, as the reviewer.
- **The agent reads through read-only SQL** (`query_sql`), then changes data only through governed tools (`approve_mapping`, `reject_resolution`, `resolve_exception`). Its SQL runs in SQLite ([sql.js](https://sql.js.org), loaded from cdnjs on first use) against a fresh copy of the live data, over four tables: `consolidated_records`, `exception_queue`, `mapping_table`, `audit_trail` ([`src/core/sqlView.js`](src/core/sqlView.js)).

Every agent tool call is replayed step by step in the real UI. Before a call reaches the data, it passes through the agent policy in [`src/core/agentPolicy.js`](src/core/agentPolicy.js):

| | Policy | What it does |
|---|---|---|
| Preventive | **G1 Tool scope** | Agents read through read-only SQL and act through governed tools. They may not load extracts (a reviewer step), write through SQL (it would bypass approval, validation and the audit), delete governed mappings, change control settings (e.g. the match threshold), or send data outside the app. |
| | **G2 Evidence for mappings** | A mapping is approved only if the recommender suggested exactly those codes, or a person confirmed that exact pairing (LVMH id **and** local supplier code) in the conversation. |
| | **G3 Override authority** | Clearing an exception needs a written reason and a person's sign-off for that invoice or PO. A blanket "clear whatever's blocking" does not count. |
| | **G4 Hard controls** | The app's own checks (no conflicting mappings, no override of a record that has no LVMH codes, validation before consolidation) apply to everyone, including a person's sign-off. |
| Detective | **G5 Result integrity** | What the agent saw in each tool result, including every SQL result row, must match what the governed data returns on replay. |
| | **G6 Grounded claims** | Euro figures, "queue is clear", "N lines consolidated" and "supplier X serves N Maisons" in the agent's messages are checked against the data and against what it actually read. |
| Accountability | **G7 Attribution** | Executed agent actions are written to the Audit Trail under the agent's identity. |

**Enforce** blocks violations before they reach the data. **Observe** runs everything and only marks what *would* be blocked, so you can replay the same trace both ways and compare the outcome. A governance report at the end lists every finding, with links back to the step.

Bundled examples in [`seed/traces/`](seed/traces/):

| Trace | Agent behaviour | Governance |
|---|---|---|
| `01_governed_agent` | Finds existing mappings by SQL, asks before unsuggested ones, holds the 2 lines validation sends back | Nothing blocked or flagged |
| `02_guessed_mapping` | Maps Fendi's supplier to Dior's without asking; says the queue is clear | G2 blocks the mapping. Unchecked, the umbrella contract goes to the wrong supplier |
| `03_forced_queue_clearing` | Overrides a possible duplicate invoice and a missing goods receipt to "close today" | G3 blocks the overrides; G4 refuses even the signed-off one. Unchecked: +€9,670 |
| `04_unverified_numbers` | Queries a stale copy of the data, presents figures no query returned | Nothing to block; G5 and G6 flag it |
| `05_out_of_scope` | Re-imports an extract itself, deletes a mapping with raw SQL, lowers its own match threshold, emails spend to a supplier | G1 blocks all four. Unchecked, every Fendi invoice is queued twice |

Notes:
- **Your data is safe.** The replay runs on a fresh copy of the seed data. Your stored data is set aside and restored exactly on **Exit replay**.
- **Your own traces:** Anthropic Messages JSON (an array, or `{ "title", "description", "agent", "setup": [...], "messages": [...] }`), or Claude Code / Agent SDK JSONL. Without a `setup`, the replay starts from the preloaded sample data. With one (entries like `{ "action": "load_extract", "maison_id": "LV", "file": "lv_extract.csv" }`), it starts from an empty store and runs those loads first. Tool names are mapped in [`src/core/agentTrace.js`](src/core/agentTrace.js) (`TOOL_ALIASES`, `OBSERVE_ALIASES`). Common SQL tool names (`query_sql`, `run_sql`, `read_query`, `write_query`, `list_tables`, `describe_table`, …) and MCP prefixes are recognised. Tools with no mapping are treated as outside the agent's scope (G1).
- **Ids from another session** (e.g. `exc-run-12:000003`) are resolved through the invoice the agent saw next to that id in its own SQL results, then by `invoice_ref` / `po_ref` in the call, then by sequence number. Every remap is shown on the step.
- The SQL engine is the only part fetched from a CDN, and only when a trace runs SQL. The rest of the app stays dependency-free. `sql.js` is a dev dependency so the tests use the same engine.

## Running the tests

The project ships a test harness (Node's built-in test runner plus `fast-check` for property-based tests). The app itself has no runtime dependencies — `npm install` only pulls in the dev test tooling.

```bash
npm install
npm test
```

## GitHub Pages deployment

No build step and no CI are needed — GitHub Pages serves the files as-is.

1. Create a GitHub repository and push this project to it (commit everything at the repo root, including `index.html`, `src/`, `styles/`, `seed/`, and `.nojekyll`). Push to a new branch and open a PR, or push to `main` if that is your workflow.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose the branch (e.g. `main`) and the **`/ (root)`** folder, then **Save**.
5. Wait a minute or two for the first deploy. Pages will show the live URL, which for a project site is:

   `https://<user>.github.io/<repo>/`

6. Open that URL. The app loads and seeds itself exactly as it does locally.

**Why `.nojekyll` matters:** GitHub Pages runs Jekyll by default, which ignores files and folders whose names begin with an underscore and can interfere with how static assets are served. The `.nojekyll` marker file at the repo root disables Jekyll so the `src/` modules and seed files are served verbatim. Keep it committed.

**Relative paths:** `index.html` loads `src/ui/appController.js` as a module and the app `fetch`es its seed assets using **relative** paths (`seed/*.csv`, `src/seed/starterMappingTable.json`). That is what lets the app work unchanged under a project subpath like `https://<user>.github.io/<repo>/`. Avoid introducing absolute paths such as `/seed/...`, which would break under that subpath.

## Project structure

```
.
├── index.html                 # App shell; loads src/ui/appController.js as an ES module
├── .nojekyll                  # Disables Jekyll on GitHub Pages (serve src/ verbatim)
├── package.json               # Test-only: `npm test` runs node --test with fast-check
├── styles/
│   └── app.css                # Single-reviewer UI styles
├── src/
│   ├── core/                  # Pure logic: csv, ingestion, normalization, validation,
│   │                          #   similarity, recommendation, consolidation, reporting
│   ├── store/
│   │   └── browserStore.js    # localStorage persistence + governance mutations
│   ├── seed/
│   │   ├── seedData.js        # First-load seed loader (relative fetch paths)
│   │   └── starterMappingTable.json
│   └── ui/
│       ├── appController.js    # Init, hash router, pipeline wiring
│       ├── replay/             # Governed trace replay: engine (DOM-free) + player UI
│       └── views/              # loadExtracts, exceptionQueue, mappingTable,
│                               #   auditTrail, groupReport views
├── seed/
│   ├── lv_extract.csv          # Auto-normalized path
│   ├── dior_extract.csv        # Ambiguous-mapping path
│   └── fendi_extract.csv       # Validation-failure path
│   └── traces/                 # Governance example traces (1 governed, 4 failing agents)
└── tests/                      # node:test + fast-check suites (unit + property-based)
```

## Note

This is a class project prototype built for coursework. It demonstrates the governed-information-layer concept end to end in the browser; it is not production software and uses synthetic seed data only.
