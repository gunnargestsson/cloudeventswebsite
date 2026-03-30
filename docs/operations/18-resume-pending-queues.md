# Operation: Resume Pending Queues

> **Backend Actions:** `getPendingQueues`, `clearQueueState`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `resumePendingQueues()`, `resumeTransfer()`, `resumePolling()`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `getPendingQueues()`, `clearQueueState()`

---

## Purpose

Recover in-flight mirror runs after page reload, browser sleep, or backend restart.
When BC queue tasks were submitted but the browser lost track of them, this operation
discovers those queues and resumes the appropriate workflow.

## When It Runs

1. **Page load** — After `loadSettings()` completes.
2. **Browser wake** — When `visibilitychange` detects >2 minutes of sleep.
3. **Manual** — Can be triggered by the user.

## Architecture

```
┌──────────┐       ┌──────────────────┐       ┌────────────────────────┐
│  Browser  │       │  Azure Function   │       │  BC Cloud Events        │
└──────────┘       └──────────────────┘       └────────────────────────┘
     │                     │                            │
     │  getPendingQueues   │                            │
     │─────────────────────▶                            │
     │                     │  1. Read queue state       │
     │                     │  2. Check each queue       │
     │                     │     GetStatus              │
     │                     │────────────────────────────▶│
     │                     │◀────────────────────────────│
     │◀─────────────────────                            │
     │  { pending: [...] }  │                            │
     │                     │                            │
     │  For each entry:    │                            │
     │  ┌─ Both done ────────▶ resumeTransfer()         │
     │  ├─ Both cancelled ───▶ clearQueueState()        │
     │  └─ Still running ────▶ resumePolling()          │
```

## Backend: getPendingQueues

```javascript
async function getPendingQueues(conn, token, companyId) {
  const rawState = await getConfig(conn, token, companyId, CONFIG_QUEUE_STATE_ID);
  if (!rawState) return { pending: [] };
  
  let state;
  try { state = JSON.parse(rawState); } catch { return { pending: [] }; }

  const pending = [];
  for (const [configId, entry] of Object.entries(state)) {
    const { queueId, deletedQueueId, tableName, tableId, createdAt } = entry;

    // Check status of each queue
    let csvStatus = 'n/a';
    let deletedStatus = 'n/a';

    if (queueId) {
      const status = await checkQueueStatus(conn, token, companyId, queueId).catch(() => ({ status: 'error' }));
      csvStatus = status.status;
    }
    if (deletedQueueId) {
      const status = await checkQueueStatus(conn, token, companyId, deletedQueueId).catch(() => ({ status: 'error' }));
      deletedStatus = status.status;
    }

    const ageMin = Math.round((Date.now() - new Date(createdAt).getTime()) / 60000);

    pending.push({ configId, queueId, deletedQueueId, tableName, tableId, csvStatus, deletedStatus, ageMin });
  }

  return { pending };
}
```

## Frontend: resumePendingQueues

```javascript
async function resumePendingQueues() {
  let result;
  try { result = await api('getPendingQueues'); } catch { return; }

  const entries = result.pending || [];
  if (!entries.length) return;

  for (const entry of entries) {
    const { configId, queueId, deletedQueueId, tableName, csvStatus, deletedStatus, ageMin } = entry;

    // Skip if already running
    if (state.runningConfigs.has(configId)) continue;

    const isTerminal = s => s === 'completed' || s === 'deleted' || s === 'error' || s === 'n/a';
    const isCancelled = s => s === 'deleted' || s === 'error' || s === 'n/a';
    const bothDone = isTerminal(csvStatus) && isTerminal(deletedStatus);
    const bothCancelled = isCancelled(csvStatus) && isCancelled(deletedStatus);

    if (bothCancelled) {
      // Nothing to recover
      api('clearQueueState', { configId }).catch(() => {});
      continue;
    }

    if (bothDone) {
      // Both done — go straight to data transfer
      resumeTransfer(configId, tableName, queueId, deletedQueueId, csvStatus, deletedStatus);
      continue;
    }

    // Still running — resume polling
    resumePolling(configId, tableName, queueId, deletedQueueId, csvStatus, deletedStatus);
  }
}
```

## Resume Flows

### resumeTransfer

When both queues are complete, skip directly to data transfer:

```javascript
async function resumeTransfer(configId, tableName, queueId, deletedQueueId, csvStatus, deletedStatus) {
  if (state.runningConfigs.has(configId)) return;
  state.runningConfigs.set(configId, { startedAt: new Date() });
  
  try {
    const transfer = await api('startTransfer', {
      queueId: csvStatus === 'deleted' || csvStatus === 'error' ? null : queueId,
      deletedQueueId: deletedStatus === 'deleted' || deletedStatus === 'error' ? null : deletedQueueId,
      configId,
    });

    // Poll transfer until done (same as runTableNow Step 4)
    let elapsed = 0;
    while (elapsed < 60 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 5000));
      elapsed += 5000;
      const status = await api('checkTransferStatus', { transferId: transfer.transferId, configId });
      if (status.status === 'completed') {
        // Update local state
        if (status.endDateTime) {
          const idx = state.tables.findIndex(r => r.configId === configId);
          if (idx >= 0) state.tables[idx].lastRunAt = status.endDateTime;
        }
        renderTables();
        return;
      }
      if (status.status === 'error') throw new Error(status.error);
      if (status.status === 'not_found') throw new Error('Transfer lost');
    }
  } finally {
    state.runningConfigs.delete(configId);
    api('clearQueueState', { configId }).catch(() => {});
  }
}
```

### resumePolling

When queues are still running, re-enter the polling loop:

```javascript
async function resumePolling(configId, tableName, queueId, deletedQueueId, csvStatus, deletedStatus) {
  if (state.runningConfigs.has(configId)) return;
  state.runningConfigs.set(configId, { startedAt: new Date() });
  
  let csvDone = csvStatus === 'completed' || csvStatus === 'deleted' || csvStatus === 'error' || !queueId;
  let deletedDone = deletedStatus === 'completed' || deletedStatus === 'deleted' || deletedStatus === 'error' || !deletedQueueId;
  const maxWait = 12 * 60 * 60 * 1000;
  let consecutiveErrors = 0;

  try {
    while ((Date.now() - pollStart) < maxWait) {
      if (!csvDone || !deletedDone) {
        await new Promise(r => setTimeout(r, 30000)); // Fixed 30s interval for resume
        
        const polls = [];
        if (!csvDone) polls.push(api('checkQueueStatus', { queueId }));
        if (!deletedDone) polls.push(api('checkQueueStatus', { queueId: deletedQueueId }));
        const results = await Promise.all(polls);
        
        // ... status processing (same logic as runTableNow Step 2)
      }

      if (csvDone && deletedDone) break;
    }

    // Both done — hand off to resumeTransfer
    state.runningConfigs.delete(configId);
    await resumeTransfer(configId, tableName, ...);
  } finally {
    state.runningConfigs.delete(configId);
    api('clearQueueState', { configId }).catch(() => {});
  }
}
```

## Queue State Storage

| Field | Value |
|-------|-------|
| Table | `Cloud Events Storage` |
| Source | `BC Open Mirror` |
| Id | `11111111-1111-1111-1111-000000000003` |
| Data | JSON map: `{ [configId]: { queueId, deletedQueueId, tableName, tableId, createdAt } }` |

## Decision Matrix

| CSV Status | Deleted Status | Action |
|-----------|---------------|--------|
| completed | completed | `resumeTransfer()` |
| completed | deleted/error | `resumeTransfer()` (skip deleted) |
| deleted/error | deleted/error | `clearQueueState()` (nothing to do) |
| running | completed | `resumePolling()` |
| running | running | `resumePolling()` |
| completed | running | `resumePolling()` |
| already running | * | Skip (don't double-run) |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Resume is unnecessary — Durable Functions orchestrators are inherently resumable.
- Orchestrator state survives function app restarts.
- No browser dependency for recovery.
- Failed orchestrators can be "rewound" to a checkpoint via Durable Functions API.
- Stale queue cleanup is handled by a periodic management job.
