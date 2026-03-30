# Operation: Check Queue Status

> **Action:** `checkQueueStatus`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `checkQueueStatus()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `runTableNow()` (Step 2)

---

## Purpose

Poll a BC queue task to determine whether CSV generation has completed. The frontend
calls this repeatedly at adaptive intervals until both the records queue and the
deleted records queue finish.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "checkQueueStatus",
  "companyId": "company-guid",
  "queueId": "queue-guid"
}
```

## Response

```json
{
  "status": "running|completed|deleted|error",
  "message": "Queue task is still running"
}
```

## Status Codes from BC

The BC Cloud Events Queue exposes a `GetStatus` OData action that returns HTTP status
codes to indicate task state:

| HTTP Status | Meaning | Returned `status` |
|-------------|---------|-------------------|
| **201** Created | Task is still running | `"running"` |
| **200** OK | Task completed | `"completed"` or `"error"` (see below) |
| **204** No Content | Task deleted or not found | `"deleted"` |
| **500** with "status code '0'" | Task cancelled or never started | `"deleted"` |

### Distinguishing Success from Error on HTTP 200

When BC returns HTTP 200 (completed), the backend reads the queue record to check
`datacontenttype`:

| `datacontenttype` | Meaning | Returned `status` |
|-------------------|---------|-------------------|
| `text/csv` | CSV generated successfully | `"completed"` |
| *(empty)* | Success, but no records | `"completed"` |
| `text/json` or `application/json` | BC error during CSV generation | `"error"` |

## Backend Code

```javascript
async function checkQueueStatus(conn, token, companyId, queueId) {
  if (!queueId) throw new Error("queueId is required");

  const { tenantId, environment } = conn;
  const getStatusPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0` +
    `/companies(${companyId})/queues(${queueId})/Microsoft.NAV.GetStatus`;

  let statusResponse;
  try {
    statusResponse = await httpsJsonWithStatus(BC_HOST, getStatusPath, "POST",
      { Authorization: `Bearer ${token}` }, null);
  } catch (err) {
    if (err.message && err.message.includes("status code '0'")) {
      return { status: "deleted", message: "Queue task was cancelled or never started" };
    }
    return { status: "error", message: `BC queue check failed: ${err.message.slice(0, 200)}` };
  }

  if (statusResponse.statusCode === 204) {
    return { status: "deleted", message: "Queue entry deleted or not found" };
  }

  if (statusResponse.statusCode === 200) {
    const queueRecordPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0` +
      `/companies(${companyId})/queues(${queueId})`;
    const queueRecord = await httpsJson(BC_HOST, queueRecordPath, "GET",
      { Authorization: `Bearer ${token}` }, null);
    const dataContentType = (queueRecord.datacontenttype || "").toLowerCase();

    if (dataContentType.includes("json")) {
      return { status: "error", message: "Queue task completed with error" };
    }
    return { status: "completed", message: "Queue task completed successfully" };
  }

  // 201 = still running
  return { status: "running", message: "Queue task is still running" };
}
```

## Frontend Polling Logic

The frontend polls both queues in parallel with adaptive intervals:

```javascript
// Adaptive poll interval: 10s for first 2 min, 30s for next 8 min, then 60s
function getPollInterval() {
  const elapsed = Date.now() - pollStartTime;
  if (elapsed < 2 * 60 * 1000) return 10000;   // 10s
  if (elapsed < 10 * 60 * 1000) return 30000;   // 30s
  return 60000;                                   // 60s
}

// Poll both queues in parallel
const polls = [];
if (!csvDone) polls.push(
  api('checkQueueStatus', { queueId }).then(r => ({ key: 'csv', ...r }))
);
if (!deletedDone) polls.push(
  api('checkQueueStatus', { queueId: deletedQueueId }).then(r => ({ key: 'deleted', ...r }))
);
const results = await Promise.all(polls);
```

### Abort-Aware Wait

Polling waits are cancellable via AbortController:

```javascript
await new Promise((resolve) => {
  const timer = setTimeout(resolve, interval);
  const onAbort = () => { clearTimeout(timer); resolve(); };
  runAc.signal.addEventListener('abort', onAbort, { once: true });
});
```

### Consecutive Error Tracking

```javascript
let consecutiveErrors = 0;
const maxConsecutiveErrors = 10;

for (const r of results) {
  if (r.error) {
    consecutiveErrors++;
    continue;
  }
  consecutiveErrors = 0; // Reset on any successful response
}

if (consecutiveErrors >= maxConsecutiveErrors) {
  throw new Error(`Giving up after ${consecutiveErrors} consecutive poll errors`);
}
```

### Maximum Wait Time

```javascript
const maxWaitMs = 12 * 60 * 60 * 1000; // 12 hours
if ((Date.now() - pollStartTime) >= maxWaitMs) {
  throw new Error(`CSV generation timed out after ${maxWaitMs / 3600000} hours`);
}
```

## Progress Logging

The frontend logs progress every ~60 seconds:

```javascript
const elapsedMs = Date.now() - pollStartTime;
const logEvery = interval < 60000 ? Math.max(1, Math.round(60000 / interval)) : 1;
const pollCount = Math.round(elapsedMs / interval);
if (pollCount % logEvery === 0) {
  const mins = Math.floor(elapsedMs / 60000);
  const secs = Math.floor((elapsedMs % 60000) / 1000);
  const pending = [!csvDone ? 'records' : null, !deletedDone ? 'deleted' : null]
    .filter(Boolean).join(', ');
  addLog(`Still generating CSV... (${mins}m ${secs}s elapsed, waiting for: ${pending})`);
}
```

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Polling is replaced by **Durable Functions** timer-based orchestration.
- BC queue status is checked by an activity function, not browser polling.
- Adaptive backoff is configurable per table.
- Timeout is configurable (not hardcoded to 12 hours).
- Status is exposed via Management API for monitoring dashboards.
