# Operation: Start Queue Mirror

> **Action:** `startQueueMirror`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `startQueueMirror()`, `bcQueueSubmit()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `runTableNow()` (Step 1)

---

## Purpose

Submit two asynchronous BC queue tasks that generate CSV exports:

1. **`CSV.Records.Get`** — Modified/new records since the last sync.
2. **`CSV.DeletedRecords.Get`** — Deleted record IDs since the last sync.

Both queues run asynchronously in BC. The function returns immediately with queue IDs
that the frontend uses to poll status.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "startQueueMirror",
  "companyId": "company-guid",
  "configId": "uuid-of-table-config"
}
```

## Response

```json
{
  "tableId": 18,
  "tableName": "Customer",
  "queueId": "queue-guid-1",
  "deletedQueueId": "queue-guid-2",
  "logs": [
    "Starting queues for Customer...",
    "CSV queue started: queue-guid-1",
    "Deleted records queue started: queue-guid-2"
  ]
}
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌───────────────────────────┐
│  Browser  │       │  Azure Function   │       │  BC Cloud Events API       │
└──────────┘       └──────────────────┘       └───────────────────────────┘
     │                     │                            │
     │  startQueueMirror   │                            │
     │─────────────────────▶                            │
     │                     │                            │
     │                     │  1. Load connection + config│
     │                     │     (parallel)             │
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │                     │                            │
     │                     │  2. Get last sync timestamp│
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │                     │                            │
     │                     │  3. POST /queues           │
     │                     │     CSV.Records.Get        │
     │                     │     CSV.DeletedRecords.Get │
     │                     │     (parallel, fire & forget)│
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │                     │                            │
     │                     │  4. Persist queue state    │
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │◀─────────────────────                            │
     │  { queueId, deletedQueueId }                     │
```

## CSV Payload Construction

### Records Queue

```javascript
const csvPayload = {
  tableName: tableCfg.tableName,
  tableView: buildRunTableView(tableCfg),   // SORTING(SystemModifiedAt) ORDER(Ascending) WHERE(...)
  fieldNumbers: tableCfg.fieldNumbers.length ? tableCfg.fieldNumbers : undefined,
  startDateTime: previousTs,                 // null on first run → full export
  endDateTime: endIso,                       // now - 5 seconds
  lcid: lcid !== 1033 ? lcid : undefined,
};
```

### Deleted Records Queue

```javascript
const deletedPayload = {
  tableName: tableCfg.tableName,  // or tableNumber
  startDateTime: previousTs,
  endDateTime: endIso,
  lcid: lcid !== 1033 ? lcid : undefined,
};
```

### Table View Construction

```javascript
function buildRunTableView(tableCfg) {
  const suffix = tableCfg.tableView ? ` ${tableCfg.tableView}` : "";
  return `SORTING(SystemModifiedAt) ORDER(Ascending)${suffix}`;
}
```

Example output: `SORTING(SystemModifiedAt) ORDER(Ascending) WHERE(Blocked=CONST( ))`

## Continuation (Chunked Export)

When BC returns more records than fit in one batch, it sets `continueFromRecordId`
on the queue response. On continuation runs:

```javascript
const isContinuation = Boolean(tableCfg.continueFromRecordId);
const csvEnvelopeExtras = isContinuation
  ? { continueFromRecordId: tableCfg.continueFromRecordId }
  : undefined;
```

- Continuation runs **skip** the deleted records queue (already handled in first chunk).
- The `continueFromRecordId` is passed as a top-level envelope attribute on the queue submission.

## BC Queue Submission

```javascript
async function bcQueueSubmit(conn, token, companyId, messageType, subject, data, envelopeExtras) {
  const { tenantId, environment } = conn;
  const path = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues`;

  const payload = {
    type: messageType,
    source: SOURCE,
    ...(subject ? { subject } : {}),
    datacontenttype: "text/json",
    data: JSON.stringify(data),
    ...(envelopeExtras || {}),
  };

  const result = await httpsJson(BC_HOST, path, "POST", {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }, payload);

  return result.id;
}
```

The returned `id` is the queue GUID used for all subsequent operations (GetStatus, CancelTask, etc.).

## Queue State Persistence

Queue IDs are persisted to BC storage so the frontend can resume after reload/sleep:

```javascript
await saveQueueState(conn, token, companyId, configId, {
  queueId,
  deletedQueueId,
  tableName: tableCfg.tableName,
  tableId: tableCfg.tableId,
});
```

Stored at `CONFIG_QUEUE_STATE_ID` in `Cloud Events Storage`.

## Delta vs Full Export

| Scenario | `startDateTime` | `endDateTime` | Effect |
|----------|-----------------|---------------|--------|
| First run (no timestamp) | `null` | `now - 5s` | Full export of all records |
| Subsequent run | Last sync timestamp | `now - 5s` | Delta: only records modified since last sync |
| After initialization | `null` | `now - 5s` | Full export (timestamps were reversed) |
| Continuation | Last sync timestamp | Same as parent | Continues from `continueFromRecordId` |

The 5-second offset on `endDateTime` avoids race conditions with records being modified
during the export.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Connection not verified | Throws error before queue submission |
| Config not found | Throws error |
| BC queue submission fails | Exception propagated to caller |
| Network timeout | Caught by frontend `api()` retry (2 retries on 5xx) |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Queue submission is handled by a **Durable Functions orchestrator**.
- Multiple BC sources can be queued in parallel.
- Queue state is stored in Durable Functions entity state (not BC storage).
- Retry logic is built into the orchestrator with configurable backoff.
- Dead-letter handling for queues that never complete.
