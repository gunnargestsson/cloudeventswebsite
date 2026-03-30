# Operation: Run Table Now (Full Orchestrated Run)

> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `runTableNow()`
> **Backend Actions Used:** `startQueueMirror`, `checkQueueStatus`, `startTransfer`, `checkTransferStatus`

---

## Purpose

Execute a complete mirror run for a single table by orchestrating four backend operations
in sequence. This is the primary operation triggered by the scheduler and by the user
clicking "Run Now" on a table.

## The 4-Step Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     runTableNow(configId)                           │
│                                                                     │
│  Step 1: startQueueMirror ──▶ queueId, deletedQueueId             │
│                                                                     │
│  Step 2: poll checkQueueStatus (adaptive interval)                 │
│          ┌──▶ 10s intervals (0–2 min)                              │
│          ├──▶ 30s intervals (2–10 min)                             │
│          └──▶ 60s intervals (10+ min)                              │
│          Max wait: 12 hours                                         │
│                                                                     │
│  Step 3: startTransfer ──▶ transferId (fire-and-forget)            │
│                                                                     │
│  Step 4: poll checkTransferStatus (every 5s)                       │
│          Max wait: 60 minutes                                       │
│                                                                     │
│  ──▶ Update config (timestamps, error counts)                      │
│  ──▶ Handle continuation (re-trigger after 10s)                    │
└─────────────────────────────────────────────────────────────────────┘
```

## Sequence Diagram

```
┌──────────┐     ┌───────────────────┐     ┌──────────┐     ┌────────┐
│  Browser  │     │  Azure Function    │     │    BC    │     │  ADLS  │
└──────────┘     └───────────────────┘     └──────────┘     └────────┘
     │                    │                      │               │
     │  1. startQueueMirror                      │               │
     │───────────────────▶│                      │               │
     │                    │  Submit CSV queues    │               │
     │                    │─────────────────────▶│               │
     │◀───────────────────│  { queueId }         │               │
     │                    │                      │               │
     │  2. checkQueueStatus (poll loop)          │               │
     │───────────────────▶│  GetStatus           │               │
     │                    │─────────────────────▶│               │
     │◀───────────────────│  "running"           │               │
     │  ... poll ...      │                      │               │
     │───────────────────▶│  GetStatus           │               │
     │                    │─────────────────────▶│               │
     │◀───────────────────│  "completed"         │               │
     │                    │                      │               │
     │  3. startTransfer                         │               │
     │───────────────────▶│                      │               │
     │◀───────────────────│  { transferId }      │               │
     │                    │  (background)        │               │
     │                    │  Stream CSV ─────────▶│  GET data    │
     │                    │                      │◀──────────────│
     │                    │  Upload chunks ───────────────────────▶│
     │                    │                      │               │
     │  4. checkTransferStatus (poll every 5s)   │               │
     │───────────────────▶│                      │               │
     │◀───────────────────│  "running" + progress│               │
     │  ... poll ...      │                      │               │
     │───────────────────▶│                      │               │
     │◀───────────────────│  "completed" + result│               │
     │                    │                      │               │
     │  Update local config state                │               │
```

## Concurrency Control

Before starting, the function acquires two slots:

```javascript
// Global concurrency: max N tables running simultaneously
state.activeMirrorCount++;

// Per-table: only one config per BC table at a time
state.activeTableIds.add(tableId);

// Track this config as running
state.runningConfigs.set(configId, { startedAt, ac, queueId, deletedQueueId });
```

## Abort Support

Every step is abort-aware via AbortController:

```javascript
const runAc = new AbortController();
state.runningConfigs.set(configId, { ac: runAc, ... });

// All waits respect the abort signal
await new Promise((resolve) => {
  const timer = setTimeout(resolve, interval);
  const onAbort = () => { clearTimeout(timer); resolve(); };
  runAc.signal.addEventListener('abort', onAbort, { once: true });
});
if (runAc.signal.aborted) return null;
```

## Error Tracking and Auto-Disable

```javascript
catch (error) {
  const currentErrorCount = (state.tables[idx].errorCount || 0) + 1;
  state.tables[idx].errorCount = currentErrorCount;
  state.tables[idx].lastError = error.message;

  // Auto-disable after 5 consecutive errors
  if (currentErrorCount >= 5 && state.tables[idx].active) {
    state.tables[idx].active = false;
    state.tables[idx].disabledReason = 'Auto-disabled after 5 consecutive errors';
    stopSchedulerForTable(configId);
  }

  // Persist error state
  await api('saveTableConfigs', { tables: state.tables });
}
```

## Continuation Handling

When BC returns `continueFromRecordId`:

```javascript
const hasContinuation = result.continueFromRecordId
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.continueFromRecordId);

if (hasContinuation) {
  // Store continuation token, do NOT update lastRunAt
  state.tables[idx].continueFromRecordId = result.continueFromRecordId;
} else {
  // Final chunk — clear continuation, update timestamps
  state.tables[idx].continueFromRecordId = null;
  state.tables[idx].lastRunAt = runEndTime;
  state.tables[idx].lastSuccessAt = runEndTime;
}
```

The scheduler detects continuation and re-triggers after 10 seconds instead of waiting
the full interval.

## Success Path

On successful completion:

1. Error count and error message are reset.
2. `lastRunAt` and `lastSuccessAt` updated (unless continuation pending).
3. Config saved to backend.
4. UI re-renders with updated status.
5. Metrics refreshed.

## Return Value

```javascript
return {
  tableId: 18,
  tableName: "Customer",
  mirroredRecords: 5000,
  deletedRecords: 12,
  filePath: "Customer/20250115_143022_456.csv",
  endDateTime: "2025-01-15T14:30:22Z",
  continueFromRecordId: null,  // or GUID for continuation
  logs: [...]
};
```

## Related Operations

| Step | Operation | Document |
|------|-----------|----------|
| 1 | Submit BC queues | [10-start-queue-mirror.md](./10-start-queue-mirror.md) |
| 2 | Poll queue status | [11-check-queue-status.md](./11-check-queue-status.md) |
| 3 | Start ADLS transfer | [14-start-transfer.md](./14-start-transfer.md) |
| 4 | Poll transfer status | [15-check-transfer-status.md](./15-check-transfer-status.md) |
| Cancel | Stop running table | [12-cancel-queue-mirror.md](./12-cancel-queue-mirror.md) |
| Retry | Auto-retry on error | [13-retry-queue-mirror.md](./13-retry-queue-mirror.md) |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- The 4-step flow is a **Durable Functions orchestrator** with built-in state management.
- No browser-based polling — orchestrator manages all steps server-side.
- Each step is an activity function with independent retry.
- Continuation is handled by sub-orchestrators.
- Multi-zone delivery: orchestrator fans out to multiple landing zones in parallel.
- Progress and status available via Management API (real-time WebSocket optional).
