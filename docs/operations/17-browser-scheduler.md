# Operation: Browser Scheduler

> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `startScheduler()`, `stopScheduler()`, `startSchedulerForTable()`
> **No direct backend action** — orchestrates calls to `runTableNow()`

---

## Purpose

A browser-based scheduler that runs active table mirrors at configurable intervals.
It manages per-table timers, concurrency limits, continuation re-triggers, and
recovery after browser sleep.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser Scheduler                        │
│                                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐    Concurrency     │
│  │ Table A  │  │ Table B  │  │ Table C  │    Limit: 3       │
│  │ 60 min   │  │ 30 min   │  │ 120 min  │                   │
│  │ Timer ⏱  │  │ Timer ⏱  │  │ Timer ⏱  │                   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                   │
│       │              │              │                         │
│       └──────────────┼──────────────┘                        │
│                      ▼                                       │
│              waitForConcurrencySlot()                        │
│              waitForTableSlot()                              │
│                      ▼                                       │
│              runTableNow(configId)                           │
│                      ▼                                       │
│              Schedule next run                               │
│              (intervalMs or 10s for continuation)            │
└─────────────────────────────────────────────────────────────┘
```

## Start Scheduler

```javascript
function startScheduler() {
  stopScheduler(true); // silent stop to avoid double "stopped" log
  state.schedulerRunning = true;
  _lastVisibleAt = Date.now();
  state.tables.filter((table) => table.active).forEach(startSchedulerForTable);
  addLog('Scheduler started', 'ok');
}
```

## Stop Scheduler

```javascript
function stopScheduler(silent = false) {
  state.schedulerRunning = false;
  
  // Abort all in-flight polling loops
  state.schedulerAbort.forEach((ac) => ac.abort());
  state.schedulerAbort.clear();
  
  // Abort all running configs (manual + scheduled)
  state.runningConfigs.forEach((info) => { if (info.ac) info.ac.abort(); });
  state.runningConfigs.clear();
  
  // Clear all pending timers
  state.schedulerTimers.forEach((timer) => { clearTimeout(timer); clearInterval(timer); });
  state.schedulerTimers.clear();
  
  state.activeTableIds.clear();
  if (!silent) addLog('Scheduler stopped', 'warn');
}
```

## Per-Table Scheduling

```javascript
function startSchedulerForTable(table) {
  stopSchedulerForTable(table.configId);
  const intervalMs = Math.max(1, Number(table.intervalMin || 60)) * 60 * 1000;

  // Compute delay until next run
  // Never run → delay 0 (immediate)
  // Previously run → remaining time until lastRunAt + interval
  const lastMs = table.lastRunAt ? new Date(table.lastRunAt).getTime() : 0;
  const delayMs = lastMs ? Math.max(0, lastMs + intervalMs - Date.now()) : 0;

  const runAndSchedule = async () => {
    if (!state.schedulerRunning) return;

    const ac = new AbortController();
    state.schedulerAbort.set(table.configId, ac);

    // Wait for concurrency slot
    const slotOk = await waitForConcurrencySlot(ac.signal);
    if (!slotOk || ac.signal.aborted || !state.schedulerRunning) return;

    let result = null;
    try {
      result = await window.runTableNow(table.configId, { signal: ac.signal });
    } catch (error) {
      // Error already logged inside runTableNow
    }

    state.schedulerAbort.delete(table.configId);
    if (!state.schedulerRunning) return;

    // Continuation: re-trigger in 10 seconds instead of full interval
    const continuationPending = result && result.continueFromRecordId
      && /^[0-9a-f]{8}-/i.test(result.continueFromRecordId);
    const nextDelayMs = continuationPending ? 10000 : intervalMs;

    const nextTimer = setTimeout(runAndSchedule, nextDelayMs);
    state.schedulerTimers.set(table.configId, nextTimer);
  };

  const initialTimer = setTimeout(runAndSchedule, delayMs);
  state.schedulerTimers.set(table.configId, initialTimer);
}
```

## Concurrency Control

### Global Concurrency Limit

```javascript
function waitForConcurrencySlot(signal) {
  return new Promise((resolve) => {
    const check = () => {
      if (signal && signal.aborted) { resolve(false); return; }
      if (state.activeMirrorCount < state.maxConcurrentMirrors) { resolve(true); return; }
      setTimeout(check, 1000); // Re-check every second
    };
    check();
  });
}
```

Default `maxConcurrentMirrors`: **3** (configurable in the connection panel).

### Per-Table Concurrency

Prevents two configs for the same BC table from running simultaneously:

```javascript
function waitForTableSlot(tableId, signal) {
  return new Promise((resolve) => {
    const check = () => {
      if (signal && signal.aborted) { resolve(false); return; }
      if (!state.activeTableIds.has(tableId)) { resolve(true); return; }
      setTimeout(check, 2000); // Re-check every 2 seconds
    };
    check();
  });
}
```

## Browser Wake Detection

When the browser sleeps (tab backgrounded, lid closed, OS sleep), all `setTimeout`
timers freeze. On wake, the scheduler detects this and restarts stale timers:

```javascript
let _lastVisibleAt = Date.now();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  
  const sleepDuration = Date.now() - _lastVisibleAt;
  _lastVisibleAt = Date.now();

  // Only act if hidden for >2 minutes (real sleep)
  if (sleepDuration < 2 * 60 * 1000) return;
  if (!state.schedulerRunning) return;

  addLog(`Browser woke up after ${Math.floor(sleepDuration / 60000)}m — checking scheduler`);

  // Restart timers for idle tables
  for (const table of state.tables.filter(t => t.active)) {
    if (state.runningConfigs.has(table.configId)) continue;
    if (state.schedulerAbort.has(table.configId)) continue;

    const oldTimer = state.schedulerTimers.get(table.configId);
    if (oldTimer) clearTimeout(oldTimer);
    state.schedulerTimers.delete(table.configId);

    startSchedulerForTable(table); // Re-evaluates from lastRunAt
    addLog(`Re-scheduled: ${table.tableName}`);
  }

  // Also check for pending queues from before the sleep
  resumePendingQueues().catch(e => addLog('Resume check failed: ' + e.message, 'warn'));
});
```

## State Tracking

| State Object | Type | Purpose |
|-------------|------|---------|
| `state.schedulerRunning` | Boolean | Global on/off flag |
| `state.schedulerTimers` | Map<configId, timerId> | Per-table setTimeout references |
| `state.schedulerAbort` | Map<configId, AbortController> | Per-table abort controllers |
| `state.runningConfigs` | Map<configId, info> | Currently executing runs |
| `state.activeTableIds` | Set<tableId> | BC tables with active runs |
| `state.activeMirrorCount` | Number | Number of concurrent runs |
| `state.maxConcurrentMirrors` | Number | Concurrency limit (default 3) |

## Timing Behavior

| Scenario | Initial Delay | Next Run |
|----------|--------------|----------|
| Never run | 0 (immediate) | `intervalMin` after completion |
| Last run 30 min ago, interval 60 min | 30 min | `intervalMin` |
| Last run 90 min ago, interval 60 min | 0 (overdue) | `intervalMin` |
| Continuation pending | 10 seconds | `intervalMin` (after final chunk) |
| After browser wake | Re-evaluated from `lastRunAt` | `intervalMin` |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Scheduling moves to **Durable Functions Timer Triggers** (server-side, no browser dependency).
- Per-table CRON expressions instead of simple intervals.
- Concurrency managed by Durable Functions entity semaphores.
- No browser wake detection needed — runs independently.
- Dashboard shows scheduler status and next-run times for all tables.
- Scheduler can be paused/resumed per-source or globally via Management API.
