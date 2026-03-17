# Requirement 11: BC Open Mirror

## Status:  Specification  Ready for Implementation

---

## Overview

A standalone page (`bc-open-mirror.html`) at the same level as `bc-portal.html`,
`bc-metadata-explorer.html`, and `bc-cloud-events-explorer.html`. It reuses the same
connection and language infrastructure (`settings.js` / landing-page flow) as all other
pages.

**Goal:** Incrementally mirror Business Central table data to a **Microsoft Fabric Open
Mirroring** landing zone (ADLS Gen2) using `CSV.Records.Get`. Each configured table runs
on its own schedule (or manually). The Azure Function fetches from BC and uploads to ADLS
in a single server-side hop  the CSV never goes through the browser. All configuration is
stored encrypted in BC's `Cloud Events Storage` table. The `Cloud Events Integration`
table tracks the last successful mirror timestamp per table.

---

## Design Decisions (all confirmed)

| # | Decision | Answer |
|---|----------|--------|
| D1 | BC connection source | Same `settings.js` / landing-page flow as the other pages |
| D2 | Language selector | Same shared language setup as other pages |
| D3 | Config storage | `Cloud Events Storage` table (Source + Id PK, BLOB Data) |
| D4 | Config encryption | Server-side AES-256-GCM via `/api/mcp` `encrypt_data` / `decrypt_data` |
| D5 | Timestamp tracking | `Cloud Events Integration`, source `"BC Open Mirror"`, one row per tableId |
| D6 | Timestamp written before fetch | endDateTime = now1s written first; rolled back on failure |
| D7 | First-run startDateTime | Omitted  BC returns all historical records |
| D8 | Pre-fetch count check | `Data.Records.Get` with same date range + `take:1`; skip if `noOfRecords == 0` |
| D9 | Scheduler scope | Browser-based `setInterval` per table; runs only while page is open |
| D10 | Per-table interval | Configurable per table in minutes |
| D11 | Manual trigger | "Run Now" button per table (visible when Active) |
| D12 | Mirror destination type | **Microsoft Fabric Open Mirroring**  ADLS Gen2 service-principal auth |
| D13 | Mirror connection fields | `mirrorUrl`, `tenant`, `clientId`, `clientSecret` |
| D14 | CSV transit | **Server-side hop**  Function fetches from BC and uploads to ADLS; CSV never in browser |
| D15 | Multiple destinations | Single destination for v1 |
| D16 | Timestamp rollback on failure | `reverse_integration_timestamp` called on any run error |
| D17 | Active/inactive toggle | Per-table; config is **locked while Active** |
| D18 | Activation requires DDL upload | Every activation (and re-activation) sends Fabric Open Mirroring DDL |
| D19 | Mirror connection prerequisite | Connection must be verified before any table can be activated |
| D20 | Run log | Session-scoped, live-updating log panel on the page |

---

## Configuration Storage

All configuration stored in **`Cloud Events Storage`** with `Source = "BC Open Mirror"`:

| Config object | `Id` (GUID) | Encrypted | Contents |
|---|---|---|---|
| Mirror destination connection | `11111111-1111-1111-1111-000000000001` | Yes | `mirrorUrl`, `tenant`, `clientId`, `clientSecret`, `status` |
| Table & field configuration | `11111111-1111-1111-1111-000000000002` | No | Array of table config objects |

### Mirror Connection Config Object

```json
{
  "mirrorUrl":    "https://{account}.dfs.core.windows.net/{container}/{path}",
  "tenant":       "your-entra-tenant-id-or-domain",
  "clientId":     "service-principal-client-id",
  "clientSecret": "service-principal-client-secret",
  "status":       "verified"
}
```

`status` is `"verified"` after a successful test connection, `"unverified"` otherwise.
A table cannot be activated unless `status === "verified"`.

The ciphertext of this object is stored as a plain string in `Cloud Events Storage`
(the `set_config` call uses `encrypt: false` since the value is already AES-256-GCM
encrypted by `encrypt_data` before being passed to `set_config`).

### Table Config Array

Stored as a JSON array in the second Cloud Events Storage record:

```json
[
  {
    "tableId":      18,
    "tableName":    "Customer",
    "fieldNumbers": [1, 2, 5, 7, 35, 102],
    "tableView":    "WHERE(Blocked=CONST( ))",
    "intervalMin":  60,
    "active":       true
  },
  {
    "tableId":      27,
    "tableName":    "Item",
    "fieldNumbers": [],
    "tableView":    "",
    "intervalMin":  15,
    "active":       false
  }
]
```

`fieldNumbers: []` means all user-selectable fields (omitted from the BC API request — BC returns everything in range 1..1999999999).

**System fields (field numbers 0 and 2000000000–2000000004) are always appended automatically** by `CSV.Records.Get` and must never appear in `fieldNumbers`. They are added to the DDL unconditionally — see the Field Selection Rules section.

---

## Field Selection Rules

### Valid field number range

Only **Normal** fields with field numbers in the range **1..1999999999** are valid for user selection. **FlowFields are excluded** — `CSV.Records.Get` does not calculate FlowFields and they are silently skipped by BC. This is the range of application-defined Normal fields returned by `Help.Fields.Get` where `class === "Normal"`.

Field numbers outside this range are system-level and are handled automatically:

| Column | Field No. | Always included | Description |
|---|---|---|---|
| `Timestamp-0` | 0 | ✅ | Internal timestamp (BigInteger) |
| `SystemId-2000000000` | 2000000000 | ✅ | Record GUID — Fabric primary key |
| `SystemCreatedAt-2000000001` | 2000000001 | ✅ | Creation timestamp (UTC) |
| `SystemCreatedBy-2000000002` | 2000000002 | ✅ | Created by user GUID |
| `SystemModifiedAt-2000000003` | 2000000003 | ✅ | Last modified timestamp (UTC) — Fabric watermark |
| `SystemModifiedBy-2000000004` | 2000000004 | ✅ | Last modified by user GUID |

The `$Company` column is also always appended (before system fields) for per-company tables.

**These system columns must never appear in the `fieldNumbers` array in stored config.** The Add/Edit Table panel must reject any entry with a field number of `0` or `>= 2000000000`.

### Primary key indication in field picker

When the user opens the Add/Edit Table panel and loads fields for a table (via `get_table_fields`), each field is displayed with a **🔑** badge if `isPartOfPrimaryKey === true`. This helps the user understand which fields form the record identity — though PK fields are ordinary user-selectable fields (range 1..1999999999) and can be included or excluded from `fieldNumbers` freely.

> Note: The Fabric primary key for the mirrored table is always `SystemId-2000000000`, regardless of the BC table's own primary key. The BC primary key fields are informational — they help the user choose which fields to mirror.

### Behaviour in the Add/Edit panel

- The field picker loads all fields from `get_table_fields` for the chosen table.
- Fields are displayed as: `[🔑] No. (1) — Code 20` / `Name (2) — Text 100` etc.
- **FlowFields (`class === "FlowField"`) are not shown in the picker at all** — they are not supported by `CSV.Records.Get`.
- Fields of unsupported types (BLOB, Media, MediaSet, RecordId, OemCode, OemText, TableFilter) are shown greyed-out and cannot be selected.
- System fields (numbers outside 1..1999999999) are not shown in the picker at all.
- The user may select any subset of the valid fields, or leave all unchecked to mirror all Normal fields.
- Stored `fieldNumbers` contains only numbers in range 1..1999999999 belonging to Normal fields.

---

## Mirror Destination  ADLS Gen2 via Service Principal

The Azure Function authenticates to ADLS Gen2 using:
- `@azure/identity`  `ClientSecretCredential(tenant, clientId, clientSecret)`
- `@azure/storage-file-datalake`  `DataLakeFileClient` for file upload

### Landing Zone Path Structure

```
{mirrorUrl}/
  Tables/
    {tableName}/
      _metadata/
        DDL.json                         uploaded once on activation / re-activation
      {YYYY}/
        {MM}/
          {DD}/
            {YYYYMMDD_HHmmss_SSS}.csv    one file per successful mirror run
```

`{YYYYMMDD_HHmmss_SSS}` is the UTC `endDateTime` of the run, formatted for
chronological sort order. Files within a day are always ordered correctly.

---

## Fabric Open Mirroring Metadata (DDL)

When a table is **activated** (or **re-activated** after a config change), the page:

1. Calls `/api/mcp`  `get_table_fields` to retrieve all field definitions for the table.
2. Builds a DDL JSON object following the **Fabric Open Mirroring standard**.
3. Calls `/api/mirror` with `action: "upload-ddl"`  the function uploads the JSON to
   `{mirrorUrl}/Tables/{tableName}/_metadata/DDL.json` (overwrites any existing DDL).
4. Only if the upload succeeds is the table marked Active and the interval started.

### DDL Format

The DDL uses the `{strippedName}-{fieldNo}` column naming convention identical to
`CSV.Records.Get` output, so Fabric column names always match the CSV headers exactly.

```json
{
  "type": "FullInitialLoad",
  "schema": "dbo",
  "tableName": "Customer",
  "columns": [
    { "columnName": "No-1",   "columnDataType": "varchar", "columnLength": 20,  "isNullable": true,  "isPrimaryKey": false },
    { "columnName": "Name-2", "columnDataType": "varchar", "columnLength": 100, "isNullable": true,  "isPrimaryKey": false },
    { "columnName": "$Company",                   "columnDataType": "varchar", "columnLength": 250, "isNullable": true,  "isPrimaryKey": false },
    { "columnName": "Timestamp-0",                "columnDataType": "bigint",                       "isNullable": true,  "isPrimaryKey": false },
    { "columnName": "SystemId-2000000000",         "columnDataType": "uniqueidentifier",             "isNullable": false, "isPrimaryKey": true  },
    { "columnName": "SystemCreatedAt-2000000001",  "columnDataType": "datetime2",                    "isNullable": true,  "isPrimaryKey": false },
    { "columnName": "SystemCreatedBy-2000000002",  "columnDataType": "uniqueidentifier",             "isNullable": true,  "isPrimaryKey": false },
    { "columnName": "SystemModifiedAt-2000000003", "columnDataType": "datetime2",                    "isNullable": true,  "isPrimaryKey": false },
    { "columnName": "SystemModifiedBy-2000000004", "columnDataType": "uniqueidentifier",             "isNullable": true,  "isPrimaryKey": false }
  ],
  "primaryKey": ["SystemId-2000000000"],
  "watermarkColumn": "SystemModifiedAt-2000000003"
}
```

Data upload files (subsequent incremental runs) use `"type": "Incremental"` instead of
`"FullInitialLoad"`. Confirm exact enum values against the current
[Fabric Open Mirroring landing zone format docs](https://learn.microsoft.com/en-us/fabric/database/mirrored-database/open-mirroring-landing-zone-format)
during implementation.

#### BC Field Type  Fabric DDL Type Mapping

| BC Type | `columnDataType` | `columnLength` | Notes |
|---|---|---|---|
| Text[n] | `varchar` | n | |
| Code[n] | `varchar` | n | |
| Integer | `int` |  | |
| BigInteger | `bigint` |  | |
| Decimal | `decimal` | precision 38, scale 20 | |
| Boolean | `bit` |  | |
| Date | `date` |  | |
| Time | `time` |  | |
| DateTime | `datetime2` |  | |
| DateFormula | `varchar` | 250 | |
| Duration | `bigint` |  | Milliseconds |
| Guid | `uniqueidentifier` |  | |
| Option / Enum | `varchar` | 250 | Enum value name |
| BLOB, Media, MediaSet, RecordId | **omit** |  | Not in DDL or CSV |

System fields are always appended to every DDL regardless of `fieldNumbers`, with the
types shown in the example above. `$Company` is always included for per-company tables.

---

## Table States and Lifecycle

```
[Not configured]
         Add table (via "+ Add Table" panel)
[Inactive]           config editable, no scheduler
         Activate  (blocked if mirror connection not verified)
          1. Call get_table_fields via /api/mcp  field definitions
          2. Build DDL JSON
          3. POST /api/mirror { action: "upload-ddl" }
                failure: stay Inactive, show error
          4. Mark Active, lock config, start setInterval(runMirror, intervalMin * 60000)
[Active]             config locked (table, field numbers, filter)
                      intervalMin editable (resets setInterval)
         run fires (interval or Run Now)
[Active / Running]   spinner shown on row
         success or failure
[Active]             success: update last-run, append to log
[Active / Error]     failure: rollback timestamp, show error badge; scheduler keeps running
         Deactivate
[Inactive]           config editable again, setInterval cleared
                      Cloud Events Integration timestamp preserved (resumes on next activation)
```

---

## Timestamp Workflow (per-table mirror run)

```
Triggered by: setInterval or "Run Now" button

1. Read lastDateTime
   POST /api/explorer  { type: "Data.Records.Get", subject: "Cloud Events Integration",
                         data: { tableView: "WHERE(Source=CONST(BC Open Mirror),Table Id=CONST({tableId}),
                                             Reversed=CONST(false)) SORTING(Date & Time) ORDER(Descending)",
                                 take: 1 } }
    lastDateTime = records[0].primaryKey.DateTime  (null if no records)

   [OR call GET /api/explorer with get_integration_timestamp via cloud events /tasks]

2. endDateTime = new Date(Date.now() - 1000).toISOString()

3. WRITE timestamp
   POST /api/explorer  Data.Records.Set  Cloud Events Integration
   { Source: "BC Open Mirror", TableId: tableId, DateTime: endDateTime, Reversed: false }
    on write failure: abort + log error (nothing to reverse)

4. COUNT CHECK
   POST /api/explorer  Data.Records.Get  tableName
   { startDateTime: lastDateTime, endDateTime, take: 1, fieldNumbers: [1] }
    noOfRecords
   If noOfRecords === 0:
      log "Skipped  no records in range [lastDateTime  endDateTime]"
      done  (timestamp is kept as a heartbeat)

5. FETCH + PUSH
   POST /api/mirror  { action: "mirror-table",
                       bcConn, tableName, tableId,
                       fieldNumbers, tableView,
                       startDateTime: lastDateTime,    omitted on first run
                       endDateTime,
                       mirrorConn }
   Function internally:
     a. Authenticate to BC (OAuth2 client credentials)
     b. POST /tasks   CSV.Records.Get   response URL
     c. GET  response URL               raw CSV text
     d. Authenticate to ADLS Gen2 (ClientSecretCredential)
     e. Upload CSV  {mirrorUrl}/Tables/{tableName}/{YYYY}/{MM}/{DD}/{timestamp}.csv
     f. Return { recordCount, csvPath, bytesUploaded }

6a. SUCCESS
     update table card: last-run timestamp + record count
     append run-log row: time | table | N records |  | duration

6b. FAILURE  (any step in 5 throws)
     POST /api/explorer  reverse_integration_timestamp
      (finds latest non-reversed entry for "BC Open Mirror" + tableId, sets Reversed=true)
     update table card: error badge + message
     append run-log row: time | table |  | error message
     table state  Active / Error  (scheduler still running; next interval will retry)
```

---

## Azure Function `/api/mirror`  Action Reference

All actions: `POST /api/mirror` with JSON body.

### `"test-connection"`

```json
{
  "action": "test-connection",
  "mirrorConn": { "mirrorUrl": "...", "tenant": "...", "clientId": "...", "clientSecret": "..." }
}
```

Attempts to read properties of the ADLS Gen2 path using `ClientSecretCredential`.
Returns `{ ok: true }` or `{ ok: false, error: "..." }`.

### `"upload-ddl"`

```json
{
  "action": "upload-ddl",
  "mirrorConn": { ... },
  "tableName": "Customer",
  "ddl": { /* DDL object built by browser from get_table_fields result */ }
}
```

Uploads `ddl` as JSON to `{mirrorUrl}/Tables/{tableName}/_metadata/DDL.json`.
Returns `{ ok: true, path: "..." }` or `{ ok: false, error: "..." }`.

### `"mirror-table"`

```json
{
  "action":       "mirror-table",
  "bcConn":       { "tenantId": "...", "clientId": "...", "clientSecret": "...", "environment": "...", "companyId": "..." },
  "mirrorConn":   { "mirrorUrl": "...", "tenant": "...", "clientId": "...", "clientSecret": "..." },
  "tableName":    "Customer",
  "tableId":      18,
  "fieldNumbers": [1, 2, 5, 7],
  "tableView":    "WHERE(Blocked=CONST( ))",
  "startDateTime": "2026-03-17T10:00:00.000Z",
  "endDateTime":   "2026-03-17T14:29:59.000Z"
}
```

`startDateTime` is omitted on first run. `bcConn` is omitted in server mode (function
uses env vars). Returns `{ recordCount, csvPath, bytesUploaded }` or throws on error.

---

## Encrypt / Decrypt Flow (browser  /api/mcp)

**Save connection config:**

```javascript
// 1. Encrypt
const encRes = await mcpCall("encrypt_data", { plaintext: JSON.stringify(mirrorConn) });
// encRes.ciphertext is already encrypted  store it as a plain string (no double-encrypt)

// 2. Store in BC
await mcpCall("set_config", {
  source: "BC Open Mirror",
  id:     "11111111-1111-1111-1111-000000000001",
  data:   encRes.ciphertext,   // plain string storage
  encrypt: false
});
```

**Load connection config:**

```javascript
// 1. Read from BC
const cfg = await mcpCall("get_config", {
  source: "BC Open Mirror",
  id:     "11111111-1111-1111-1111-000000000001"
});
// cfg.data is the ciphertext string

// 2. Decrypt
const dec = await mcpCall("decrypt_data", { ciphertext: cfg.data });
const mirrorConn = JSON.parse(dec.plaintext);
// mirrorConn lives only in JS memory  never in localStorage
```

---

## Page Layout (wireframe)

```

   Home    BC Open Mirror                     [Language] [BC Status]

                                                                       
  
   MIRROR DESTINATION                    [Edit]  [Save & Verify]   
    ADLS URL:  https://account.dfs.core.windows.net/container/path 
    Tenant:    my-tenant.onmicrosoft.com                           
    Client ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx                
    Secret:                                            
    Status:     Verified                                          
  
                                                                       
  MIRROR TABLES                                        [+ Add Table]  
  
    Customer (18)        Every [60] min    Active   [ Run Now]   
    Fields: No., Name, Address, City (+4 more)                      
    Filter: WHERE(Blocked=CONST( ))                                 
    Last run: 2026-03-17 14:29  247 records                    
                                            [Deactivate]            
  
    Item (27)            Every [15] min    Inactive                
    Fields: all fields                                               
    Filter:                                                         
    Last run:     Not yet mirrored                                
                                  [ Edit]  [ Remove]  [Activate] 
  
                                                                       
  SESSION RUN LOG                                 [Clear]             
  
    14:29:59  Customer   247 records     0.8 s                    
    14:14:58  Item        0 records  skipped (none in range)       
    13:59:57  Customer    12 records     0.5 s                    
  

```

---

## Add / Edit Table Panel (modal)

| Field | Control | Editable when Active |
|---|---|---|
| Table name / number | Text input + Lookup button (`get_table_info`) | No |
| Fields | Multi-select list loaded from `get_table_fields`; only Normal fields (class = Normal, no. 1..1999999999) shown; FlowFields hidden; unsupported types (BLOB, Media, etc.) greyed-out; each entry shows field name, number, type, and 🔑 if part of BC primary key; blank selection = all Normal fields | No |
| Filter (`tableView`) | Text input, BC AL expression | No |
| Interval (min) | Number input, min 1, default 60 | Yes |

**Validation:** The panel rejects any manually-entered field number of `0` or `>= 2000000000`. System fields are always included by the API automatically and must not be in `fieldNumbers`.

The panel is disabled for Active tables (Deactivate first). The interval field is also
inline-editable on the table card while Active to allow quick adjustments.

---

## Navigation Card (index.html)

```html
<a href="bc-open-mirror.html" class="nav-card">
  <div class="nav-card-icon"></div>
  <div class="nav-card-title">Open Mirror</div>
  <div class="nav-card-desc">Mirror BC tables to Fabric ADLS landing zone</div>
</a>
```

---

## Translation Strings

```javascript
const UI_STRINGS = [
  "Mirror Destination",
  "Edit",
  "Save & Verify",
  "Mirror Tables",
  "Add Table",
  "Run Now",
  "Activate",
  "Deactivate",
  "Active",
  "Inactive",
  "Interval (minutes)",
  "Last run",
  "records",
  "Not yet mirrored",
  "Session Run Log",
  "Clear",
  "Skipped  no new records in range",
  "Table",
  "Fields (blank = all)",
  "Filter",
  "Save",
  "Cancel",
  "Remove",
  "Confirm remove?",
  "Connection verified",
  "Connection test failed",
  "Uploading schema to Fabric",
  "Schema uploaded  table is now active",
  "Mirror connection must be verified before activating a table",
  "Deactivate table before editing field configuration",
  "skipped",
  "bytes uploaded",
  "Open Mirror",
  "Mirror BC tables to Fabric ADLS landing zone",
];
```

---

## npm Dependencies (api/package.json additions)

```json
"@azure/identity": "^4.x",
"@azure/storage-file-datalake": "^12.x"
```

---

## Implementation Order

| Priority | Item |
|---|---|
|  1 | `api/package.json`  add `@azure/identity`, `@azure/storage-file-datalake` |
|  2 | `api/mirror/function.json` + `index.js` skeleton + `test-connection` action |
|  3 | `api/mirror/index.js`  `upload-ddl` action (DDL build + ADLS write) |
|  4 | `api/mirror/index.js`  `mirror-table` action (BC CSV fetch + ADLS upload, server-side hop) |
|  5 | `bc-open-mirror.html`  page scaffold,  Home, `settings.js` integration, language |
|  6 | Mirror Destination section  form, save/verify, encrypt/decrypt via MCP |
|  7 | Config load on page start (get_config + decrypt_data) |
|  8 | Add / Edit Table panel  modal, field lookup, `set_config` persist |
|  9 | Table card rendering (Active / Inactive / Error states) |
|  10 | Activation flow: get_table_fields  build DDL  upload-ddl  lock + start interval |
|  11 | Timestamp workflow: get/set/reverse via Cloud Events Integration |
|  12 | Mirror run function wiring (count check + mirror-table call) |
|  13 | Session Run Log panel  live append |
|  14 | "Run Now" button |
|  15 | Inline interval editing while Active |
|  16 | `index.html` nav card + `staticwebapp.config.json` route |
|  17 | Translation strings (Icelandic) |

---

## Minor Open Points (resolve during implementation)

| # | Question | Recommendation |
|---|---|---|
| M1 | Exact Fabric Open Mirroring DDL JSON field names | Validate against current [Microsoft docs](https://learn.microsoft.com/en-us/fabric/database/mirrored-database/open-mirroring-landing-zone-format) |
| M2 | `type` field for incremental data files after initial load | Likely `"Incremental"`  confirm from Fabric spec |
| M3 | `$Company` column  include in DDL? | Yes, always, as `varchar(250)` |
| M4 | When `fieldNumbers` is empty, DDL includes all Normal, non-BLOB / non-unsupported fields from `get_table_fields` (class = Normal, range 1..1999999999) + the 7 system columns. FlowFields are never included. | ✅ Confirmed |
| M5 | ADLS path for `test-connection`  use root container or `Tables/` prefix? | Use root; just authenticate and check access |
