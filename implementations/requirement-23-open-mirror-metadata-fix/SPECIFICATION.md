# Requirement 23: Fix Open Mirror Metadata File

## Status: 📝 Specification — Ready for Implementation

---

## Overview

The Open Mirror feature (`bc-open-mirror.html` + `api/mirror/index.js`) currently uploads an
incorrectly structured metadata file to the Fabric Open Mirroring landing zone. Two things are
wrong:

1. **Wrong path** — the file is placed in a `_metadata/` subfolder as `DDL.json`, but the
   correct location is a `_metadata.json` file directly inside the table's folder (no subfolder).
2. **Wrong format** — the file uses a SQL DDL schema structure that Fabric no longer accepts.
   The correct format is the Fabric Open Mirroring `SchemaDefinition` format.

Both the path and the JSON structure must be replaced. No other behaviour changes.

---

## Affected Files

| File | Change |
|---|---|
| `api/mirror/index.js` | Replace `buildDdl()`, `mapDdlType()`, `uploadDdl()` and related path logic |
| `implementations/requirement-11-open-mirror/SPECIFICATION.md` | Update path structure and DDL format sections |

---

## Path Change

### Current (wrong)
```
{mirrorUrl}/Tables/{tableName}/_metadata/DDL.json
```

### Correct
```
{mirrorUrl}/Tables/{tableName}/_metadata.json
```

The `_metadata/` subdirectory and the `DDL.json` filename are both dropped.
The file is named `_metadata.json` and lives directly under the table folder.

**Code change in `uploadDdl()`:**

```js
// Before
const ddlPath = pathJoin("Tables", safeTableName, "_metadata", "DDL.json");

// After
const ddlPath = pathJoin("Tables", safeTableName, "_metadata.json");
```

---

## Format Change

### Current format (wrong)

Uses a SQL DDL structure with field-number-suffixed column names, SQL data types, and a
flat `columns` array with `type`, `schema`, `primaryKey`, and `watermarkColumn` at the
top level.

```json
{
  "type": "FullInitialLoad",
  "schema": "dbo",
  "tableName": "CurrencyExchangeRate",
  "columns": [
    {
      "columnName": "CurrencyCode-1",
      "isNullable": true,
      "isPrimaryKey": false,
      "columnDataType": "varchar",
      "columnLength": 10
    },
    {
      "columnName": "StartingDate-2",
      "isNullable": true,
      "isPrimaryKey": false,
      "columnDataType": "date"
    },
    {
      "columnName": "Timestamp-0",
      "columnDataType": "bigint",
      "isNullable": true,
      "isPrimaryKey": false
    },
    {
      "columnName": "SystemId-2000000000",
      "columnDataType": "uniqueidentifier",
      "isNullable": false,
      "isPrimaryKey": true
    },
    {
      "columnName": "SystemModifiedAt-2000000003",
      "columnDataType": "datetime2",
      "isNullable": true,
      "isPrimaryKey": false
    }
  ],
  "primaryKey": ["SystemId-2000000000"],
  "watermarkColumn": "SystemModifiedAt-2000000003"
}
```

### Correct format

Uses the Fabric Open Mirroring `SchemaDefinition` format with plain column names
(no field-number suffix), Fabric data types, and `keyColumns` at the top level.

```json
{
  "keyColumns": [
    "systemId",
    "$Company"
  ],
  "fileDetectionStrategy": "LastUpdateTimeFileDetection",
  "SchemaDefinition": {
    "Columns": [
      {
        "Name": "CurrencyCode",
        "DataType": "String",
        "IsNullable": true
      },
      {
        "Name": "StartingDate",
        "DataType": "IDate",
        "IsNullable": true
      },
      {
        "Name": "ExchangeRateAmount",
        "DataType": "Double",
        "IsNullable": true
      },
      {
        "Name": "timestamp",
        "DataType": "Int64",
        "IsNullable": true
      },
      {
        "Name": "systemId",
        "DataType": "String"
      },
      {
        "Name": "SystemCreatedAt",
        "DataType": "DateTime",
        "IsNullable": true
      },
      {
        "Name": "SystemCreatedBy",
        "DataType": "String",
        "IsNullable": true
      },
      {
        "Name": "SystemModifiedAt",
        "DataType": "DateTime",
        "IsNullable": true
      },
      {
        "Name": "SystemModifiedBy",
        "DataType": "String",
        "IsNullable": true
      },
      {
        "Name": "$Company",
        "DataType": "String"
      }
    ]
  },
  "fileFormat": "csv"
}
```

> `$Company` and `keyColumns` entry for `"$Company"` are only included when
> `dataPerCompany: true`. For global (non-per-company) tables omit `"$Company"` from
> both `keyColumns` and `SchemaDefinition.Columns`.

---

## Column Naming Rules

### User fields (BC table fields)

Use the **plain washed field name** — no field-number suffix.

Washing rule: retain only `[a-zA-Z0-9%]`, strip everything else. This is the same
`washName()` function already in `index.js`, applied to `f.name`.

> Example: `"Unit of Measure Code"` → `"UnitofMeasureCode"` (not `"UnitofMeasureCode-5"`)

### System fields (always appended in this exact order)

| `Name` | Notes |
|---|---|
| `timestamp` | Lowercase `t` |
| `systemId` | Lowercase `s` |
| `SystemCreatedAt` | |
| `SystemCreatedBy` | |
| `SystemModifiedAt` | |
| `SystemModifiedBy` | |
| `ClosingDate` | **Table 17 (G/L Entry) only** — inserted before `$Company` |

> Note: system field names use plain camelCase/PascalCase — **no** `-{fieldNo}` suffix.

### `$Company` column

Appended as the very last column only when `dataPerCompany: true`. The literal string
`"$Company"` — no washing applied.

### Table-specific extra columns

| Table ID | Table Name | Extra column | Position |
|---|---|---|---|
| 17 | G/L Entry | `ClosingDate` (Boolean, IsNullable: true) | Immediately before `$Company` (or last, if not per-company) |

---

## Nullability Rules

| Column | `IsNullable` |
|---|---|
| User fields | `true` |
| `timestamp` | `true` |
| `systemId` | omitted (always required — no `IsNullable` property) |
| `SystemCreatedAt` | `true` |
| `SystemCreatedBy` | `true` |
| `SystemModifiedAt` | `true` |
| `SystemModifiedBy` | `true` |
| `ClosingDate` (table 17 only) | `true` |
| `$Company` | omitted (always required — no `IsNullable` property) |

---

## `keyColumns`

| Condition | `keyColumns` value |
|---|---|
| Per-company table (`dataPerCompany: true`) | `["systemId", "$Company"]` |
| Global table (`dataPerCompany: false`) | `["systemId"]` |

---

## Type Mapping — BC → Fabric

Replace `mapDdlType()` entirely. The new function returns a `DataType` string.

| BC `type` | Fabric `DataType` |
|---|---|
| `Text` | `"String"` |
| `Code` | `"String"` |
| `Option` | `"String"` |
| `DateFormula` | `"String"` |
| `Guid` | `"String"` |
| `Integer` | `"Int32"` |
| `BigInteger` | `"Int64"` |
| `Duration` | `"Int64"` |
| `Decimal` | `"Double"` |
| `Boolean` | `"Boolean"` |
| `Date` | `"IDate"` |
| `Time` | `"ITime"` |
| `DateTime` | `"DateTime"` |
| *(all other types)* | `null` (field omitted from metadata) |

System field type overrides (hardcoded, not read from field metadata):

| System column | `DataType` |
|---|---|
| `timestamp` | `"Int64"` |
| `systemId` | `"String"` |
| `SystemCreatedAt` | `"DateTime"` |
| `SystemCreatedBy` | `"String"` |
| `SystemModifiedAt` | `"DateTime"` |
| `SystemModifiedBy` | `"String"` |
| `$Company` | `"String"` |

---

## Updated `buildDdl()` Implementation

Replace the existing `mapDdlType()` and `buildDdl()` functions with the following:

```js
function mapFabricType(fieldType) {
  switch (String(fieldType)) {
    case "Text":
    case "Code":
    case "Option":
    case "DateFormula":
    case "Guid":
      return "String";
    case "Integer":
      return "Int32";
    case "BigInteger":
    case "Duration":
      return "Int64";
    case "Decimal":
      return "Double";
    case "Boolean":
      return "Boolean";
    case "Date":
      return "IDate";
    case "Time":
      return "ITime";
    case "DateTime":
      return "DateTime";
    default:
      return null;
  }
}

function buildDdl(tableCfg, fields) {
  const selectedFieldSet = new Set((tableCfg.fieldNumbers || []).map(Number));
  const useSelection = selectedFieldSet.size > 0;

  const userColumns = fields
    .filter((f) => {
      const no = Number(f.number || f.fieldNo || f.no || f.id);
      const fieldType = String(f.type || "");
      const fieldClass = String(f.class || "Normal");
      if (!(no >= 1 && no <= 1999999999)) return false;
      if (fieldClass !== "Normal") return false;
      if (!mapFabricType(fieldType)) return false;
      if (useSelection && !selectedFieldSet.has(no)) return false;
      return true;
    })
    .map((f) => {
      const name = String(f.name || f.caption || `Field${f.number || f.id}`);
      return {
        Name: washName(name),
        DataType: mapFabricType(String(f.type || "")),
        IsNullable: true,
      };
    });

  const systemColumns = [
    { Name: "timestamp",        DataType: "Int64",    IsNullable: true },
    { Name: "systemId",         DataType: "String" },
    { Name: "SystemCreatedAt",  DataType: "DateTime", IsNullable: true },
    { Name: "SystemCreatedBy",  DataType: "String",   IsNullable: true },
    { Name: "SystemModifiedAt", DataType: "DateTime", IsNullable: true },
    { Name: "SystemModifiedBy", DataType: "String",   IsNullable: true },
  ];

  if (Number(tableCfg.tableId) === 17) {
    systemColumns.push({ Name: "ClosingDate", DataType: "Boolean", IsNullable: true });
  }

  if (tableCfg.dataPerCompany) {
    systemColumns.push({ Name: "$Company", DataType: "String" });
  }

  const keyColumns = tableCfg.dataPerCompany
    ? ["systemId", "$Company"]
    : ["systemId"];

  return {
    keyColumns,
    fileDetectionStrategy: "LastUpdateTimeFileDetection",
    SchemaDefinition: {
      Columns: [...userColumns, ...systemColumns],
    },
    fileFormat: "csv",
  };
}
```

> The old `mapDdlType()` function is deleted entirely and replaced by `mapFabricType()`.
> The constant `SUPPORTED_TYPES` used in `buildDdl()` for field filtering is now derived
> from `mapFabricType()` returning non-null — no separate set needed.

---

## Updated `uploadDdl()` — Path Only

Only the path construction changes. Everything else stays the same:

```js
async function uploadDdl(conn, token, companyId, connection, tableCfg) {
  const fields = await withTableRefFallback(tableCfg, (tableRef) =>
    getTableFields(conn, token, companyId, tableRef)
  );
  const resolvedTableName = resolveTableName(tableCfg, fields);
  const safeTableName = washName(resolvedTableName);
  const ddl = buildDdl({ ...tableCfg, tableName: resolvedTableName }, fields);
  const ddlPath = pathJoin("Tables", safeTableName, "_metadata.json"); // ← changed
  await uploadTextToMirror(connection, ddlPath, JSON.stringify(ddl, null, 2));
}
```

---

## Updated Landing Zone Path Structure

Replace the current path diagram in requirement-11 SPECIFICATION.md:

```
{mirrorUrl}/
  Tables/
    {tableName}/
      _metadata.json                     uploaded once on activation / re-activation
      {YYYY}/
        {MM}/
          {DD}/
            {YYYYMMDD_HHmmss_SSS}.csv    one file per successful mirror run
```

> The `_metadata/` subdirectory no longer exists. The metadata file is `_metadata.json`
> directly inside `Tables/{tableName}/`.

---

## What Does NOT Change

- The `uploadTextToMirror()` function itself — no changes.
- The `uploadDdlOnly()` function — calls `uploadDdl()` which already handles everything.
- The CSV file path structure (`{YYYY}/{MM}/{DD}/{timestamp}.csv`) — unchanged.
- The CSV content / `CSV.Records.Get` column naming convention (`{washedName}-{fieldNo}`) — unchanged.
- The activation / deactivation flow — unchanged.
- The `SUPPORTED_TYPES` set can be removed since `mapFabricType()` returning `null`
  already acts as the filter.

---

## Testing Checklist

- [ ] Activate a per-company table (e.g. `Customer`) — verify `_metadata.json` is created
      at `Tables/Customer/_metadata.json`
- [ ] Verify no `_metadata/` subfolder or `DDL.json` file is created
- [ ] Inspect `_metadata.json` content:
  - [ ] Top-level keys: `keyColumns`, `fileDetectionStrategy`, `SchemaDefinition`, `fileFormat`
  - [ ] `keyColumns` is `["systemId", "$Company"]` for per-company tables
  - [ ] `fileFormat` is `"csv"`
  - [ ] `fileDetectionStrategy` is `"LastUpdateTimeFileDetection"`
  - [ ] User fields use plain washed names (no `-{fieldNo}` suffix)
  - [ ] System fields appear in correct order with correct casing (`timestamp`, `systemId`, etc.)
  - [ ] `systemId` and `$Company` have no `IsNullable` property
  - [ ] All other columns have `"IsNullable": true`
  - [ ] Types match the BC → Fabric type mapping table above
- [ ] Activate a global (non-per-company) table — verify `keyColumns` is `["systemId"]`
      and `$Company` is absent from both `keyColumns` and `SchemaDefinition.Columns`
- [ ] Re-activate an already-active table — verify `_metadata.json` is overwritten cleanly
- [ ] Confirm CSV mirror runs still succeed after metadata change (path for CSV unchanged)
