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

On the very first load (when the browser store is empty) the app seeds the starter Mapping Table and the three sample Maison extracts. A good walkthrough:

1. Go to **Load Extracts** and load the three seeded extracts.
2. **Louis Vuitton** has an approved mapping and a consistent 3-way match, so its records **auto-normalize** straight into the consolidated data.
3. **Dior** and **Fendi** land in the **Exception Queue** — Dior as an ambiguous mapping (a near-miss candidate the agent suggests with evidence), Fendi on the validation-failure path.
4. Open the **Exception Queue**, review the agent's suggestion and evidence for Dior, and **approve** the mapping. The record is re-normalized and leaves the queue; the Exception Queue, Mapping Table, and Group Report views all update to reflect the resolution.
5. Open the **Group Report** and use **Export** to download the consolidated report as CSV.

Your mapping decisions, exceptions, consolidated data, and audit trail persist in the browser across reloads. To start over from the seeded state, clear the site's local storage for the page.

### Agent governance: replaying an agent's trace

**Replay trace** (top right) shows how this system governs an AI agent that works on the reconciliation through tool calls. Pick a trace, and every tool call the agent made is replayed step by step in the real UI. Before a call reaches the data, it passes through the agent policy in [`src/core/agentPolicy.js`](src/core/agentPolicy.js):

| | Policy | What it does |
|---|---|---|
| Preventive | **G1 Tool scope** | Agents may load, read, approve evidenced mappings and put records on hold. They may not delete governed mappings, change control settings (e.g. the match threshold), or send data outside the app. |
| | **G2 Evidence for mappings** | A mapping is approved only if the recommender suggested exactly those codes, or a person confirmed that exact pairing (LVMH id **and** local supplier code) in the conversation. |
| | **G3 Override authority** | Clearing an exception needs a written reason and a person's sign-off for that invoice or PO. A blanket "clear whatever's blocking" does not count. |
| | **G4 Hard controls** | The app's own checks (no conflicting mappings, no override of a record that has no LVMH codes, validation before consolidation) apply to everyone, including a person's sign-off. |
| Detective | **G5 Result integrity** | What the agent saw in each tool result must match what the governed replay produces. |
| | **G6 Grounded claims** | Euro figures, "queue is clear", "N lines consolidated" and "supplier X serves N Maisons" in the agent's messages are checked against the data and against what it actually read. |
| Accountability | **G7 Attribution** | Executed agent actions are written to the Audit Trail under the agent's identity. |

**Enforce** blocks violations before they reach the data. **Observe** runs everything and only marks what *would* be blocked, so you can replay the same trace both ways and compare the outcome. A governance report at the end lists every finding, with links back to the step.

Bundled examples in [`seed/traces/`](seed/traces/):

| Trace | Agent behaviour | Governance |
|---|---|---|
| `01_governed_agent` | Asks before unsuggested mappings; holds the 2 lines validation sends back | Nothing blocked or flagged |
| `02_guessed_mapping` | Maps Fendi's supplier to Dior's without asking; says the queue is clear | G2 blocks the mapping. Unchecked, the umbrella contract goes to the wrong supplier |
| `03_forced_queue_clearing` | Overrides a possible duplicate invoice and a missing goods receipt to "close today" | G3 blocks the overrides; G4 refuses even the signed-off one. Unchecked: +€9,670 |
| `04_unverified_numbers` | Loads last month's file, presents figures it never read | Nothing to block; G5 and G6 flag it |
| `05_out_of_scope` | Lowers its own match threshold, deletes a governed mapping, emails spend to a supplier | G1 blocks all three |

Notes:
- **Your data is safe.** The replay runs on a fresh copy of the seed data. Your stored data is set aside and restored exactly on **Exit replay**.
- **Your own traces:** Anthropic Messages JSON (an array, or `{ "title", "description", "agent", "messages": [...] }`), or Claude Code / Agent SDK JSONL. Tool names are mapped in [`src/core/agentTrace.js`](src/core/agentTrace.js) (`TOOL_ALIASES`, `OBSERVE_ALIASES`). MCP prefixes and camelCase are normalized first. Tools with no mapping are treated as outside the agent's scope (G1).
- **Ids from another session** (e.g. `exc-run-12:000003`) are remapped from earlier load results, then by `invoice_ref` / `po_ref`, then by sequence number. Every remap is shown on the step.

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
