# Origo Cloud Events API – Reference

This document is the working reference for all Cloud Events API calls made by this portal.
**After company selection, all data get and set operations use this API exclusively — the standard BC v2.0 REST API is not used.** Data requests are paginated using `skip`/`take` with page size adapted to screen width. `noOfRecords` in every response reflects the full dataset count for the applied filters and is used to drive pagination.

---

## Base URL

The URL contains **two independent version numbers**:

```
https://api.businesscentral.dynamics.com/v2.0/{tenantId}/{environment}/api/origo/cloudEvent/v1.0/companies({companyId})/tasks/
│                                          ^^^^                                              ^^^^
│                                          BC platform API version                           Cloud Events extension version
│                                          (always v2.0)                                     (Origo app, currently v1.0)
```

| Segment | Value | What it is |
|---|---|---|
| `v2.0` | fixed | Business Central platform API version — the outer BC REST layer |
| `{tenantId}` | `BC_TENANT_ID` env var | Tenant identifier (e.g. `dynamics.is`) |
| `{environment}` | `BC_ENVIRONMENT` env var | BC environment name (e.g. `UAT`) |
| `origo/cloudEvent` | fixed | Publisher and API name for the Origo Cloud Events extension |
| `v1.0` | fixed | Origo Cloud Events extension API version |
| `{companyId}` | resolved at runtime | Company GUID from the company selector |

In the portal, all calls go through `/api/bc?path=<encoded-path>`. The proxy must use the Cloud Events base (`api/origo/cloudEvent/v1.0/`) — **not** the standard `api/v2.0/` base which is a different API root.

---

## Three Endpoints

### 1. `/tasks` — Synchronous (use this by default)

POST a cloud event message. BC processes it immediately and returns the response download link in the `data` field of the response.

```http
POST /companies({companyId})/tasks
Content-Type: application/json

{
  "specversion": "1.0",
  "type": "<MessageType>",
  "source": "BC Portal",
  "subject": "<optional>",
  "data": "<JSON string of input params>"
}
```

**Response (verified):**
```json
{
  "@odata.context": "https://api.businesscentral.dynamics.com/v2.0/dynamics.is/UAT/api/origo/cloudEvent/v1.0/$metadata#companies(...)/tasks/$entity",
  "@odata.etag": "W/\"...\"",
  "id": "7df25b48-ec25-498f-b8cf-566044ae020d",
  "specversion": "1.0",
  "type": "Data.Records.Get",
  "source": "BC Portal",
  "time": "2026-03-09T20:55:57.89Z",
  "subject": "Customer",
  "lcid": 0,
  "datacontenttype": "text/json",
  "data": "https://api.businesscentral.dynamics.com/v2.0/{tenantGuid}/UAT/api/origo/cloudEvent/v1.0/companies({companyId})/responses({id})/data"
}
```

The `data` field is a **full absolute URL already ending in `/data`** — GET it directly with a Bearer token.

> **Important:** The hostname in `data` uses the internal tenant GUID (e.g. `9069b642-...`), not the named tenant (`dynamics.is`). Always use the URL exactly as returned.

---

### 2. `/queues` — Asynchronous

Same request body as tasks. BC schedules the job and returns immediately.
Poll with `GetStatus`, or subscribe to webhooks (`CloudEventMessageCompleted` / `CloudEventMessageFailed`).

```http
POST /companies({companyId})/queues                                   ← submit
POST /companies({companyId})/queues({id})/Microsoft.NAV.GetStatus     ← poll
POST /companies({companyId})/queues({id})/Microsoft.NAV.RetryTask     ← retry failed
GET  /companies({companyId})/queues({id})                             ← check record
```

**GetStatus values:** `Created` (still running) · `Updated` (done) · `Deleted` (no task) · `None`

---

### 3. `/responses({id})/data` — Fetch Results

After a task or completed queue job, use the **full URL from the `data` field** of the task response — it already includes `/data` at the end:

```http
GET https://api.businesscentral.dynamics.com/v2.0/{tenantGuid}/{env}/api/origo/cloudEvent/v1.0/companies({companyId})/responses({id})/data
Authorization: Bearer {access_token}
```

Do not construct this URL manually — always use `task.data` verbatim from the task response.

---

## Request Envelope

All calls share these fields:

| Field | Required | Notes |
|---|---|---|
| `specversion` | Yes | Always `"1.0"` |
| `type` | Yes | The message type, e.g. `"Data.Records.Get"` |
| `source` | Yes | Caller identifier, e.g. `"BC Portal"` |
| `id` | No | UUID — auto-generated if omitted |
| `subject` | Depends | Some message types use this for the target (customer no., table name, item no.) |
| `data` | Depends | **Must be a JSON string** (stringified), not an object |
| `lcid` | No | Windows language ID for caption language (1033 = English, 1039 = Icelandic) |
| `datacontenttype` | No | `"application/json"` (default for all built-in types) |

`data` must be serialized: `"data": "{\"tableName\":\"Customer\"}"` — not `"data": {"tableName": "Customer"}`.

---

## Message Types – Full Reference

### DATA OPERATIONS

---

#### `Data.Records.Get` — Read table records

Direction: **Outbound**

```json
{
  "specversion": "1.0",
  "type": "Data.Records.Get",
  "source": "BC Portal",
  "data": "{\"tableName\":\"Customer\",\"fieldNumbers\":[1,2,5,7],\"startDateTime\":\"2026-01-01T00:00:00Z\",\"endDateTime\":\"2026-12-31T23:59:59Z\",\"tableView\":\"WHERE(Blocked=CONST( ))\",\"skip\":0,\"take\":100}"
}
```

Table identification — three ways (evaluated in this priority order):
1. `data.tableNumber` (integer in data payload)
2. `data.tableName` (string in data payload)
3. `subject` in the envelope — table name string (e.g. `"Customer"`) or numeric string (e.g. `"18"`)

Input parameters:

| Parameter | Type | Description |
|---|---|---|
| `tableName` | string | Table name in `data`, e.g. `"Customer"`, `"Item"`, `"G/L Entry"` |
| `tableNumber` | int | Table number in `data` (higher priority than `tableName`), e.g. `18` |
| `fieldNumbers` | int[] | Field numbers to return. Omit for all fields |
| `startDateTime` | ISO 8601 | Filter by `SystemModifiedAt` ≥ this value |
| `endDateTime` | ISO 8601 | Filter by `SystemModifiedAt` ≤ this value |
| `tableView` | string | BC table view filter, e.g. `"WHERE(Blocked=CONST( ))"` |
| `skip` | int | Pagination offset (default: 0) |
| `take` | int | Records per page (default: 100). Set based on screen size — see [Pagination Pattern](#screen-size-based-pagination) |

All filter parameters (`fieldNumbers`, date range, `tableView`) can be combined freely.

Response (verified from `/data` endpoint):
```json
{
  "status": "Success",
  "noOfRecords": 5,
  "result": [
    {
      "id": "7FE8C74C-7A01-F111-A1F9-6045BD750E1F",
      "primaryKey": { "No_": "10000" },
      "fields": {
        "Name": "Adatum Corporation",
        "Address": "Station Road, 21",
        "Blocked": " ",
        "CreditLimitLCY": 10000.50,
        "Image": {
          "Id": "{D6E0EA8A-88A5-4F03-BC75-A5FBC2806FB1}",
          "Value": "/9j/4AAQ..."
        }
      }
    }
  ]
}
```

- `id` = SystemId (GUID, uppercase)
- `noOfRecords` = **total count matching all applied filters** (`tableView`, date range). This is a full-dataset count — it does **not** change with `skip`/`take`. Use it to calculate total pages: `Math.ceil(noOfRecords / take)`
- `primaryKey` = primary key fields only; **never appears in `fields`** even when all fields requested
- `fields` = all non-PK requested fields
- **Field name normalization** — two steps applied in order:
  1. Replace each of `` % . " \ / ' `` with `_`
  2. Strip every remaining character that is not `_`, a letter (`A–Z`, `a–z`), or a digit (`0–9`)

  Examples:

  | BC field name | After step 1 | After step 2 (JSON key) |
  |---|---|---|
  | `No.` | `No_` | `No_` |
  | `Phone No.` | `Phone No_` | `PhoneNo_` |
  | `E-Mail` | `E-Mail` | `EMail` |
  | `Credit Limit (LCY)` | `Credit Limit (LCY)` | `CreditLimitLCY` |
  | `G/L Account No.` | `G_L Account No_` | `G_LAccountNo_` |
  | `Sell-to Customer No.` | `Sell-to Customer No_` | `SelltoCustomerNo_` |
  | `Dimension Set ID` | `Dimension Set ID` | `DimensionSetID` |
  | `Unit Price` | `Unit Price` | `UnitPrice` |

  > Use `Help.Fields.Get` → `jsonName` to get the exact key for any field without guessing.
- **Option/Enum fields** return the **display caption** for the request language (set via `lcid`; defaults to Cloud Events Setup language). Use `Help.Fields.Get` `enum[].value` for the always-English AL name. See [Enum Values](#enum-values)
- **FlowField** values are **only calculated when `fieldNumbers` is specified**. Omitting `fieldNumbers` skips FlowField values entirely (they appear blank/zero)
- **BLOB fields** return as a plain Base64 string: `"ValueBLOB": "dGhpcyBpcyB0ZXN0..."`
- **Media fields** (e.g. `Image`) return as object: `{ "Id": "{GUID}", "Value": "base64string" }`
- **MediaSet fields** return as object: `{ "Id": "{GUID}", "Media": [ { "Id": "...", "Value": "..." }, ... ] }`
- **Blank Date fields** return as `null` or `"0001-01-01"`
- **Currency Code** (blank = LCY): blank values are converted to the LCY code from G/L Setup on read (e.g., `"ISK"`) — see [Special Field Conversions](#special-field-conversions)
- **Dimension Set ID** (field 480): returned as array of dimension entries — see [Special Field Conversions](#special-field-conversions)

Errors: invalid table name causes a top-level error throw (not a `{"status":"Error"}` response).

---

#### `Data.RecordIds.Get` — Get IDs + timestamps for sync

Direction: **Outbound**

Like `Data.Records.Get` but returns only SystemId and `SystemModifiedAt` — fast for change-detection/incremental sync.

```json
{
  "specversion": "1.0",
  "type": "Data.RecordIds.Get",
  "source": "BC Portal",
  "data": "{\"tableName\":\"Customer\",\"startDateTime\":\"2026-01-01T00:00:00Z\",\"endDateTime\":\"2026-12-31T23:59:59Z\"}"
}
```

Input parameters:

| Parameter | Type | Description |
|---|---|---|
| `tableName` | string | BC table name |
| `tableNumber` | int | BC table number (alternative to `tableName`) |
| `startDateTime` | ISO 8601 | Filter by `SystemModifiedAt` ≥ this value |
| `endDateTime` | ISO 8601 | Filter by `SystemModifiedAt` ≤ this value |
| `tableView` | string | BC table view filter (optional additional filter) |
| `skip` | int | Pagination offset (default: 0) |
| `take` | int | Page size (default: 100) |

Response:
```json
{
  "status": "Success",
  "noOfRecords": 150,
  "result": [
    { "id": "3F915906-44FF-F011-A1FB-7CED8DB3A1C7", "modifiedAt": "2026-03-09T20:55:57.89Z" },
    { "id": "7FE8C74C-7A01-F111-A1F9-6045BD750E1F", "modifiedAt": "2026-02-14T10:30:00Z" }
  ]
}
```

- `noOfRecords` = **total count matching all applied filters** (same filter semantics as `Data.Records.Get`); does not change with `skip`/`take`
- `id` = SystemId (uppercase GUID)
- `modifiedAt` = `SystemModifiedAt` timestamp as ISO 8601 UTC

---

#### `Data.Records.Set` — Insert or update records

Direction: **Inbound**

`subject` = table name (string) or table number as string (e.g. `"18"` for Customer).

```json
{
  "specversion": "1.0",
  "type": "Data.Records.Set",
  "source": "BC Portal",
  "subject": "Customer",
  "data": "{\"data\":[{\"id\":\"guid-of-existing-record\",\"fields\":{\"Address\":\"New Street 1\",\"City\":\"Reykjavik\"}}]}"
}
```

The `data` payload must contain a `data` array. Each element:

| Field | Use |
|---|---|
| `id` (GUID string) | Update by SystemId — only send `fields` alongside |
| `primaryKey` | Insert (if record doesn't exist) or update (if it does) by primary key |
| `fields` | Fields to set/update (never include PK fields here) |

Lookup logic: `id` provided → find by SystemId and update; `primaryKey` only → find or insert; both → `id` takes precedence for lookup.

**Field values in `fields` are always sent as strings**, regardless of type:
- Decimal: `"CreditLimitLCY": "25000.75"`
- Boolean: `"PrintStatements": "false"` or `"PrintStatements": "true"`
- Option/Enum: `"Blocked": "Ship"` — accepts the AL name, the display caption, or the ordinal as a string (e.g. `"1"`); all three formats are valid
- Code/Text: `"Name": "Acme Corp"`
- Get-then-set round-trip: the `fields` values from `Data.Records.Get` can be sent back directly as-is

Success response:
```json
{ "status": "Success", "insertedCount": 1, "modifiedCount": 0, "result": [{...same structure as Records.Get...}] }
```

Error responses:
```json
{ "status": "Error", "error": "Table 'NonExistentTable' not found" }
{ "status": "Error", "error": "Missing required 'data' array in request." }
```

**Currency Code LCY round-trip**: `Data.Records.Get` returns the LCY code (e.g. `"ISK"`) for fields where BC stores blank. Send that same LCY code value back in `Data.Records.Set` — it'll be converted back to blank automatically. See [Special Field Conversions](#special-field-conversions).

**Dimension Set ID**: `Data.Records.Get` returns an array for `DimensionSetID`. Send the same array back in Set — it'll be resolved to a dimension set ID automatically. See [Special Field Conversions](#special-field-conversions).

---

### METADATA OPERATIONS

---

#### `Help.Tables.Get` — List all tables

Returns all accessible tables. Optionally filter to a single table — three ways to identify the table (evaluated in priority order):
1. `data.tableName` — name string in the `data` object
2. `data.tableNumber` — number integer in the `data` object
3. `subject` — table name or numeric string in the envelope

Supports `lcid` for localized captions.

```json
{ "specversion": "1.0", "type": "Help.Tables.Get", "source": "BC Portal" }
```

Single-table lookup — via `subject` (numeric string):
```json
{ "specversion": "1.0", "type": "Help.Tables.Get", "source": "BC Portal", "subject": "18", "lcid": 1039 }
```

Single-table lookup — via `data.tableNumber` (integer):
```json
{ "specversion": "1.0", "type": "Help.Tables.Get", "source": "BC Portal", "data": "{\"tableNumber\":18}", "lcid": 1039 }
```

Response: `{ "result": [{ "id": 18, "name": "Customer", "caption": "Viðskiptamaður" }] }`

---

#### `Help.Fields.Get` — Get field metadata for a table

Three ways to identify the table (evaluated in priority order):
1. `data.tableName` — name string in the `data` object
2. `data.tableNumber` — number integer in the `data` object
3. `subject` — table name or numeric string in the envelope

Supports `lcid` for localized captions and `fieldNumbers` in `data` to limit results to specific fields.

Via `data.tableName` + `fieldNumbers` + `lcid` (recommended — most explicit):
```json
{
  "specversion": "1.0",
  "type": "Help.Fields.Get",
  "source": "BC Portal",
  "lcid": 1039,
  "data": "{\"tableName\":\"Customer\",\"fieldNumbers\":[2,7,35,39,59,102]}"
}
```

Response:
```json
{
  "status": "Success",
  "result": [
    { "id": 2,  "name": "Name",               "jsonName": "Name",            "caption": "Heiti",               "class": "Normal",    "type": "Text",    "len": 100, "isPartOfPrimaryKey": false },
    { "id": 7,  "name": "City",               "jsonName": "City",            "caption": "Bær",                 "class": "Normal",    "type": "Text",    "len":  30, "isPartOfPrimaryKey": false },
    { "id": 35, "name": "Country/Region Code","jsonName": "Country_RegionCode","caption": "Lands-/svæðiskóði","class": "Normal",    "type": "Code",    "len":  10, "isPartOfPrimaryKey": false },
    { "id": 39, "name": "Blocked",            "jsonName": "Blocked",         "caption": "Lokaður",             "class": "Normal",    "type": "Option",  "len":   4, "isPartOfPrimaryKey": false,
      "enum": [
        { "value": " ",       "caption": " ",            "ordinal": 0 },
        { "value": "Ship",    "caption": "Afhenda",      "ordinal": 1 },
        { "value": "Invoice", "caption": "Reikningsfæra","ordinal": 2 },
        { "value": "All",     "caption": "Allt",         "ordinal": 3 }
      ]
    },
    { "id": 59, "name": "Balance (LCY)",      "jsonName": "BalanceLCY",      "caption": "Staða (SGM)",          "class": "FlowField", "type": "Decimal", "len":  12, "isPartOfPrimaryKey": false },
    { "id": 102,"name": "E-Mail",             "jsonName": "EMail",           "caption": "Tölvupóstur",          "class": "Normal",    "type": "Text",    "len":  80, "isPartOfPrimaryKey": false }
  ]
}
```

This response illustrates all three naming concepts at once:
- `name` (`"Country/Region Code"`) — original BC field name with spaces → used in `tableView` WHERE clauses
- `jsonName` (`"Country_RegionCode"`) — normalized key → used in `Data.Records.Get` / `Data.Records.Set` field objects
- `caption` (`"Lands-/svæðiskóði"`) — localized to `lcid: 1039` → used for display only

Via `subject` (name) + `fieldNumbers`:
```json
{
  "specversion": "1.0",
  "type": "Help.Fields.Get",
  "source": "BC Portal",
  "subject": "Customer",
  "lcid": 1039,
  "data": "{\"fieldNumbers\":[2,7,35,39,59,102]}"
}
```

Via `data.tableNumber` + `fieldNumbers`:
```json
{ "specversion": "1.0", "type": "Help.Fields.Get", "source": "BC Portal", "data": "{\"tableNumber\":18,\"fieldNumbers\":[2,7,35,39,59,102]}" }
```

- `name` is the **original BC field name** (may contain spaces and punctuation) — use this in `tableView` WHERE clauses (e.g. `WHERE(Windows Language ID=FILTER(1033|1039))`). This is also the value to pass to `fieldNumbers`-by-name lookups.
- `jsonName` is the **normalized JSON key** — this is the exact property name used in `Data.Records.Get` response `fields` objects and in `Data.Records.Set` request `fields` objects. Use `jsonName` rather than guessing how BC normalizes field names (e.g. `"Windows Language ID"` → `"WindowsLanguageID"`).
- `caption` is the **localized display label** for the field, translated according to the request `lcid`. Use this for display only — not in WHERE clauses or Set payloads.
- `class` is `"Normal"` or `"FlowField"`. FlowFields are only calculated in `Data.Records.Get` when `fieldNumbers` is specified.
- `enum[].value` is the always-English AL name — use in `tableView` filters and `Data.Records.Set`.
- `enum[].caption` is the localized display caption — matches what `Data.Records.Get` returns as the field value.

---

#### `Help.MessageTypes.Get` — Discover all message types

```json
{ "specversion": "1.0", "type": "Help.MessageTypes.Get", "source": "BC Portal" }
```

Response: `{ "result": [{ "name": "Data.Records.Get", "description": "...", "messageDirection": "Outbound" }] }`

---

#### `Help.Implementation.Get` — Get docs for a message type

```json
{
  "specversion": "1.0",
  "type": "Help.Implementation.Get",
  "source": "BC Portal",
  "subject": "Data.Records.Get"
}
```

Returns markdown documentation for that message type.

---

#### `Help.Permissions.Get` — Check table permissions

```json
{
  "specversion": "1.0",
  "type": "Help.Permissions.Get",
  "source": "BC Portal",
  "subject": "Customer"
}
```

Response: `{ "tableName": "Customer", "readPermission": true, "writePermission": false }`

---

### SALES, CUSTOMER & ITEM OPERATIONS

---

#### `Customer.CreditLimit.Get`

Direction: **Outbound**. `subject` = customer number.

```json
{ "specversion": "1.0", "type": "Customer.CreditLimit.Get", "source": "BC Portal", "subject": "10000" }
```

Response (all fields verified):
```json
{
  "status": "Success",
  "customerNo": "10000",
  "customerName": "Adatum Corporation",
  "balanceLCY": 4500.00,
  "outstandingBalanceDueLCY": 1200.00,
  "outstandingAmountLCY": 3000.00,
  "creditLimitLCY": 10000.00,
  "remainingCredit": 2500.00,
  "remainingCreditWithTolerance": 3500.00,
  "isCreditLimitExceeded": false,
  "hasOverdueBalance": false,
  "tolerancePercent": 10
}
```

- `remainingCredit` = `creditLimitLCY` − balance − outstanding; can be negative
- `tolerancePercent` = from Cloud Events Setup; only present when non-zero
- `remainingCreditWithTolerance` = `creditLimitLCY` × (1 + tolerance%) − balance − outstanding
- `isCreditLimitExceeded` = true only when remaining credit with tolerance is negative (tolerance doesn't apply when limit = 0)
- Errors: invalid customer number throws a top-level error

---

#### `Item.Availability.Get`

Direction: **Outbound**. `subject` = item number.

```json
{
  "specversion": "1.0",
  "type": "Item.Availability.Get",
  "source": "BC Portal",
  "subject": "1000",
  "data": "{\"requestedDeliveryDate\":\"2026-04-01\",\"variantCode\":\"RED\"}"
}
```

Optional data params: `requestedDeliveryDate` (date), `variantCode` (string).

Response shape depends on Cloud Events Setup (Physical Inventory or Calculated Quantity):

**Physical Inventory:**
```json
{
  "status": "Success",
  "itemNo": "1000",
  "inventory": [
    { "locationCode": "BLUE", "inventory": 50 }
  ]
}
```

**Calculated Quantity:**
```json
{
  "status": "Success",
  "itemNo": "1000",
  "requestedDeliveryDate": "2026-04-01",
  "availability": [
    {
      "locationCode": "BLUE",
      "inventory": 50,
      "qtyReserved": 5,
      "grossRequirement": 10,
      "scheduledReceipt": 20,
      "plannedOrderReceipt": 15,
      "availableQuantity": 70
    }
  ]
}
```

Errors: invalid item number throws a top-level error.

---

#### `Item.Price.Get`

Direction: **Outbound**. `subject` = item number.

```json
{
  "specversion": "1.0",
  "type": "Item.Price.Get",
  "source": "BC Portal",
  "subject": "1000",
  "data": "{\"variantCode\":\"RED\",\"customerNo\":\"10000\",\"requestedDeliveryDate\":\"2026-04-01\",\"quantity\":10}"
}
```

Optional data params: `variantCode`, `customerNo`, `requestedDeliveryDate`, `quantity`.

Response (all fields verified):
```json
{
  "status": "Success",
  "itemNo": "1000",
  "priceListLines": [
    {
      "priceListCode": "SALES-2026",
      "variantCode": "RED",
      "unitPrice": 100,
      "unitPriceExclVAT": 90.91,
      "unitPriceInclVAT": 110.00,
      "vatPct": 11,
      "minimumQuantity": 0
    }
  ]
}
```

- When no price list is configured, returns exactly one line with `priceListCode: "ITEM CARD"` and price from the item card
- Multiple lines possible when multiple price tiers apply
- Error response: `{ "status": "Error", "error": "Item 'NONEXISTENT999' not found" }`

---

#### `Sales.Order.Release` / `Sales.Order.Reopen`

Direction: **Inbound**. `subject` = sales order number or SystemId.

Alternatively, pass `orderNo` in the data payload (subject can be empty when using data):

```json
{ "specversion": "1.0", "type": "Sales.Order.Release", "source": "BC Portal", "subject": "SO-001" }
```

Or via data:
```json
{ "specversion": "1.0", "type": "Sales.Order.Release", "source": "BC Portal", "data": "{\"orderNo\":\"SO-001\"}" }
```

Success response:
```json
{ "status": "Success", "orderNo": "SO-001", "statusAfter": "Released" }
```
(`statusAfter` is `"Released"` for Release, `"Open"` for Reopen)

Error responses:
```json
{ "status": "Error", "error": "...already released..." }
{ "status": "Error", "error": "...not found..." }
```

---

#### `Sales.Order.Statistics`

Direction: **Outbound**. `subject` = sales order number or SystemId.

Alternatively, pass `orderNo` in the data payload:

```json
{ "specversion": "1.0", "type": "Sales.Order.Statistics", "source": "BC Portal", "subject": "SO-001" }
```

Or via data:
```json
{ "specversion": "1.0", "type": "Sales.Order.Statistics", "source": "BC Portal", "data": "{\"orderNo\":\"SO-001\"}" }
```

Response (verified fields):
```json
{
  "status": "Success",
  "orderNo": "SO-001",
  "order": {
    "amount": 1000.00,
    "invoiceDiscountAmount": 50.00,
    "totalExclVAT": 950.00,
    "vatAmount": 104.50,
    "totalInclVAT": 1054.50,
    "quantity": 10,
    "totalWeight": 25.5,
    "totalVolume": 0.5,
    "noOfVATLines": 1
  },
  "vat_totals": [
    { "vatIdentifier": "NORM", "vatPct": 11, "lineAmount": 950.00, "vatAmount": 104.50 }
  ]
}
```

Error responses:
```json
{ "status": "Error", "error": "Sales order 'NONEXIST-...' not found" }
{ "status": "Error", "error": "Order number must be specified" }
```

---

#### PDF Document Retrieval

All four types follow the same pattern. `subject` = document number or SystemId.

| Type | Document |
|---|---|
| `Sales.SalesInvoice.Pdf` | Posted sales invoice |
| `Sales.SalesShipment.Pdf` | Posted shipment |
| `Sales.SalesCreditMemo.Pdf` | Posted credit memo |
| `Sales.ReturnReceipt.Pdf` | Posted return receipt |

```json
{ "specversion": "1.0", "type": "Sales.SalesInvoice.Pdf", "source": "BC Portal", "subject": "INV-001" }
```

Response: **binary PDF bytes** (`Content-Type: application/pdf`). The raw response body is the PDF — not Base64-encoded, not a URL.

When calling through the portal proxy, pipe the binary response directly to a `Blob` and create an object URL for display or download.

Errors (thrown as exceptions, not `{"status":"Error"}` responses):
- `"Subject parameter is required"` — subject is empty or missing
- `"Sales invoice 'X' not found"` — document does not exist (message varies by type)

---

## How the Portal Calls This API

### Helper needed in `api/bc/index.js`

The `/api/bc` function currently prepends `https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/v2.0/` to every path.
Cloud Events paths use a **different base**: `.../api/origo/cloudEvent/v1.0/`.

To call Cloud Events from the frontend, pass the full relative path from the BC root, e.g.:

```
/api/bc?path=origo%2FcloudEvent%2Fv1.0%2Fcompanies(...)%2Ftasks
```

Or add a dedicated `bcPost` variant that accepts a full override URL — see implementation notes.

### Two-step fetch for synchronous tasks

```js
// 1. POST the task
const task = await bcPostTask(companyId, {
  specversion: "1.0",
  type: "Data.Records.Get",
  source: "BC Portal",
  data: JSON.stringify({ tableName: "Customer", take: 200 })
});
// task.data is a full absolute URL, e.g.:
// "https://api.businesscentral.dynamics.com/v2.0/{tenantGuid}/UAT/.../responses({id})/data"

// 2. GET that URL directly — it already ends with /data
const result = await bcGetAbsolute(task.data);
// result = { status: "Success", noOfRecords: 5, result: [...] }
```

> The URL in `task.data` uses the internal tenant GUID, not the named tenant. Use it verbatim.

---

## Common Patterns

### Get all records from a table
```json
{ "type": "Data.Records.Get", "data": "{\"tableName\":\"Customer\"}" }
```

### Get specific fields only (use field numbers from Help.Fields.Get)
```json
{ "type": "Data.Records.Get", "data": "{\"tableName\":\"Customer\",\"fieldNumbers\":[1,2,5,7,21,30]}" }
```

### Get records changed since last sync
```json
{ "type": "Data.Records.Get", "data": "{\"tableName\":\"Customer\",\"startDateTime\":\"2026-03-01T00:00:00Z\"}" }
```

### Update a record
```json
{
  "type": "Data.Records.Set",
  "subject": "Customer",
  "data": "{\"data\":[{\"id\":\"<systemId>\",\"fields\":{\"Address\":\"New Road 1\"}}]}"
}
```

### Insert a new record
```json
{
  "type": "Data.Records.Set",
  "subject": "Customer",
  "data": "{\"data\":[{\"primaryKey\":{\"No_\":\"CUST-NEW\"},\"fields\":{\"Name\":\"New Co.\",\"City\":\"Reykjavik\"}}]}"
}
```

---

### Create a Sales Order with Lines and Release

Order creation is done entirely through `Data.Records.Set` — no dedicated "create order" message type exists. The full workflow is **4 sequential Cloud Events calls** (verified in `ReleaseSalesOrder_CompleteWorkflow_CreatesAndReleases` test):

#### Step 1 — Create the Sales Header

`subject` = `"Sales Header"`. The order number is set in `primaryKey.No_` (use your own numbering or a number series value from BC). `DocumentType` must be `"Order"`.

```json
{
  "type": "Data.Records.Set",
  "subject": "Sales Header",
  "data": "{\"data\":[{\"primaryKey\":{\"DocumentType\":\"Order\",\"No_\":\"SO-12345\"},\"fields\":{\"SelltoCustomerNo_\":\"C00010\",\"OrderDate\":\"2026-03-09\"}}]}"
}
```

Response — the created header's primary key is returned:
```json
{ "status": "Success", "result": [{ "primaryKey": { "DocumentType": "Order", "No_": "SO-12345" } }] }
```

#### Step 2 — Add Sales Lines

One call per line. `subject` = `"Sales Line"`. Primary key includes `DocumentType`, `DocumentNo_`, and `LineNo_` (use 10000, 20000, … spacing). `Type` = `"Item"`.

```json
{
  "type": "Data.Records.Set",
  "subject": "Sales Line",
  "data": "{\"data\":[{\"primaryKey\":{\"DocumentType\":\"Order\",\"DocumentNo_\":\"SO-12345\",\"LineNo_\":10000},\"fields\":{\"Type\":\"Item\",\"No_\":\"ITEM-001\",\"Quantity\":5,\"UnitPrice\":100.00}}]}"
}
```

Repeat for each additional line, incrementing `LineNo_` by 10000.

#### Step 3 — Release the Order

```json
{ "type": "Sales.Order.Release", "subject": "SO-12345" }
```

Response: `{ "status": "Success", "orderNo": "SO-12345", "statusAfter": "Released" }`

#### Key field names for Sales Header and Sales Line

| BC field name | JSON key | Notes |
|---|---|---|
| `Document Type` | `DocumentType` | Enum: `"Order"`, `"Invoice"`, `"Quote"`, etc. |
| `No.` | `No_` | Sales order number |
| `Sell-to Customer No.` | `SelltoCustomerNo_` | Customer number |
| `Order Date` | `OrderDate` | ISO 8601 date string |
| `External Document No.` | `ExternalDocumentNo_` | Your PO / reference number |
| `Requested Delivery Date` | `RequestedDeliveryDate` | ISO 8601 date string |
| `Document No.` (line) | `DocumentNo_` | Must match the header `No_` |
| `Line No.` (line) | `LineNo_` | Integer: 10000, 20000, … |
| `Type` (line) | `Type` | Enum: `"Item"`, `"G/L Account"`, etc. |
| `No.` (line) | `No_` | Item number |
| `Quantity` (line) | `Quantity` | Numeric |
| `Unit Price` (line) | `UnitPrice` | Numeric |

> **`tableView` field names**: Use the original BC field name (`name` from `Help.Fields.Get`) in WHERE clauses — e.g. `WHERE(Document Type=CONST(Order),No.=CONST(SO-12345))`. This differs from the normalized `jsonName` used in `Data.Records.Get` / `Data.Records.Set` field objects. When in doubt, call `Help.Fields.Get` on the table to look up the correct `name` and `jsonName` for each field.

---

### Screen-size-based Pagination

`noOfRecords` always reflects the **total number of records matching the current filters** — regardless of `skip` and `take`. Use it to drive page navigation without a separate count query.

Recommended `take` values by breakpoint:

| Screen | Breakpoint | Suggested `take` |
|---|---|---|
| Mobile | < 640 px | 25 |
| Tablet | 640 – 1024 px | 50 |
| Desktop | > 1024 px | 100 |

Pagination JS pattern:

```js
const take = window.innerWidth < 640 ? 25 : window.innerWidth < 1024 ? 50 : 100;
let currentPage = 0;  // 0-based

async function fetchPage(page) {
  const skip = page * take;
  const result = await cloudEventsGet({
    tableName: "Customer",
    tableView: "WHERE(Blocked=CONST( ))",
    fieldNumbers: [1, 2, 5, 7],
    skip,
    take
  });
  // result.noOfRecords = total matching the filter (constant across pages)
  const totalPages = Math.ceil(result.noOfRecords / take);
  return { records: result.result, totalPages, noOfRecords: result.noOfRecords };
}
```

> **Key rule**: `noOfRecords` counts records matching `tableView` and `startDateTime`/`endDateTime` filters. It is unaffected by `skip`/`take`. Always calculate pages from `noOfRecords / take`.

---

## Special Field Conversions

Certain field types undergo automatic conversion between BC internal storage and JSON representation.

### Currency Code (blank = LCY)

In BC, a blank `Currency Code` field means Local Currency (LCY). The API converts this automatically:

- **On `Data.Records.Get`**: blank → LCY code from G/L Setup (e.g. `"ISK"`, `"USD"`)
- **On `Data.Records.Set`**: send the LCY code string (e.g. `"ISK"`) → stored as blank automatically
- Round-trip safe: a get response value can be posted directly back in a set

### Dimension Set ID (field 480)

Records with a `DimensionSetID` integer field (e.g. sales lines, ledger entries) receive dimension expansion:

- **On `Data.Records.Get`**: the integer ID → array of dimension code/value pairs:
  ```json
  "DimensionSetID": [
    { "DimensionCode": "DEPT", "DimensionValueCode": "SALES" },
    { "DimensionCode": "PROJECT", "DimensionValueCode": "P001" }
  ]
  ```
- **On `Data.Records.Set`**: send the same array → resolved to the correct dimension set integer automatically
- Empty array → blank (0) dimension set

### BLOB Fields

Pure BLOB-typed fields (e.g. `"Value BLOB"` on Name/Value Buffer table 823, normalized to key `"ValueBLOB"`):

- **Get**: plain Base64 string: `"ValueBLOB": "dGhpcyBpcyB0ZXN0..."`
- **Set**: send the same Base64 string back

### Media Fields (single image)

Single `Media`-typed fields (e.g. `Image` on Customer):

- **Get**: JSON object with GUID and Base64-encoded image data:
  ```json
  "Image": { "Id": "{GUID}", "Value": "base64string" }
  ```
- **Set**: send the same object back

### MediaSet Fields (multiple images)

`MediaSet`-typed fields (multiple media items per record):

- **Get**: JSON object with GUID and array of media items:
  ```json
  "MediaSet": { "Id": "{GUID}", "Media": [ { "Id": "...", "Value": "..." } ] }
  ```
- **Set**: send the same object back

---

## Enum Values

**Get** (`Data.Records.Get`): Option/Enum fields return the **display caption** for the request language (`lcid`). When `lcid` is not set, the default language from Cloud Events Setup is used (typically English).

**Set** (`Data.Records.Set`): accepts the AL name, the display caption, or the ordinal integer as a string — all three formats are valid.

Use `Help.Fields.Get` with the same `lcid` to discover valid values: `enum[].value` = AL name (always English), `enum[].caption` = display caption for the language.

### `Customer.Blocked`

| String value | Meaning |
|---|---|
| `" "` (single space) | Not blocked (blank option) |
| `"Ship"` | Blocked from shipping |
| `"Invoice"` | Blocked from invoicing |
| `"All"` | Fully blocked |

Example in response: `"Blocked": " "` — a single space string means the customer is active (not blocked).

Example in `tableView` filter: `"WHERE(Blocked=CONST( ))"` — the space inside `CONST()` is the blank enum name.

Example in `Data.Records.Set`: `"fields": { "Blocked": "Invoice" }` — pass the English name as a string.

### `tableView` filters

`tableView` always uses the **English AL option name** (`enum[].value` from `Help.Fields.Get`), regardless of `lcid`. The original BC field name (not the normalized JSON key) is used inside `tableView`.

| Operator | Syntax | Description |
|---|---|---|
| `CONST` | `WHERE(Blocked=CONST(Ship))` | Exact match for a single value |
| `CONST` (blank enum) | `WHERE(Blocked=CONST( ))` | Match the blank/empty option (single space) |
| `FILTER` | `WHERE(Windows Language ID=FILTER(1033\|1039))` | Match any of several values — use `\|` as OR separator |
| Multiple fields | `WHERE(Document Type=CONST(Order),No.=CONST(SO-001))` | AND — comma-separated conditions |

The `FILTER` operator with `|` is especially useful when you already have a list of values — e.g. fetching only the Language rows matching your allowed LCIDs:
```json
{ "tableName": "Language", "tableView": "WHERE(Windows Language ID=FILTER(1033|1039))" }
```

---

## Language Support (LCID)

Add `"lcid": <Windows language ID>` to any request envelope. Affects:
- `Help.Tables.Get` → `caption` of each table
- `Help.Fields.Get` → `caption` of each field and `caption` of each `enum` value
- `Data.Records.Get` → values of Option/Enum fields (returned as captions)

If `lcid` is omitted or `0`, the default language from Cloud Events Setup is used.

| LCID | Language |
|---|---|
| 1033 | English (US) |
| 1039 | Icelandic |
| 1030 | Danish |
| 1031 | German |
| 1036 | French |
| 1034 | Spanish |
| 1043 | Dutch |
| 1053 | Swedish |
| 1044 | Norwegian (Bokmål) |

---

## UI String Translations (Cloud Event Translation table)

The `Cloud Event Translation` table lets you store localized captions for arbitrary UI strings — tab labels, button text, form field names — that are not directly served by BC field metadata.

### Table structure

| Column | Type | Role |
|---|---|---|
| `Source` | Code | Identifies the calling app — use the same value as the `source` in your Cloud Events requests (e.g. `"BC Portal"`) |
| `WindowsLanguageID` | Code | LCID as a string (e.g. `"1039"`) |
| `SourceText` | Text | English source string — the key you look up at runtime |
| `TargetText` | Text | Localized translation — filled in by the user directly in BC |

Primary key: `Source` + `WindowsLanguageID` + `SourceText`.

### Fetch all translations for a language

One batch request loads every translation for the active language. The `source` filter must match the `source` field in your Cloud Events envelope:

```json
{
  "specversion": "1.0",
  "type": "Data.Records.Get",
  "source": "BC Portal",
  "subject": "Cloud Event Translation",
  "data": "{\"tableView\": \"WHERE(Windows Language ID=CONST(1039),Source=CONST(BC Portal))\"}"
}
```

Response — `primaryKey.SourceText` is the English key; `fields.TargetText` is the localized value:

```json
{
  "status": "Success",
  "noOfRecords": 1,
  "result": [
    {
      "id": "CEC16092-811C-F111-8340-0022489B46A1",
      "primaryKey": { "Source": "BC Portal", "WindowsLanguageID": "1039", "SourceText": "Type" },
      "fields": { "TargetText": "Tegund" }
    }
  ]
}
```

### Fetch a single string

Append `, Source Text=CONST(<english text>)` to the `tableView` filter:

```json
{
  "data": "{\"tableView\": \"WHERE(Windows Language ID=CONST(1039),Source=CONST(BC Portal),Source Text=CONST(Type))\"}"
}
```

An empty `result` array means no translation record exists yet for that string.

### Auto-create missing translation records

When a string is missing, create a blank record via `Data.Records.Set` — the user can then fill in `TargetText` directly in Business Central:

```json
{
  "specversion": "1.0",
  "type": "Data.Records.Set",
  "source": "BC Portal",
  "subject": "Cloud Event Translation",
  "data": "{\"data\": [{\"primaryKey\": {\"Source\": \"BC Portal\", \"WindowsLanguageID\": \"1039\", \"SourceText\": \"Type\"}, \"fields\": {\"TargetText\": \"\"}}]}"
}
```

Batch-create multiple strings at once by sending an array with multiple records in `data.data`.

### Portal implementation pattern

```js
// 1. Batch-fetch all translations for the active language
const res = await cePost(companyId, {
  specversion: '1.0', type: 'Data.Records.Get', source: 'BC Portal',
  subject: 'Cloud Event Translation',
  data: JSON.stringify({ tableView: `WHERE(Windows Language ID=CONST(${lcid}),Source=CONST(BC Portal))` })
});

// 2. Build source → target map
const uiTranslations = {};
for (const rec of res.result || []) {
  const src = (rec.primaryKey || {}).SourceText;
  const tgt = (rec.fields || {}).TargetText;
  if (src && tgt) uiTranslations[src] = tgt;
}

// 3. Create blank placeholder records for any strings not yet in the table
const existing = new Set((res.result || []).map(r => r.primaryKey.SourceText));
const missing = UI_STRINGS.filter(s => !existing.has(s));
if (missing.length) {
  await cePost(companyId, {
    specversion: '1.0', type: 'Data.Records.Set', source: 'BC Portal',
    subject: 'Cloud Event Translation',
    data: JSON.stringify({
      data: missing.map(s => ({
        primaryKey: { Source: 'BC Portal', WindowsLanguageID: String(lcid), SourceText: s },
        fields: { TargetText: '' }
      }))
    })
  });
}

// 4. t() helper — falls back to the English text when no translation exists
function t(s) { return uiTranslations[s] || s; }
```

> **Note:** Skip loading entirely for `lcid === 1033` (English) since no translation is needed.

---

## Using Table Numbers and Field Numbers

The recommended pattern for querying BC data without hard-coding field names:

**Step 1 — Resolve table caption** (optional, for display):
```js
// subject can be table name ("Customer") or number ("18")
const tableResp = await cePost(companyId, {
  type: 'Help.Tables.Get', subject: '18', lcid: 1039
});
// Returns: { result: [{ id: 18, name: "Customer", caption: "Viðskiptamaður" }] }
```

**Step 2 — Get field metadata** (jsonNames + captions):
```js
const fieldsResp = await cePost(companyId, {
  type: 'Help.Fields.Get', subject: '18', lcid: 1039,
  data: JSON.stringify({ fieldNumbers: [2, 7, 35, 39, 59, 102] })
});
// Returns per field: { id, name, jsonName, caption, class, type, len, isPartOfPrimaryKey, enum? }
// class="FlowField" fields (e.g. Balance LCY) only get values when fieldNumbers is used in Step 3
```

**Step 3 — Fetch records** using `tableNumber` + `fieldNumbers`:
```js
const dataResp = await cePost(companyId, {
  type: 'Data.Records.Get',
  data: JSON.stringify({
    tableNumber: 18,
    fieldNumbers: [2, 7, 35, 39, 59, 102],
    skip: 0,
    take: 20
  })
});
// Response fields keyed by jsonName (e.g. "BalanceLCY", "EMail")
```

Key points:
- **Table identification** works three ways in `Data.Records.Get`, `Help.Tables.Get`, and `Help.Fields.Get`: (1) `data.tableNumber` integer, (2) `data.tableName` string, or (3) `subject` in the envelope (name or numeric string). First match wins.
- FlowField values (`class: "FlowField"`) **require `fieldNumbers`** — omitting it returns blank/zero for those fields.
- Option/Enum field values in the response are **captions** (language-dependent); use `enum[].value` from `Help.Fields.Get` when you need the AL name for `tableView` or `Data.Records.Set`.

---

## Error Response Shape

All errors come back as:
```json
{ "status": "Error", "message": "Descriptive error message" }
```

Or at the HTTP transport level (from `api/bc`):
```json
{ "error": "BC API 401: ..." }
```
