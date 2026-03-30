# Operation: Get Table Fields (BC Metadata)

> **Action:** `getTableFields`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `getTableFieldsAction()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `loadFields()`

---

## Purpose

Retrieve the field definitions for a specific BC table. Used to populate the field picker
when configuring which columns to include in a mirror, and to generate the DDL
(`_metadata.json`) for Fabric Open Mirroring.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "getTableFields",
  "companyId": "company-guid",
  "table": "Customer"
}
```

The `table` parameter can be a **table name** (e.g. `"Customer"`) or a **table number**
(e.g. `"18"`). The backend tries the first form; if it fails, falls back to the second
via `withTableRefFallback`.

## Response

```json
{
  "fields": [
    { "number": 1, "name": "No.", "type": "Code", "class": "Normal", "tableName": "Customer" },
    { "number": 2, "name": "Name", "type": "Text", "class": "Normal", "tableName": "Customer" },
    { "number": 3, "name": "Search Name", "type": "Code", "class": "Normal", "tableName": "Customer" }
  ],
  "fieldCount": 185
}
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌─────────────────────┐
│  Browser  │──────▶│  Azure Function   │──────▶│  BC Cloud Events    │
│           │       │  /api/mirror      │       │  Help.Fields.Get    │
└──────────┘       └──────────────────┘       └─────────────────────┘
     │                     │                            │
     │  getTableFields     │                            │
     │  table: "Customer"  │                            │
     │─────────────────────▶                            │
     │                     │  POST /tasks               │
     │                     │  type: Help.Fields.Get     │
     │                     │  subject: "Customer"       │
     │                     │────────────────────────────▶│
     │                     │                            │
     │                     │  { data: "https://..." }   │
     │                     │◀────────────────────────────│
     │                     │                            │
     │                     │  GET {data URL}            │
     │                     │────────────────────────────▶│
     │                     │                            │
     │                     │  [{ number, name, type }]  │
     │                     │◀────────────────────────────│
     │◀─────────────────────                            │
     │ { fields: [...] }   │                            │
```

## Backend Code

```javascript
async function getTableFieldsAction(conn, token, companyId, tableRef, lcid) {
  if (!tableRef) throw new Error("Parameter 'table' is required");
  const result = await bcTask(conn, token, companyId, "Help.Fields.Get", String(tableRef), null);
  const fields = result.result || result.value || (Array.isArray(result) ? result : []);
  return { fields, fieldCount: fields.length };
}
```

### Table Reference Fallback

When the result is consumed internally (e.g. during DDL generation), the system tries
multiple table reference formats:

```javascript
async function withTableRefFallback(tableCfg, callback) {
  const refs = [];
  if (tableCfg.tableName) refs.push(tableCfg.tableName);  // try name first
  if (tableCfg.tableId > 0) refs.push(String(tableCfg.tableId));  // then ID

  for (const ref of refs) {
    try { return await callback(ref); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}
```

## Field Properties

Each field object returned by BC includes:

| Property | Type | Description |
|----------|------|------------|
| `number` / `fieldNo` / `no` | Integer | Field number (1–1999999999) |
| `name` / `caption` | String | Display name |
| `type` | String | AL data type: `Text`, `Code`, `Integer`, `Decimal`, `Boolean`, `Date`, `DateTime`, etc. |
| `class` | String | `Normal`, `FlowField`, `FlowFilter` — only `Normal` fields are mirrorable |

## Frontend Field Picker

```javascript
async function loadFields({ tableId, tableName } = {}) {
  const ref = tableName || String(tableId);
  const payload = await api('getTableFields', { table: ref });
  const fields = payload.fields || payload.result || payload;
  state.fieldCache.set(tableId, fields);
  renderFieldPicker();
}
```

The field picker allows selecting specific fields to include in the mirror. If "All Fields"
is checked, the `fieldNumbers` array is left empty (meaning all supported fields are included).

Fields are cached per table ID in `state.fieldCache` to avoid redundant API calls.

## DDL Type Mapping

Fields are mapped to Fabric Open Mirroring types during DDL generation:

| BC Type | Fabric Type |
|---------|-------------|
| `Text`, `Code`, `Option`, `DateFormula`, `Guid` | `String` |
| `Integer` | `Int32` |
| `BigInteger`, `Duration` | `Int64` |
| `Decimal` | `Double` |
| `Boolean` | `Boolean` |
| `Date` | `IDate` |
| `Time` | `ITime` |
| `DateTime` | `DateTime` |

Fields that don't map to a Fabric type are excluded from the DDL.

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Proxied via Management API: `GET /api/admin/sources/{sourceId}/tables/{tableRef}/fields`.
- Field metadata cached in the control plane database for DDL generation.
- Same BC API call (`Help.Fields.Get`) — no BC-side changes required.
