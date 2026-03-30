# Operation: Activate Table

> **Action:** `activateTable`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `activateTable()`, `uploadDdl()`, `buildDdl()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `toggleActivation()`

---

## Purpose

Activate a configured table for mirroring. Activation performs two steps:

1. **Upload DDL metadata** (`_metadata.json`) to the ADLS landing zone so Fabric/Synapse
   can understand the CSV schema.
2. **Set `active: true`** in the persisted table configuration.

A table must be activated before the scheduler will include it in mirror runs.

## Prerequisites

- Mirror connection must exist and be **verified** (`status: "verified"`).
- Table config must already exist (created via save table configs).

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "activateTable",
  "companyId": "company-guid",
  "configId": "uuid-of-table-config"
}
```

## Response

```json
{
  "activated": true,
  "configId": "uuid",
  "tableId": 18,
  "tableName": "Customer"
}
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌─────────┐       ┌──────────┐
│  Browser  │       │  Azure Function   │       │   BC    │       │  ADLS    │
└──────────┘       └──────────────────┘       └─────────┘       └──────────┘
     │                     │                       │                   │
     │  activateTable      │                       │                   │
     │─────────────────────▶                       │                   │
     │                     │                       │                   │
     │                     │  1. Verify connection  │                   │
     │                     │  2. Load table configs │                   │
     │                     │  3. Help.Fields.Get    │                   │
     │                     │───────────────────────▶│                   │
     │                     │◀───────────────────────│                   │
     │                     │  4. buildDdl()         │                   │
     │                     │  5. Upload _metadata   │                   │
     │                     │───────────────────────────────────────────▶│
     │                     │◀───────────────────────────────────────────│
     │                     │  6. Set active=true    │                   │
     │                     │  7. Save configs to BC │                   │
     │                     │───────────────────────▶│                   │
     │◀─────────────────────                       │                   │
```

## DDL Metadata Schema

The `_metadata.json` file is uploaded to `<tableName>/_metadata.json` in the landing zone:

```json
{
  "keyColumns": ["systemId", "$Company"],
  "fileDetectionStrategy": "LastUpdateTimeFileDetection",
  "SchemaDefinition": {
    "Columns": [
      { "Name": "No", "DataType": "String", "IsNullable": true },
      { "Name": "Name", "DataType": "String", "IsNullable": true },
      { "Name": "BalanceLCY", "DataType": "Double", "IsNullable": true },
      { "Name": "timestamp", "DataType": "Int64", "IsNullable": true },
      { "Name": "systemId", "DataType": "String" },
      { "Name": "SystemCreatedAt", "DataType": "DateTime", "IsNullable": true },
      { "Name": "SystemCreatedBy", "DataType": "String", "IsNullable": true },
      { "Name": "SystemModifiedAt", "DataType": "DateTime", "IsNullable": true },
      { "Name": "SystemModifiedBy", "DataType": "String", "IsNullable": true },
      { "Name": "$Company", "DataType": "String" }
    ]
  },
  "fileFormat": "csv"
}
```

### Type Mapping

The `mapFabricType()` function maps BC field types to Fabric/Synapse types:

| BC Type | Fabric Type |
|---------|-------------|
| Text, Code, Option, DateFormula, Guid | String |
| Integer | Int32 |
| BigInteger, Duration | Int64 |
| Decimal | Double |
| Boolean | Boolean |
| Date | IDate |
| Time | ITime |
| DateTime | DateTime |
| Blob, Media, MediaSet, RecordId, TableFilter | *(excluded)* |

### System Columns

Every DDL includes these system columns after user-selected fields:

| Column | Type | Notes |
|--------|------|-------|
| `timestamp` | Int64 | BC rowversion |
| `systemId` | String | BC record GUID (part of key) |
| `SystemCreatedAt` | DateTime | |
| `SystemCreatedBy` | String | |
| `SystemModifiedAt` | DateTime | |
| `SystemModifiedBy` | String | |
| `ClosingDate` | Boolean | Only for table 17 (G/L Entry) |
| `$Company` | String | Only for `dataPerCompany: true` tables (also part of key) |

### Key Columns

```javascript
const keyColumns = tableCfg.dataPerCompany
  ? ["systemId", "$Company"]
  : ["systemId"];
```

### Field Name Washing

Column names are sanitized to remove non-alphanumeric characters (except `%`):

```javascript
function washName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9%]/g, "");
}
```

## Backend Code

```javascript
async function activateTable(conn, token, companyId, configId) {
  if (!configId) throw new Error("configId is required");
  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified") {
    throw new Error("Mirror connection must be verified before activation");
  }

  const tables = await getStoredTables(conn, token, companyId);
  const idx = tables.findIndex((t) => t.configId === configId);
  if (idx < 0) throw new Error(`Config ${configId} is not configured`);

  const tableCfg = normalizeTableConfig(tables[idx]);
  await uploadDdl(conn, token, companyId, connection, tableCfg);

  tableCfg.active = true;
  tables[idx] = tableCfg;
  await setStoredTables(conn, token, companyId, tables);

  return { activated: true, configId, tableId: tableCfg.tableId, tableName: tableCfg.tableName };
}
```

### DDL Upload

```javascript
async function uploadDdl(conn, token, companyId, connection, tableCfg) {
  const fields = await withTableRefFallback(tableCfg, (tableRef) =>
    getTableFields(conn, token, companyId, tableRef)
  );
  const resolvedTableName = resolveTableName(tableCfg, fields);
  const safeTableName = washName(resolvedTableName);
  const ddl = buildDdl({ ...tableCfg, tableName: resolvedTableName }, fields);
  const ddlPath = pathJoin(safeTableName, "_metadata.json");
  await uploadTextToMirror(connection, ddlPath, JSON.stringify(ddl, null, 2));
}
```

## Frontend Code

```javascript
async function toggleActivation(configId) {
  const table = state.tables.find((t) => t.configId === configId);
  if (!table) return;

  if (table.active) {
    // Deactivate
    await api('deactivateTable', { configId });
    table.active = false;
  } else {
    // Activate — uploads DDL and sets active=true
    await api('activateTable', { configId });
    table.active = true;
  }
  renderTables();
}
```

## Error Handling

| Scenario | Error | Resolution |
|----------|-------|------------|
| Connection not verified | `Mirror connection must be verified before activation` | Verify connection first |
| Config not found | `Config {id} is not configured` | Save table config first |
| Field fetch fails | BC API error | Check BC connectivity, table permissions |
| ADLS upload fails | Storage error | Check ADLS credentials, container permissions |
| Table ref fallback | Tries table name, then table ID | Handles renamed/aliased tables |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- DDL generation moves to a **Schema Manager** worker.
- DDL is versioned: each schema change creates a new `_metadata_v{n}.json`.
- Schema drift detection compares stored DDL with BC field definitions.
- Activation is an API call to the Management API, not a direct ADLS operation.
- Multi-zone: DDL is uploaded to all configured landing zones for the table.
