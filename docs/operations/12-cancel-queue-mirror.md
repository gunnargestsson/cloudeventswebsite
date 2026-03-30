# Operation: Cancel Queue Mirror

> **Action:** `cancelQueueMirror`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `cancelQueueMirror()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `stopTableNow()`

---

## Purpose

Cancel a running BC queue task. Used when the user manually stops a mirror run or when
the frontend needs to abort in-flight operations.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "cancelQueueMirror",
  "companyId": "company-guid",
  "queueId": "queue-guid"
}
```

## Response

```json
{
  "status": "cancelled|none",
  "message": "Queue task cancelled"
}
```

## BC CancelTask Action

| HTTP Status | BC Meaning | Returned `status` |
|-------------|-----------|-------------------|
| **200** OK (Updated) | Task was cancelled successfully | `"cancelled"` |
| **204** No Content | No task to cancel or cancellation failed | `"none"` |

## Backend Code

```javascript
async function cancelQueueMirror(conn, token, companyId, queueId) {
  if (!queueId) throw new Error("queueId is required");

  const { tenantId, environment } = conn;
  const cancelPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0` +
    `/companies(${companyId})/queues(${queueId})/Microsoft.NAV.CancelTask`;

  const cancelResponse = await httpsJsonWithStatus(BC_HOST, cancelPath, "POST",
    { Authorization: `Bearer ${token}` }, null);

  if (cancelResponse.statusCode === 200) {
    return { status: "cancelled", message: "Queue task cancelled" };
  }
  return { status: "none", message: "No task to cancel or cancellation failed" };
}
```

## Frontend Stop Logic

When the user clicks "Stop" on a running table, the frontend cancels both BC queues
and aborts the local polling loop:

```javascript
async function stopTableNow(configId) {
  const running = state.runningConfigs.get(configId);
  if (!running) return;

  // Abort the local polling AbortController
  if (running.ac) running.ac.abort();

  // Cancel BC queues (fire-and-forget)
  if (running.queueId) {
    api('cancelQueueMirror', { queueId: running.queueId }).catch(() => {});
  }
  if (running.deletedQueueId) {
    api('cancelQueueMirror', { queueId: running.deletedQueueId }).catch(() => {});
  }

  // Clear queue state
  api('clearQueueState', { configId }).catch(() => {});

  state.runningConfigs.delete(configId);
  renderTables();
  addLog(`${t('Mirror run stopped')}: ${configId}`, 'warn');
}
```

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Cancellation is handled via Durable Functions `TerminateAsync`.
- Both BC queue cancellation and ADLS cleanup are coordinated.
- Audit log records who cancelled and why.
- Partial uploads are cleaned up automatically.
