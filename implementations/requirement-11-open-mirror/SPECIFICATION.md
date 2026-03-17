# Requirement 11: BC Open Mirror

## Status: 📝 Specification — Awaiting Clarification

---

## Overview

A standalone page (`bc-open-mirror.html`) at the same level as `bc-portal.html`, `bc-metadata-explorer.html`, and `bc-cloud-events-explorer.html`. It reuses the same connection and language infrastructure (settings.js / landing page flow) as the other pages.

**Goal:** Read data from Business Central using `CSV.Records.Get` (one table at a time) and send it to a configured mirror destination, both on demand and on a per-table automatic schedule. All configuration — the mirror destination connection and the table/field selection — is stored encrypted in the BC `Cloud Events Storage` table. The `Cloud Events Integration` table is used to track the last successful mirror timestamp per table.

---

## Design Decisions (confirmed by user)

| # | Decision | Answer |
|---|----------|--------|
| D1 | BC connection source | Same settings.js / landing-page flow as the other pages |
| D2 | Language selector | Same shared language setup as other pages |
| D3 | Config storage | `Cloud Events Storage` table (Source + Id primary key, BLOB Data) |
| D4 | Config encryption | Encrypted on the server side before writing; decrypted on read |
| D5 | Timestamp tracking | `Cloud Events Integration` table, one entry per (`source`, `tableId`) pair |
| D6 | Timestamp `source` name | `"BC Open Mirror"` |
| D7 | Timestamp stored **before** the CSV fetch | ✅ — endDateTime = now − 1 s written first; rolled back on failure |
| D8 | First run startDateTime | Empty (omitted) — BC returns all records |
| D9 | Pre-fetch count check | `Data.Records.Get` with same period + `take: 1`, read `noOfRecords` |
| D10 | Scheduling scope | Browser-based per-table `setInterval`; scheduling only runs while the page is open |
| D11 | Per-table interval | Configurable per table (minutes) |
| D12 | Manual trigger | "Run Now" button per table |

---

## Open Questions — Need Answers Before Implementation

### Q1 — Mirror destination type (BLOCKER)

**What does the mirror destination look like?**

Options:
- **A** Microsoft Fabric Open Mirroring — ADLS Gen2 landing zone URL + SAS token. Data is written as CSV files under `/Tables/{tableName}/` in an Azure Data Lake Storage container. This is the native Fabric mirroring path.
- **B** Generic HTTP/REST endpoint — a URL that accepts HTTP POST with the CSV body (or JSON wrapper). Authentication via Bearer token or API key in a header.
- **C** Azure Blob Storage — storage account URL + SAS token; upload CSV blobs.
- **D** Other (please describe).

> **Why it matters:** Determines the connection fields the user must configure and what the backend proxy function needs to do with the data after fetching it.

---

### Q2 — Mirror connection configuration fields

Depending on the answer to Q1, the fields stored in `Cloud Events Storage` will differ. Proposed for **Fabric Open Mirroring (Option A)**:

| Field | Description |
|---|---|
| `landingZoneUrl` | ADLS Gen2 container URL (e.g. `https://{account}.dfs.core.windows.net/{container}`) |
| `sasToken` | Shared Access Signature token (stored encrypted) |
| `pathPrefix` | Optional prefix inside the container (default `/Tables`) |

Proposed for **Generic HTTP endpoint (Option B)**:

| Field | Description |
|---|---|
| `endpointUrl` | HTTP POST target URL |
| `authHeader` | Header name (e.g. `Authorization`) |
| `authValue` | Header value (e.g. `Bearer eyJ…`) — stored encrypted |
| `contentType` | Request body content type (default `text/csv`) |

**→ Please confirm which fields are needed, or describe the target system.**

---

### Q3 — Encryption mechanism

The mirror connection config is stored encrypted in BC. The encryption uses the server-side `MCP_ENCRYPTION_KEY` (AES-256-GCM) via the existing `/api/mcp` endpoint's `encrypt_data` / `decrypt_data` tools.

The browser page would call `POST /api/mcp` with `encrypt_data` / `decrypt_data` as part of the save/load flow. Is this acceptable, or should encryption go through a dedicated lighter endpoint?

Options:
- **A** Reuse `POST /api/mcp` — call `encrypt_data` / `decrypt_data` tools directly from the browser (simplest, no new function needed)
- **B** Add lightweight `POST /api/crypto` Azure Function — thin wrapper exposing only encrypt/decrypt (avoids MCP dependency)

---

### Q4 — What happens to the CSV data at the destination?

- **A** Always **append** — new records are appended to the destination on each run (tracking deletions is the destination's responsibility).
- **B** **Upsert by SystemId** — the page parses the CSV, groups by SystemId, and merges with the destination.
- **C** **Full replace per run** — the destination path is overwritten on each run.
- **D** The page's job is only to **HTTP POST the raw CSV**; the destination handles it.

> For Fabric Open Mirroring, Option D is standard: upload the CSV file to the landing zone and Fabric ingests it.

---

### Q5 — Error handling / timestamp rollback

When a mirror run fails after the timestamp has been written:

- **A** **Auto-rollback**: call `reverse_integration_timestamp` to undo the written timestamp, so the next run re-tries from the previous checkpoint.
- **B** **Keep the timestamp**: the run is considered attempted; data within that period may be lost but the pointer advances. Next run starts from the failed run's endDateTime.

> Recommendation: **Option A** — rollback on failure gives at-least-once delivery semantics.

---

### Q6 — Table/field configuration details

For each table the user adds to the mirror, they configure:

| Config field | Confirmed | Question |
|---|---|---|
| Table name or number | ✅ | — |
| Field numbers (subset, or all) | ✅ | Should "all fields" be the default if none are specified? |
| Mirror interval (minutes) | ✅ | What is the minimum interval? (e.g. 1 min, 5 min?) |
| Active / inactive toggle | ❓ | Should individual tables be pauseable without deleting the config? |
| Table alias / display name | ❓ | Do you want a free-text nickname for each table (e.g. "Customers-ISK") or just the BC table name? |
| Additional `tableView` filter | ❓ | Should the user be able to add a BC AL filter (e.g. `WHERE(Blocked=CONST( ))`) per table? |

---

### Q7 — Multiple mirror destinations

Is this page configured for a **single mirror destination** (one connection config, N tables), or should it support **multiple destinations** each with their own connection and table set?

- **A** Single destination — one encrypted connection block, one table list.
- **B** Multiple destinations — each destination has its own name, connection config, and table list.

> Recommendation: **Option A** for v1 — simpler to build and reason about. Multiple destinations can be a future requirement (Requirement 12).

---

### Q8 — First-run end boundary

On the **very first** run for a table (no timestamp stored yet):
- `startDateTime` is omitted (full history from BC).
- What should `endDateTime` be?
  - **A** `now − 1 second` (same as subsequent runs) — mirror all historical data up to now, then track going forward.
  - **B** `"2000-01-01T00:00:00Z"` to `now − 1 second` — same effect as A but explicit.

> Recommendation: **Option A** — omit `startDateTime`, use `now − 1 second` as `endDateTime`.

---

### Q9 — Scheduler persistence

Browser-based scheduling (setInterval) only runs while the page is open. Is this acceptable for v1?

- **A** ✅ Acceptable — user keeps the page open; tab stays alive.
- **B** Should scheduling survive page close — would require a server-side job (Azure Timer Function or similar) and is a significantly larger scope.

---

### Q10 — Run history / log

Should the page display a **log of past mirror runs** per table (timestamp, records mirrored, status, duration), or just a "last run" indicator?

- **A** Last-run summary only (timestamp + record count + status badge).
- **B** Full scrollable run log per table (last N runs in memory for the session).
- **C** Persistent run log (stored in `Cloud Events Storage`).

---

## Proposed Architecture

### Files

| File | Purpose |
|---|---|
| `bc-open-mirror.html` | Full-page mirror UI |
| `api/mirror/function.json` | Azure Function binding |
| `api/mirror/index.js` | Proxy: fetch CSV from BC + forward to mirror destination + encrypt/decrypt config |
| `staticwebapp.config.json` | Add route `/bc-open-mirror` → `bc-open-mirror.html` |
| `index.html` | Add "Open Mirror" nav card |

### Azure Function: `/api/mirror`

Handles:
1. **`action: "fetch-csv"`** — receives BC connection headers + message params → calls BC `/tasks` with `CSV.Records.Get` → returns raw CSV to browser
2. **`action: "push-mirror"`** — receives raw CSV + mirror connection config → forwards to mirror destination → returns result
3. **`action: "encrypt"`** / **`"decrypt"`** — thin wrapper around the AES-256-GCM key (if reusing server-side key rather than calling `/api/mcp`)

Alternatively, steps 1+2 can be combined: the function fetches from BC and immediately pushes to the destination without the raw CSV ever going through the browser (better for large tables).

**→ Q11: Should the CSV transit through the browser (browser downloads it then uploads it), or should the Azure Function fetch from BC and push to the destination in a single server-side hop?**

---

## Configuration Storage (confirmed GUIDs)

All config stored in **`Cloud Events Storage`** table:

| Config | `Source` | `Id` (GUID) | Encrypted |
|---|---|---|---|
| Mirror destination connection | `BC Open Mirror` | `11111111-1111-1111-1111-000000000001` | ✅ Yes |
| Table & field configuration | `BC Open Mirror` | `11111111-1111-1111-1111-000000000002` | No (not sensitive) |

---

## Timestamp Workflow (per table)

```
Run triggered (manual or scheduled):
  1. lastDateTime = get_integration_timestamp("BC Open Mirror", tableId) → may be null (first run)
  2. endDateTime  = new Date(Date.now() - 1000).toISOString()
  3. WRITE: set_integration_timestamp("BC Open Mirror", tableId, endDateTime)
  4. CHECK: Data.Records.Get(tableName, startDateTime=lastDateTime, endDateTime, take=1)
            → noOfRecords
     If noOfRecords == 0: skip (nothing to mirror), done
  5. FETCH: CSV.Records.Get(tableName, fieldNumbers, startDateTime=lastDateTime, endDateTime)
  6. PUSH: send CSV to mirror destination
  7a. SUCCESS: update UI — "Last mirrored: {endDateTime}, {count} records"
  7b. FAILURE: reverse_integration_timestamp("BC Open Mirror", tableId) → roll back to lastDateTime
              update UI — "Error: {message}"
```

> Note: For the first run, step 3 records `endDateTime`. Step 4 checks `startDateTime = null` (all records). Step 5 fetches all records.

---

## Layout (proposed)

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Home   🪞 BC Open Mirror                  [Language] [Status] │
├──────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  MIRROR DESTINATION  [Edit] [Test Connection]               │ │
│  │  Endpoint: https://...   Status: ● Connected                │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  MIRROR TABLES  [+ Add Table]                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  Customer (18)                    Interval: 60 min  [▶ Run Now] │
│  │  Fields: No., Name, Address, City (+4 more)  Active: ●      │ │
│  │  Last run: 2026-03-17 14:30  •  247 records  •  ✅ OK       │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │  Item (27)                        Interval: 15 min  [▶ Run Now] │
│  │  Fields: No., Description, Unit Price (+2 more)  Active: ●  │ │
│  │  Last run: –  •  Not yet mirrored                           │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  RUN LOG (session)                                                │
│  14:30:02  Customer  →  247 records  ✅  0.8 s                   │
│  14:15:01  Item      →  0 records (skipped)                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Table Configuration Panel (Add / Edit)

A modal or slide-in panel with:

| Field | Control | Notes |
|---|---|---|
| Table | Text input with BC table lookup / autocomplete | Resolved to table number via `Help.Tables.Get` |
| Fields | Multi-select or comma-separated field numbers | Blank = all fields |
| `tableView` filter | Text input | Optional BC AL filter expression |
| Mirror interval | Number input (minutes) | Per-table; minimum TBD (see Q6) |
| Active | Toggle | Start/stop auto-scheduling for this table |
| Display name | Text input | Optional friendly name (see Q6) |

---

## Translation strings (provisional)

```javascript
const UI_STRINGS = [
  "Mirror Destination",
  "Edit",
  "Test Connection",
  "Mirror Tables",
  "Add Table",
  "Run Now",
  "Active",
  "Interval (minutes)",
  "Last run",
  "records",
  "Not yet mirrored",
  "Run Log",
  "Success",
  "Skipped (no records)",
  "Error",
  "Connecting…",
  "Saving configuration…",
  "Loading configuration…",
  "Table",
  "Fields",
  "Filter",
  "Display name",
  "Save",
  "Cancel",
  "Delete table",
  "Confirm delete?",
  "Nothing to mirror — no new records in range",
  "Connection saved",
  "Connection test failed",
];
```

---

## Implementation Order (draft — pending answers)

| Priority | Item | Blocked by |
|---|---|---|
| 🔴 High | §Q1 — Mirror destination type | User answer |
| 🔴 High | §Q2 — Connection fields | Q1 |
| 🔴 High | §Q3 — Encryption mechanism | Q1 |
| 🔴 High | §Q11 — Server-side vs browser-side CSV transit | Q1 |
| 🟡 Medium | Config storage (Cloud Events Storage read/write) | None |
| 🟡 Medium | Timestamp workflow (Cloud Events Integration) | None |
| 🟡 Medium | Table config panel (add/edit/delete tables) | Q6 |
| 🟡 Medium | Manual "Run Now" trigger | Q4 |
| 🟢 Low | Per-table interval scheduler | Q9 |
| 🟢 Low | Run log display | Q10 |
| 🟢 Low | Translation strings (Icelandic) | After UI finalized |
