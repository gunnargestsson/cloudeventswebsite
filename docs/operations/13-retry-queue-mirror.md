# Operation: Retry Queue Mirror

> **Action:** `retryQueueMirror`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `retryQueueMirror()`
> **Frontend:** Called indirectly via `fetchQueueData()` auto-retry

---

## Purpose

Retry a failed BC queue task. This is primarily used automatically during the data
transfer phase when BC reports a CSV generation error — the backend retries once before
giving up.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "retryQueueMirror",
  "companyId": "company-guid",
  "queueId": "queue-guid"
}
```

## Response

```json
{
  "status": "retried|none",
  "message": "Queue task retry initiated"
}
```

## BC RetryTask Action

| HTTP Status | BC Meaning | Returned `status` |
|-------------|-----------|-------------------|
| **200** OK (Updated) | Task was retried successfully | `"retried"` |
| **204** No Content | No task to retry or already running | `"none"` |

## Backend Code

```javascript
async function retryQueueMirror(conn, token, companyId, queueId) {
  if (!queueId) throw new Error("queueId is required");

  const { tenantId, environment } = conn;
  const retryPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0` +
    `/companies(${companyId})/queues(${queueId})/Microsoft.NAV.RetryTask`;

  const retryResponse = await httpsJsonWithStatus(BC_HOST, retryPath, "POST",
    { Authorization: `Bearer ${token}` }, null);

  if (retryResponse.statusCode === 200) {
    return { status: "retried", message: "Queue task retry initiated" };
  }
  return { status: "none", message: "No task to retry or already running" };
}
```

## Auto-Retry in fetchQueueData

When `fetchQueueData()` discovers a queue completed with `datacontenttype: text/json`
(BC error), it automatically attempts one retry:

```javascript
async function validateQueueResult(record, label, queueId) {
  const ct = (record.datacontenttype || "").toLowerCase();

  if (ct === "text/json" || ct === "application/json") {
    // BC had an error — retry once
    const retryResult = await retryQueueMirror(conn, token, companyId, queueId);
    
    if (retryResult.status === "retried") {
      await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds
      
      const statusCheck = await checkQueueStatus(conn, token, companyId, queueId);
      
      if (statusCheck.status === "running") {
        return { hasData: false, retrying: true }; // Signal to continue polling
      }
      if (statusCheck.status === "completed") {
        // Re-check the record
        const recheckRecord = await httpsJson(BC_HOST, `${queueBasePath}(${queueId})`, "GET", authHeaders, null);
        if ((recheckRecord.datacontenttype || "").toLowerCase() === "text/csv") {
          return { hasData: true, record: recheckRecord }; // Success!
        }
      }
    }
    
    // Download error details for logging
    throw new Error(`BC ${label} generation failed`);
  }
}
```

### Frontend Retry Loop

When the backend returns `status: "retrying"` from `startTransfer`, the frontend
re-enters the polling loop:

```javascript
if (transfer.status === 'retrying') {
  // Go back to polling the queue(s) until complete
  csvDone = false;
  deletedDone = !deletedQueueId;
  pollStartTime = Date.now(); // Reset poll timer
  // ... re-enters the polling loop
}
```

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Retry is handled by Durable Functions with configurable exponential backoff.
- Maximum retry count is configurable per table.
- Failed tasks are sent to a dead-letter store after max retries.
- Alert fires on repeated failures.
