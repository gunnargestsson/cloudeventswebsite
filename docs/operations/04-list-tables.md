# Operation: List Tables (BC Metadata)

> **Action:** `listTables`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `listTables()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `ensureTableCatalog()`

---

## Purpose

Retrieve the full catalog of available BC tables from the Cloud Events API. Used to
populate the table picker dropdown when configuring a new mirror.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "listTables",
  "companyId": "company-guid"
}
```

## Response

```json
{
  "tables": [
    { "id": 18, "name": "Customer", "dataPerCompany": true },
    { "id": 27, "name": "Vendor", "dataPerCompany": true },
    { "id": 36, "name": "Sales Header", "dataPerCompany": true }
  ],
  "total": 450
}
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌─────────────────────┐
│  Browser  │──────▶│  Azure Function   │──────▶│  BC Cloud Events    │
│           │       │  /api/mirror      │       │  Help.Tables.Get    │
└──────────┘       └──────────────────┘       └─────────────────────┘
     │                     │                            │
     │  listTables         │                            │
     │─────────────────────▶                            │
     │                     │  POST /tasks               │
     │                     │  type: Help.Tables.Get     │
     │                     │────────────────────────────▶│
     │                     │                            │
     │                     │  { data: "https://..." }   │
     │                     │◀────────────────────────────│
     │                     │                            │
     │                     │  GET {data URL}            │
     │                     │────────────────────────────▶│
     │                     │                            │
     │                     │  [{ id, name, ... }, ...]  │
     │                     │◀────────────────────────────│
     │◀─────────────────────                            │
     │ { tables: [...] }   │                            │
```

## Backend Code

```javascript
async function listTables(conn, token, companyId, lcid) {
  const result = await bcTask(conn, token, companyId, "Help.Tables.Get", null, null);
  const tables = result.result || result.value || result.tables
    || (Array.isArray(result) ? result : []);
  return { tables, total: tables.length };
}
```

The operation uses the **synchronous task pattern** (`bcTask`):
1. POST a CloudEvent envelope to `/tasks` with `type: "Help.Tables.Get"`.
2. BC returns `{ data: "https://..." }` — a URL pointing to the result.
3. GET the result URL to retrieve the table catalog.

## BC API Details

**CloudEvent envelope sent to BC:**

```json
{
  "specversion": "1.0",
  "id": "random-uuid",
  "type": "Help.Tables.Get",
  "source": "BC Open Mirror"
}
```

**Response (from data URL):**

Each table object contains at minimum:
- `id` / `tableNo` — table number
- `name` / `tableName` — display name
- `dataPerCompany` — whether data is company-scoped

## Frontend Caching

The table catalog is cached in `state.tableCatalog` and loaded lazily:

```javascript
async function ensureTableCatalog() {
  if (state.tableCatalog.length > 0) return;
  const result = await api('listTables');
  state.tableCatalog = result.tables || [];
}
```

The catalog is fetched once per session and reused for the autocomplete dropdown
in the table configuration panel.

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Proxied via Management API: `GET /api/admin/sources/{sourceId}/tables`.
- Cached server-side (table catalogs rarely change).
- Each BC source has its own table catalog (different BC environments may have
  different tables based on installed extensions).
