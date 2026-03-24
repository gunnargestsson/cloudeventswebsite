# Requirement 24: Open Mirror — Deleted Records Support

## Status: 📝 Specification — Ready for Implementation

---

## Overview

The Open Mirror feature currently only mirrors **modified** records. When a record is
deleted in Business Central it disappears from all future `CSV.Records.Get` calls and
the mirror landing zone is never told about the deletion.

This requirement adds a second CSV file per run: a deleted-records audit export for the
same adjusted timeframe. Fabric Open Mirroring requires this so it can remove (tombstone)
the corresponding rows from the mirrored dataset.

---

## Affected Files

| File | Change |
|---|---|
| `api/mirror/index.js` | Extend `runMirror()` with deleted-record count check and CSV export; add two new helper functions |

---

## Prerequisites

Both `Deleted.RecordIds.Get` (count check) and `CSV.DeletedRecords.Get` (bulk export)
work **regardless** of whether "Store Record" is enabled in *Cloud Events Delete Setup*.
No special table configuration is required to use either message type.

---

## BC API Reference

### `Deleted.RecordIds.Get` — count check

Lightweight sync-oriented type. Returns only `systemId` + `deletedAt` for each
deleted record. Works **regardless of "Store Record"** configuration. Filters use
`startDateTime` / `endDateTime` (no `tableView` or `fieldNumbers`).

```json
{
  "specversion": "1.0",
  "type": "Deleted.RecordIds.Get",
  "source": "BC Open Mirror",
  "data": "{\"tableName\":\"Customer\",\"startDateTime\":\"2026-03-01T00:00:00Z\",\"endDateTime\":\"2026-03-23T12:00:00Z\",\"skip\":0,\"take\":1}"
}
```

Response:

```json
{
  "status": "Success",
  "noOfRecords": 7,
  "result": [
    { "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "deletedAt": "2026-03-15T14:30:00Z" }
  ]
}
```

`noOfRecords` is the total count regardless of `take`, so sending `take: 1` is
sufficient to check whether any deleted records exist.

When `startDateTime` is omitted (first run — no previous timestamp), BC returns
deletions since the beginning of time.

### `CSV.DeletedRecords.Get` — bulk export

Returns a fixed-format UTF-8 CSV of Cloud Events Delete Log entries. Importantly, this
is **not** a field-level snapshot of the deleted record — it is a deletion audit log.

```json
{
  "specversion": "1.0",
  "type": "CSV.DeletedRecords.Get",
  "source": "BC Open Mirror",
  "data": "{\"tableName\":\"Customer\",\"fromDate\":\"2026-03-01T00:00:00Z\",\"toDate\":\"2026-03-23T12:00:00Z\"}"
}
```

> ⚠️ Parameter names differ from the other deleted types:
> `fromDate` / `toDate` (not `startDateTime` / `endDateTime`)

Fixed columns returned:

| Column | Description |
|---|---|
| `systemId` | GUID of the deleted record |
| `tableId` | BC table number |
| `tableName` | BC table name |
| `deletedAt` | ISO 8601 deletion timestamp |
| `userId` | User who deleted the record |

No `skip`/`take` — always returns the full matching set. Response follows the two-step
pattern: POST returns a `data` URL; GET that URL to download the CSV text.

---

## Current `runMirror()` Flow (unchanged)

```
1. Get previousTs (last integration timestamp, may be null for first run)
2. endDt = now; endIso = isoNoMs(endDt)
3. Build runTableView covering [previousTs..endIso]
4. Data.Records.Get (take:1) → noOfRecords
5. If noOfRecords == 0 → return { skipped: true }
6. CSV.Records.Get (asText=true) → { csv, bcTime }
7. confirmedTs = bcTime || endDt; confirmedIso = isoNoMs(confirmedTs)
8. setIntegrationTimestamp(confirmedIso)
9. Upload csv to Tables/{tableName}/{yyyy}/{MM}/{dd}/{stamp}.csv
10. If upload fails → reverseIntegrationTimestamp, throw
```

---

## New `runMirror()` Flow

```
 1. Get previousTs (last integration timestamp, may be null for first run)
 2. endDt = now; endIso = isoNoMs(endDt)
 3. Build runTableView covering [previousTs..endIso]

 4. Data.Records.Get (take:1) → noOfRecords

 5. If noOfRecords > 0:
      CSV.Records.Get (asText=true) → { csv, bcTime }
      confirmedDt  = bcTime ? new Date(bcTime) : endDt
      confirmedIso = isoNoMs(confirmedDt)
    Else:
      confirmedDt  = endDt
      confirmedIso = endIso

 6. Deleted.RecordIds.Get (take:1,
                           startDateTime=previousTs,
                           endDateTime=confirmedIso) → noOfDeleted

 7. If noOfDeleted > 0:
      CSV.DeletedRecords.Get (fromDate=previousTs, toDate=confirmedIso) → deletedCsv

 8. If noOfRecords == 0 AND noOfDeleted == 0 → return { skipped: true }

 9. setIntegrationTimestamp(confirmedIso)

10. try {
      if noOfRecords > 0:
        upload csv      → Tables/{tableName}/{yyyy}/{MM}/{dd}/{stamp}.csv
      if noOfDeleted > 0:
        upload deletedCsv → Tables/{tableName}/{yyyy}/{MM}/{dd}/{stamp}_deleted.csv
    } catch {
      reverseIntegrationTimestamp()
      throw
    }

11. Return result including deletedRecords and deletedFilePath
```

---

## Key Design Decisions

### Why deleted records use `confirmedIso`, not `endIso`

`CSV.Records.Get` causes BC to set the queue record's `time` field to the
`SystemModifiedAt` of the **last record in the result set**. This is the timestamp we
store as the integration boundary — the next run's `startDateTime`. Using that same
confirmed timestamp as the upper bound for the delete check guarantees the two windows
are perfectly aligned: no deletions in `[confirmedIso..endIso]` are included, avoiding
any overlap or gap when the next run continues from `confirmedIso`.

### Why we check deleted records after (not before) CSV.Records.Get

The deleted-records window must end at `confirmedIso`, which is only known after
`CSV.Records.Get` completes. The count check and CSV export therefore must happen after
step 5.

### Skipping when counts are both zero

If neither modified records nor deleted records exist for the window, the run is skipped
without writing a timestamp (same as today). A run with only deletions (records == 0,
deleted > 0) does write a timestamp — it is not skipped.

### Rollback covers both uploads

Both uploads are performed inside a single `try/catch`. A failure on either CSV upload
triggers `reverseIntegrationTimestamp()` before re-throwing, so the next run
re-processes the full current window including both modified and deleted records.

---

## New Helper Functions

### `getDeletedRecordCount(conn, token, companyId, tableCfg, startIso, endIso)`

Calls `Deleted.RecordIds.Get` with `take: 1` and reads `noOfRecords`. This is the
lightweight option — no field data is returned, and it works regardless of whether
"Store Record" is enabled for the table.

```js
async function getDeletedRecordCount(conn, token, companyId, tableCfg, startIso, endIso) {
  const tableSelector = tableCfg.tableName
    ? { tableName: tableCfg.tableName }
    : { tableNumber: tableCfg.tableId };

  const payload = {
    ...tableSelector,
    endDateTime: endIso,
    skip: 0,
    take: 1,
  };
  if (startIso) payload.startDateTime = startIso;

  const result = await bcTask(conn, token, companyId, "Deleted.RecordIds.Get", null, payload);
  return Number(result.noOfRecords || 0);
}
```

> `startIso` is omitted from the payload when falsy (null / empty string). BC then
> returns all deletions ever recorded — correct for a first run with no previous
> timestamp.

### `getCsvDeletedRecords(conn, token, companyId, tableCfg, startIso, endIso)`

Calls `CSV.DeletedRecords.Get` using `fromDate`/`toDate` and returns the raw CSV text.

```js
async function getCsvDeletedRecords(conn, token, companyId, tableCfg, startIso, endIso) {
  const tableSelector = tableCfg.tableName
    ? { tableName: tableCfg.tableName }
    : { tableNumber: tableCfg.tableId };

  const payload = {
    ...tableSelector,
    toDate: endIso,
  };
  if (startIso) payload.fromDate = startIso;

  const result = await bcTask(conn, token, companyId, "CSV.DeletedRecords.Get", null, payload, true);
  return extractCsvPayload(result);
}
```

> `bcTask` is called with `asText = true` so the result is fetched as plain text, same
> as `CSV.Records.Get`. `extractCsvPayload` then normalises the result to a plain string.
> `bcTime` is not read here — the queue time for deleted records is not meaningful for
> the integration timestamp; that is already determined from the regular CSV call.

---

## Updated `runMirror()` Implementation

Replace the current `runMirror` function body with the following:

```js
async function runMirror(conn, token, companyId, tableId) {
  if (!tableId) throw new Error("tableId is required");

  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified")
    throw new Error("Verified mirror connection is required");

  const tables = await getStoredTables(conn, token, companyId);
  const tableCfg = tables
    .map(normalizeTableConfig)
    .find((t) => Number(t.tableId) === Number(tableId));
  if (!tableCfg) throw new Error(`Table ${tableId} is not configured`);
  if (!tableCfg.active) throw new Error(`Table ${tableCfg.tableName} is inactive`);

  const previousTs = await getIntegrationTimestamp(conn, token, companyId, tableCfg.tableId);
  const endDt = new Date();
  const endIso = isoNoMs(endDt);
  const runTableView = buildRunTableView(tableCfg, previousTs, endIso);

  // ── Step 1: Count and fetch modified records ─────────────────────────────────
  let noOfRecords = 0;
  let csv = "";
  let confirmedDt = endDt;
  let confirmedIso = endIso;

  await withTableRefFallback(tableCfg, async (tableRef) => {
    const tableSelector = parseTableRef(tableRef);
    const countResult = await dataRecordsGet(conn, token, companyId, {
      ...tableSelector,
      tableView: runTableView,
      skip: 0,
      take: 1,
      fieldNumbers: [1],
    });

    noOfRecords = Number(countResult.noOfRecords || 0);
    if (noOfRecords === 0) return;

    const csvResult = await bcTask(conn, token, companyId, "CSV.Records.Get", null, {
      ...tableSelector,
      tableView: runTableView,
      fieldNumbers:
        tableCfg.fieldNumbers && tableCfg.fieldNumbers.length
          ? tableCfg.fieldNumbers
          : undefined,
    }, true);

    csv = extractCsvPayload(csvResult);
    if (csvResult.time) {
      confirmedDt = new Date(csvResult.time);
      confirmedIso = isoNoMs(confirmedDt);
    }
  });

  // ── Step 2: Count deleted records (Deleted.RecordIds.Get) then fetch CSV ─────
  const noOfDeleted = await getDeletedRecordCount(
    conn, token, companyId, tableCfg, previousTs, confirmedIso
  );

  let deletedCsv = "";
  if (noOfDeleted > 0) {
    deletedCsv = await getCsvDeletedRecords(
      conn, token, companyId, tableCfg, previousTs, confirmedIso
    );
  }

  // ── Step 3: Skip if nothing to mirror ────────────────────────────────────────
  if (noOfRecords === 0 && noOfDeleted === 0) {
    return {
      tableId: tableCfg.tableId,
      tableName: tableCfg.tableName,
      skipped: true,
      reason: "No records to mirror",
      endDateTime: null,
    };
  }

  if (noOfRecords > 0 && !csv)
    throw new Error("CSV.Records.Get returned no CSV payload");

  // ── Step 4: Confirm timestamp and upload ────────────────────────────────────
  await setIntegrationTimestamp(conn, token, companyId, tableCfg.tableId, confirmedIso);

  try {
    const yyyy = format(confirmedDt, "yyyy");
    const mm   = format(confirmedDt, "MM");
    const dd   = format(confirmedDt, "dd");
    const stamp = formatMirrorFileStamp(confirmedDt);
    const safeTableName = washName(tableCfg.tableName);

    let csvPath = null;
    let deletedFilePath = null;

    if (noOfRecords > 0) {
      csvPath = pathJoin("Tables", safeTableName, yyyy, mm, dd, `${stamp}.csv`);
      await uploadTextToMirror(connection, csvPath, csv);
    }

    if (noOfDeleted > 0) {
      deletedFilePath = pathJoin("Tables", safeTableName, yyyy, mm, dd, `${stamp}_deleted.csv`);
      await uploadTextToMirror(connection, deletedFilePath, deletedCsv);
    }

    return {
      tableId: tableCfg.tableId,
      tableName: tableCfg.tableName,
      skipped: false,
      mirroredRecords: noOfRecords,
      deletedRecords: noOfDeleted,
      endDateTime: confirmedIso,
      filePath: csvPath,
      deletedFilePath,
    };
  } catch (error) {
    await reverseIntegrationTimestamp(conn, token, companyId, tableCfg.tableId);
    throw error;
  }
}
```

---

## File Naming

Both CSV files for a given run share the same timestamp and live in the same
date folder:

```
Tables/{tableName}/
  {yyyy}/
    {MM}/
      {dd}/
        {stamp}.csv              modified records  (only written if noOfRecords > 0)
        {stamp}_deleted.csv      deleted records   (only written if noOfDeleted > 0)
```

`{stamp}` = `yyyyMMdd_HHmmss_SSS` derived from `confirmedDt`.

A run with zero modified records but non-zero deletions will produce only the
`_deleted.csv` file (no regular `.csv` file for that run). Both files can be absent
(skipped run), either alone, or both present for the same stamp — Fabric handles all
combinations.

---

## Return Value Changes

| Field | Before | After |
|---|---|---|
| `skipped` | only when 0 modified | when 0 modified **and** 0 deleted |
| `mirroredRecords` | count of modified records | unchanged |
| `deletedRecords` | absent | count of deleted records (0 when none) |
| `filePath` | path of the CSV | unchanged; `null` when no modified records |
| `deletedFilePath` | absent | path of `_deleted.csv`; `null` when no deletions |

---

## What Does NOT Change

- `runAllActive()` — unchanged; it calls `runMirror()` in a loop
- `activateTable()` / `deactivateTable()` — unchanged
- `uploadDdl()` / `buildDdl()` — handled by Requirement 23
- The `CSV.Records.Get` parameters, `bcTime` extraction, or any CSV column format
- The `withTableRefFallback` pattern for regular records (still used in step 1)
- `extractCsvPayload()` — reused as-is for both CSVs

---

## Testing Checklist

- [ ] Run against a table where no modified records and no deleted records exist in the
      window → `{ skipped: true }`
- [ ] Run against a table where modified records exist but no deleted records → only
      `{stamp}.csv` written; `deletedFilePath` is `null`
- [ ] Run against a table where deleted records exist but no modified records → only
      `{stamp}_deleted.csv` written; `filePath` is `null`; timestamp is written
- [ ] Run against a table where both modified and deleted records exist → both files
      written with the same `{stamp}`
- [ ] Verify the deleted CSV columns: `systemId`, `tableId`, `tableName`, `deletedAt`,
      `userId`
- [ ] Verify the deleted CSV time window matches `[previousTs..confirmedIso]`
- [ ] Simulate an upload failure on the `_deleted.csv` step → integration timestamp
      is reversed; next run re-processes both modified and deleted records from scratch
- [ ] Simulate an upload failure on the `.csv` step → integration timestamp is reversed
- [ ] Verify that when `previousTs` is null (first ever run) the deleted records check
      omits `startDateTime`/`fromDate` from the payload (so all history is returned)
- [ ] Confirm `runAllActive()` correctly reflects `deletedRecords` and `deletedFilePath`
      per table in the results array
