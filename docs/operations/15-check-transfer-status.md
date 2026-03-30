# Operation: Check Transfer Status

> **Action:** `checkTransferStatus`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `checkTransferStatus()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `runTableNow()` (Step 4)

---

## Purpose

Poll the status of an asynchronous data transfer (BC → ADLS streaming). The frontend
calls this every 5 seconds after starting a transfer until completion or error.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "checkTransferStatus",
  "companyId": "company-guid",
  "transferId": "uuid",
  "configId": "uuid-of-table-config"
}
```

## Response (Running)

```json
{
  "status": "running",
  "totalBytes": 4194304,
  "lineCount": 12500
}
```

## Response (Completed)

```json
{
  "status": "completed",
  "tableId": 18,
  "tableName": "Customer",
  "mirroredRecords": 5000,
  "deletedRecords": 12,
  "filePath": "Customer/20250115_143022_456.csv",
  "endDateTime": "2025-01-15T14:30:22Z",
  "continueFromRecordId": null,
  "logs": ["Streamed CSV: 5000 records (2.1 MB)", "Streamed deleted: 12 records (0.1 MB)"]
}
```

## Response (Error)

```json
{
  "status": "error",
  "error": "BC CSV generation failed: timeout"
}
```

## Status Values

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `running` | Transfer in progress | Continue polling |
| `completed` | Transfer finished successfully | Process result |
| `error` | Transfer failed | Surface error to user |
| `not_found` | No transfer state for this config | Error: backend may have restarted |

## Backend Code

```javascript
async function checkTransferStatus(conn, token, companyId, transferId, configId) {
  if (!transferId && !configId) throw new Error("transferId or configId is required");

  const state = await getTransferState(conn, token, companyId);

  // Find by configId (preferred) or by scanning for transferId
  let key = configId;
  if (!key) {
    key = Object.keys(state).find(k => state[k].transferId === transferId);
  }
  if (!key || !state[key]) return { status: "not_found" };

  const t = state[key];

  // Discard entries older than 60 minutes (stale)
  const ageMs = new Date() - new Date(t.createdAt);
  if (ageMs > 60 * 60 * 1000) {
    await clearTransferState(conn, token, companyId, key);
    return { status: "not_found" };
  }

  if (t.status === "completed") {
    await clearTransferState(conn, token, companyId, key);
    return { status: "completed", ...(t.result || {}) };
  }

  if (t.status === "error") {
    await clearTransferState(conn, token, companyId, key);
    return { status: "error", error: t.error };
  }

  // Running: include in-memory progress if available
  return { status: "running", ...(_transferProgress[key] || {}) };
}
```

## State Persistence vs In-Memory Progress

| Data | Storage | Survives Instance Change |
|------|---------|--------------------------|
| Transfer status (running/completed/error) | BC `Cloud Events Storage` | Yes |
| Transfer result | BC `Cloud Events Storage` | Yes |
| Streaming progress (totalBytes, lineCount) | In-memory `_transferProgress` | No |

This means if SWA routes a `checkTransferStatus` poll to a different Azure Function
instance, the status and final result are available, but in-flight progress (bytes/lines)
shows as empty.

## Stale Entry Cleanup

Entries older than 60 minutes are automatically discarded:

```javascript
const ageMs = new Date() - new Date(t.createdAt);
if (ageMs > 60 * 60 * 1000) {
  await clearTransferState(conn, token, companyId, key);
  return { status: "not_found" };
}
```

## Frontend Polling Pattern

```javascript
// Step 4: Poll transfer status every 5 seconds for up to 60 minutes
let transferElapsed = 0;
const transferMaxWait = 60 * 60 * 1000;

while (transferElapsed < transferMaxWait) {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5000);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    runAc.signal.addEventListener('abort', onAbort, { once: true });
  });
  transferElapsed += 5000;

  const status = await api('checkTransferStatus', { transferId, configId });

  if (status.status === 'completed') {
    // Handle successful completion, check for continuation
    return status;
  }
  if (status.status === 'error') {
    throw new Error(`Data transfer failed: ${status.error}`);
  }
  if (status.status === 'not_found') {
    throw new Error('Transfer lost — backend may have restarted. Try again.');
  }

  // Progress logging every 30 seconds
  if (transferElapsed % 30000 === 0 && status.lineCount > 1) {
    const records = (status.lineCount - 1).toLocaleString();
    const mb = (status.totalBytes / (1024 * 1024)).toFixed(1);
    addLog(`Still transferring data... (${Math.floor(transferElapsed / 1000)}s) — ${records} records, ${mb} MB`);
  }
}
```

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Transfer status is tracked in Durable Functions entity state (no polling needed).
- Progress is available via real-time WebSocket connection.
- Status includes per-zone progress for multi-zone transfers.
- History of all transfers is queryable via Management API.
