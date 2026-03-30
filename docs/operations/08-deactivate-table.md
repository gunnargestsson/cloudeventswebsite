# Operation: Deactivate Table

> **Action:** `deactivateTable`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `deactivateTable()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `toggleActivation()`

---

## Purpose

Deactivate a table so the scheduler stops including it in mirror runs. This is a soft
disable — the configuration remains intact and can be re-activated. No ADLS files or
metadata are deleted.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "deactivateTable",
  "companyId": "company-guid",
  "configId": "uuid-of-table-config"
}
```

## Response

```json
{
  "deactivated": true,
  "configId": "uuid",
  "tableId": 18
}
```

## Backend Code

```javascript
async function deactivateTable(conn, token, companyId, configId) {
  if (!configId) throw new Error("configId is required");
  const tables = await getStoredTables(conn, token, companyId);
  const idx = tables.findIndex((t) => t.configId === configId);
  if (idx < 0) throw new Error(`Config ${configId} is not configured`);
  tables[idx] = { ...normalizeTableConfig(tables[idx]), active: false };
  await setStoredTables(conn, token, companyId, tables);
  return { deactivated: true, configId, tableId: Number(tables[idx].tableId) };
}
```

## Auto-Disable

Tables can also be deactivated automatically after **5 consecutive errors**:

```javascript
const currentErrorCount = (state.tables[idx].errorCount || 0) + 1;
state.tables[idx].errorCount = currentErrorCount;

if (currentErrorCount >= 5 && state.tables[idx].active) {
  state.tables[idx].active = false;
  state.tables[idx].disabledReason = 'Auto-disabled after 5 consecutive errors';
  stopSchedulerForTable(configId);
}
```

When auto-disabled, `disabledReason` is set so the UI can show why the table was stopped.
The error count resets on the next successful mirror run.

## Differences: Manual vs Auto-Disable

| Aspect | Manual Deactivation | Auto-Disable |
|--------|---------------------|--------------|
| Trigger | User clicks toggle | 5 consecutive errors |
| `active` | `false` | `false` |
| `disabledReason` | `null` | `"Auto-disabled after 5 consecutive errors"` |
| `errorCount` | unchanged | preserved (cumulative) |
| Re-activation | User clicks toggle | User clicks toggle (resets error count) |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Deactivation is an API call that stops the Durable Functions orchestrator for that table.
- Auto-disable threshold is configurable per table (not hardcoded to 5).
- Alert fires when a table auto-disables (email, Teams, or Azure Monitor alert).
- Admin portal shows deactivation reason and error history.
