# Operation: Save Table Configurations

> **Action:** `saveTableConfigs`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `saveTableConfigs()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `saveTable()`

---

## Purpose

Persist the full array of table mirror configurations to BC's `Cloud Events Storage` table.
Each configuration defines which BC table to mirror, which fields to include, the mirror
interval, table view filter, and activation status.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "saveTableConfigs",
  "companyId": "company-guid",
  "tables": [
    {
      "configId": "uuid",
      "tableId": 18,
      "tableName": "Customer",
      "dataPerCompany": true,
      "fieldNumbers": [1, 2, 3, 5, 7],
      "tableView": "WHERE(Blocked=CONST( ))",
      "intervalMin": 60,
      "active": true,
      "errorCount": 0,
      "lastError": null,
      "lastSuccessAt": null,
      "disabledReason": null,
      "continueFromRecordId": null
    }
  ]
}
```

## Response

```json
{
  "saved": true,
  "count": 1,
  "mirrors": [ /* normalized table configs */ ]
}
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌─────────────────────┐
│  Browser  │──────▶│  Azure Function   │──────▶│  BC Cloud Events    │
│           │       │  /api/mirror      │       │  Data.Records.Set   │
└──────────┘       └──────────────────┘       └─────────────────────┘
     │                     │                            │
     │  saveTableConfigs   │                            │
     │  tables: [...]      │                            │
     │─────────────────────▶                            │
     │                     │  1. Normalize each config  │
     │                     │  2. Serialize JSON array   │
     │                     │  3. Base64-encode           │
     │                     │  4. Upsert to Storage       │
     │                     │     (Id=CONFIG_TABLES_ID)   │
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │◀─────────────────────                            │
     │ { saved: true }     │                            │
```

## Table Configuration Schema

Each table config is normalized before storage:

```javascript
function normalizeTableConfig(table) {
  return {
    configId:             table.configId || crypto.randomUUID(),
    tableId:              Number(table.tableId),
    tableName:            String(table.tableName || ""),
    dataPerCompany:       Boolean(table.dataPerCompany),
    fieldNumbers:         Array.isArray(table.fieldNumbers)
                            ? table.fieldNumbers.map(Number).filter(n => n >= 1 && n <= 1999999999)
                            : [],
    tableView:            normalizeWhereFilter(table.tableView),
    intervalMin:          Math.max(1, Number(table.intervalMin || 60)),
    active:               Boolean(table.active),
    errorCount:           Number(table.errorCount) || 0,
    lastError:            table.lastError || null,
    lastSuccessAt:        table.lastSuccessAt || null,
    disabledReason:       table.disabledReason || null,
    continueFromRecordId: table.continueFromRecordId || null,
  };
}
```

| Field | Type | Description |
|-------|------|------------|
| `configId` | UUID | Unique identifier for this config (auto-generated if missing) |
| `tableId` | Integer | BC table number |
| `tableName` | String | Display name of the table |
| `dataPerCompany` | Boolean | Whether BC stores this table's data per-company |
| `fieldNumbers` | Integer[] | Field numbers to include (empty = all supported fields) |
| `tableView` | String | BC table view filter, e.g. `WHERE(Blocked=CONST( ))` |
| `intervalMin` | Integer | Mirror interval in minutes (minimum 1) |
| `active` | Boolean | Whether this mirror is enabled |
| `errorCount` | Integer | Number of consecutive errors since last success |
| `lastError` | String | Most recent error message |
| `lastSuccessAt` | String | ISO timestamp of last successful mirror run |
| `disabledReason` | String | Reason if auto-disabled (e.g. "5 consecutive errors") |
| `continueFromRecordId` | UUID | Continuation token for chunked exports |

## BC Storage Location

| Field | Value |
|-------|-------|
| Table | `Cloud Events Storage` |
| Source | `BC Open Mirror` |
| Id | `11111111-1111-1111-1111-000000000002` |
| Data | Base64-encoded JSON array of table configs |

Note: Unlike the connection, table configs are **not encrypted** (they contain no secrets).

## Frontend Save Logic

The frontend `saveTable()` function handles several workflows:

### New Config
```javascript
tables.push(config);
```

### Edit Existing Config
```javascript
tables.splice(existingIndex, 1, { ...existing, ...config, active: existing.active });
```

### Duplicate Table View Prevention
```javascript
const duplicateView = tables.find(row =>
  row.configId !== config.configId
  && Number(row.tableId) === Number(config.tableId)
  && (row.tableView || '') === (config.tableView || '')
);
if (duplicateView) throw new Error('Another config for this table already uses the same Table View.');
```

### Field Sync Across Siblings
When multiple configs exist for the same table (different table views), field selection
is synchronized:

```javascript
const siblings = tables.filter(row =>
  row.configId !== config.configId
  && Number(row.tableId) === Number(config.tableId)
);
if (siblings.length) {
  const activeSibling = siblings.find(s => s.active) || siblings[0];
  if (activeSibling.active) {
    config.fieldNumbers = [...(activeSibling.fieldNumbers || [])];
  } else {
    siblings.forEach(s => { s.fieldNumbers = [...(config.fieldNumbers || [])]; });
  }
}
```

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Configs stored in `TableConfig` SQL table instead of a JSON blob in BC storage.
- Each config links to a `sourceId` (BC source) and `zoneId` (landing zone).
- CRUD operations via RESTful Management API.
- Schema validation enforced by SQL constraints.
