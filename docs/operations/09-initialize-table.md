# Operation: Initialize Table (Reset Timestamps)

> **Action:** `initializeTable`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `initializeTable()`, `reverseAllIntegrationTimestamps()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `initializeTable()`

---

## Purpose

Reset a table's synchronization state so the next mirror run performs a **full export**
instead of a delta. This is done by marking all existing integration timestamps as
**Reversed** in BC's `Cloud Events Integration` table.

Use this when:
- A table's schema has changed and you need a clean re-export.
- Data corruption occurred in the landing zone.
- You want to re-baseline a table from scratch.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "initializeTable",
  "companyId": "company-guid",
  "configId": "uuid-of-table-config"
}
```

## Response

```json
{
  "initialized": true,
  "configId": "uuid",
  "tableName": "Customer",
  "reversedEntries": 12
}
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌────────────────────────────┐
│  Browser  │       │  Azure Function   │       │  BC Cloud Events            │
│           │       │  /api/mirror      │       │  Integration Table          │
└──────────┘       └──────────────────┘       └────────────────────────────┘
     │                     │                            │
     │  initializeTable    │                            │
     │─────────────────────▶                            │
     │                     │                            │
     │                     │  1. Load table config      │
     │                     │  2. Read all non-reversed  │
     │                     │     entries (up to 1000)   │
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │                     │  3. Set Reversed=true      │
     │                     │     for each entry          │
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │◀─────────────────────                            │
     │  { reversedEntries: 12 }                         │
```

## Integration Source Naming

Each table config has a unique integration source string:

```javascript
function integrationSource(tableName, configId) {
  return `${tableName}-${configId}`;
}
```

This source is used as the filter key when querying the `Cloud Events Integration` table.

## Backend Code

### Read and Reverse All Timestamps

```javascript
async function reverseAllIntegrationTimestamps(conn, token, companyId, tableCfg) {
  const allView = `SORTING(Source,Table Id,Date & Time) ORDER(Descending) WHERE(Source=CONST(${integrationSource(tableCfg.tableName, tableCfg.configId)}),Reversed=CONST(false))`;
  
  const result = await dataRecordsGet(conn, token, companyId, {
    tableName: CI_TABLE,
    tableView: allView,
    skip: 0,
    take: 1000,
  });
  
  const records = result.result || result.value || [];
  if (!records.length) return 0;

  const source = integrationSource(tableCfg.tableName, tableCfg.configId);
  await dataRecordsSet(conn, token, companyId, CI_TABLE, {
    mode: "modify",
    data: records.map((r) => ({
      primaryKey: {
        Source: source,
        TableId: Number(tableCfg.tableId),
        DateTime: String(r.primaryKey?.DateTime),
      },
      fields: { Reversed: "true" },
    })),
  });
  
  return records.length;
}
```

### Integration Table Structure

| Field | Type | Description |
|-------|------|------------|
| Source | Code | `{tableName}-{configId}` |
| Table Id | Integer | BC table number |
| Date & Time | DateTime | Timestamp when the sync ran |
| Reversed | Boolean | `false` = active, `true` = reversed |

The table view filter used:
```
SORTING(Source,Table Id,Date & Time) ORDER(Descending)
WHERE(Source=CONST(Customer-{uuid}),Reversed=CONST(false))
```

## Frontend Code

```javascript
async function initializeTable(configId) {
  const table = state.tables.find((t) => t.configId === configId);
  if (!table) return;
  
  const confirmed = await showConfirm(
    `${t('Initialize')} ${table.tableName}?`,
    t('This will reset all sync timestamps. The next mirror run will do a full export.')
  );
  if (!confirmed) return;
  
  const result = await api('initializeTable', { configId });
  
  // Reset local state
  table.lastRunAt = null;
  table.lastSuccessAt = null;
  table.continueFromRecordId = null;
  table.errorCount = 0;
  table.lastError = null;
  table.disabledReason = null;
  
  await api('saveTableConfigs', { tables: state.tables });
  renderTables();
  addLog(`${t('Initialized')}: ${table.tableName} (${result.reversedEntries} ${t('entries reversed')})`, 'ok');
}
```

## Side Effects

| Effect | Description |
|--------|-------------|
| All timestamps reversed | Next delta query returns no `startDateTime`, triggering full export |
| `lastRunAt` reset | UI shows table as "never run" |
| `continueFromRecordId` cleared | Any pending chunked export is abandoned |
| Error counters reset | Table can be re-activated if it was auto-disabled |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Initialization is a Management API operation with audit logging.
- Can optionally **purge** the landing zone folder before re-export.
- Supports per-table or bulk initialization (all tables for a source).
- Durable Functions orchestrator handles the full re-export workflow.
