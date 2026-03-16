---
name: cloud-events-bc-integration
description: >
  Domain knowledge for building integration code that calls the Origo Cloud Events
  API on Microsoft Business Central. Use when a developer asks to: connect to BC via
  Cloud Events, call any Data / Help / Customer / Item / Sales message type, implement
  sync or async task submission, handle pagination, read/write record data, handle
  field name normalization, or convert enum values. Also covers: dynamic schema
  discovery with Help.Tables.Get and Help.Fields.Get, selecting only needed fields
  with fieldNumbers, tableView filtering and sorting in BC AL syntax (WHERE/FILTER/
  CONST/SORTING), UI translations via the Cloud Event Translation table, field metadata
  caching, lookup table patterns, duplicate checking, webhooks, special field
  conversions (BLOB, Media, Dimension Set, Currency Code), and creating sales orders
  via the generic Data.Records.Set workflow.
---

# Cloud Events BC Integration Skill

This skill gives you accurate, verified knowledge of the **Origo Cloud Events API** so
you can write integration code (TypeScript, JavaScript, Python, C#, AL, etc.) that
interacts with Microsoft Business Central through this API.

---

## 1. What the API Is

The Origo Cloud Events extension for Business Central exposes a REST API that follows
the [CloudEvents specification v1.0](https://cloudevents.io/). Instead of dozens of
entity-specific OData endpoints, **every operation is a CloudEvents message** sent to
one of three endpoints: `/tasks` (synchronous), `/queues` (asynchronous), or
`/responses` (fetch results).

All business logic (read records, write records, check credit limits, get PDFs, …) is
selected by the `type` field of the message envelope.

---

## 2. Base URL

```
https://api.businesscentral.dynamics.com/v2.0/{tenantId}/{environment}/api/origo/cloudEvent/v1.0/companies({companyId})/
```

| Placeholder | Source | Example |
|---|---|---|
| `{tenantId}` | Tenant domain or GUID | `dynamics.is` |
| `{environment}` | BC environment name | `UAT`, `Production` |
| `{companyId}` | Company GUID | fetched from `/companies` endpoint |

**Authentication:** OAuth 2.0 Bearer token via Microsoft Entra ID (Azure AD).  
Scope: `https://api.businesscentral.dynamics.com/.default`

> **Important:** The `data` download URL returned in task responses uses the internal
> tenant GUID (e.g. `9069b642-…`), not the named tenant. Always use the URL verbatim
> — do not reconstruct it.

---

## 3. Three Endpoints

### 3.1 `/tasks` — Synchronous (preferred for real-time use)

POST a message. BC processes it immediately. The `data` field in the response is a
**full absolute URL** ending in `/data`. GET that URL to retrieve the result.

```http
POST /companies({companyId})/tasks
Content-Type: application/json
Authorization: Bearer {token}

{
  "specversion": "1.0",
  "type": "Data.Records.Get",
  "source": "MyApp v1.0",
  "subject": "Customer",
  "data": "{\"tableName\":\"Customer\",\"take\":100}"
}
```

Response:
```json
{
  "id": "7df25b48-ec25-498f-b8cf-566044ae020d",
  "type": "Data.Records.Get",
  "data": "https://api.businesscentral.dynamics.com/v2.0/{tenantGuid}/UAT/api/origo/cloudEvent/v1.0/companies({companyId})/responses(7df25b48-ec25-498f-b8cf-566044ae020d)/data"
}
```

Then:
```http
GET {task.data}
Authorization: Bearer {token}
```

### 3.2 `/queues` — Asynchronous

Same request body. BC returns immediately; job runs in background.

```http
POST /companies({companyId})/queues                                         ← submit
POST /companies({companyId})/queues({id})/Microsoft.NAV.GetStatus           ← poll
POST /companies({companyId})/queues({id})/Microsoft.NAV.RetryTask           ← retry
GET  /companies({companyId})/queues({id})                                   ← read
```

`GetStatus` values: `Created` (still running) · `Updated` (done) · `Deleted` (no task) · `None`

### 3.3 `/responses({id})/data` — Download Results

Always use the URL from `task.data` verbatim. Do not construct it manually.

---

## 3b. Listing Message History (GET queues / tasks)

Both endpoints support standard OData **GET** to list previously submitted messages. Use `$filter` on `source` to scope results to your own application.

### List queue history
```http
GET /companies({companyId})/queues?$filter=source eq 'MyApp v1.0'
Authorization: Bearer {token}
```

### List task history
```http
GET /companies({companyId})/tasks?$filter=source eq 'MyApp v1.0'
Authorization: Bearer {token}
```

Without a filter both return **all** messages in the company across all sources — always filter by `source` in production.

### Response shape (same for both endpoints)

```json
{
  "@odata.context": ".../$metadata#companies(...)/queues",
  "value": [
    {
      "@odata.etag": "W/\"...\"",
      "id": "fb304e23-2aac-43fa-a16d-5bc837a52830",
      "specversion": "1.0",
      "type": "Data.Records.Get",
      "source": "MyApp v1.0",
      "time": "2026-03-16T10:18:51.303Z",
      "subject": "",
      "lcid": 0,
      "datacontenttype": "text/json",
      "data": "https://api.businesscentral.dynamics.com/v2.0/{tenantGuid}/UAT/api/origo/cloudEvent/v1.0/companies({companyId})/responses(fb304e23-2aac-43fa-a16d-5bc837a52830)/data"
    }
  ]
}
```

Key fields:

| Field | Description |
|---|---|
| `id` | Message GUID — use it as the queue/task ID and as the response ID |
| `type` | The message type that was executed |
| `source` | The caller identifier set in the original request |
| `time` | When the message was submitted (UTC) |
| `subject` | Optional subject sent by the caller (table name, document no., etc.) |
| `lcid` | Language requested (0 = default) |
| `datacontenttype` | Content type of the response (`text/json`, `text/markdown`, `application/pdf`, …) |
| `data` | Absolute URL to fetch the response body — GET this URL to retrieve results |

The `data` URL is always in the form `.../responses({id})/data`. You can fetch it at any time after the message is processed.

### Queue-specific: poll status and retry

These actions are only available on `/queues`, not `/tasks` (tasks are already completed synchronously).

**Poll status**
```http
POST /companies({companyId})/queues({id})/Microsoft.NAV.GetStatus
Authorization: Bearer {token}
```

Returns the current processing status:

| Status | Meaning |
|---|---|
| `Created` | Job is still running |
| `Updated` | Job completed successfully — `data` URL is ready |
| `Deleted` | Queue entry no longer exists |
| `None` | Unknown / not found |

**Retry a failed job**
```http
POST /companies({companyId})/queues({id})/Microsoft.NAV.RetryTask
Authorization: Bearer {token}
```

Requeues the same message for re-processing. Use after investigating a `Created`-but-stalled or errored entry.

### JavaScript polling pattern

```js
async function pollUntilDone(companyId, messageId, token, maxWaitMs = 30_000) {
  const base = `${BASE_URL}/companies(${companyId})/queues(${messageId})`;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const st = await fetch(`${base}/Microsoft.NAV.GetStatus`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json());
    if (st.value === 'Updated') return; // done
    if (st.value === 'Deleted')  throw new Error('Queue entry deleted');
    await new Promise(r => setTimeout(r, 2000)); // wait 2 s before next poll
  }
  throw new Error('Timed out waiting for queue message to complete');
}
```

---

## 4. Request Envelope

Every POST body follows this structure:

| Field | Required | Type | Notes |
|---|---|---|---|
| `specversion` | Yes | string | Always `"1.0"` |
| `type` | Yes | string | Message type, e.g. `"Data.Records.Get"` |
| `source` | Yes | string | Caller identifier, e.g. `"MyApp v2.3"` |
| `id` | No | GUID | Auto-generated if omitted |
| `subject` | Depends | string | Target record key (customer no., table name, order no., item no., …). Required by some types. |
| `data` | Depends | **JSON string** | Input parameters. **Must be serialized to a string**: `"data": "{\"tableName\":\"Customer\"}"`. Not an object. |
| `lcid` | No | integer | Windows Language ID for localised captions. 1033 = English, 1039 = Icelandic. Defaults to Cloud Events Setup language. |
| `datacontenttype` | No | string | `"application/json"` — informational only |

---

## 5. Response Patterns

### Pattern A — Two-step (most data operations)

1. POST returns `{ …, "data": "<url>" }`
2. GET the URL → result JSON

### Pattern B — Direct response (some operations)

PDF types and some inbound operations embed status/error directly in the POST response.
No `data` URL. Check `response.status === "Error"` immediately.

### Error handling order

```
POST /tasks
  ├─ if response.status === "Error"   → direct error (no data URL)
  └─ if response.data exists
       └─ GET response.data
            ├─ if result.status === "Error"   → task execution error
            └─ if result.status === "Success" → use result
```

Error shape:
```json
{
  "status": "Error",
  "error": "Human-readable error message",
  "callStack": "Codeunit.Method line N — ..."
}
```

---

## 6. Data Field Naming — Field Name Normalization

BC field names are normalized to JSON keys using two steps applied in order:

1. Replace each of `` % . " \ / ' `` with `_`
2. Strip every remaining character that is **not** `_`, a letter (`A–Z`, `a–z`), or a digit (`0–9`)

```
BC field name          → JSON key
──────────────────────────────────
No.                    → No_
Phone No.              → PhoneNo_
E-Mail                 → EMail
Credit Limit (LCY)     → CreditLimitLCY
G/L Account No.        → G_LAccountNo_
Sell-to Customer No.   → SelltoCustomerNo_
Dimension Set ID       → DimensionSetID
Unit Price             → UnitPrice
Document Type          → DocumentType
```

**Golden rule: call `Help.Fields.Get` on the table to get the exact `jsonName` for any field. Do not guess.**

- `name` → original BC field name (use in `tableView` WHERE clauses)
- `jsonName` → normalized JSON key (use in `Data.Records.Get` / `Data.Records.Set` field objects)
- `caption` → localised display label (use for UI only, not in queries)

---

## 7. All Message Types

### 7.1 DATA OPERATIONS

#### `Data.Records.Get` — Read table records

Direction: **Outbound**

Table identification (evaluated in this priority order):
1. `data.tableNumber` (or `tableNo` / `tableId`) — integer
2. `data.tableName` — string
3. `subject` — table name or numeric string

```json
{
  "specversion": "1.0",
  "type": "Data.Records.Get",
  "source": "MyApp v1.0",
  "data": "{\"tableName\":\"Customer\",\"fieldNumbers\":[1,2,5,7],\"tableView\":\"WHERE(Blocked=CONST( ))\",\"startDateTime\":\"2026-01-01T00:00:00Z\",\"endDateTime\":\"2026-12-31T23:59:59Z\",\"skip\":0,\"take\":100}"
}
```

Input parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tableName` | string | — | Table name (e.g. `"Customer"`) |
| `tableNumber` / `tableNo` / `tableId` | integer | — | Table number (e.g. `18`) |
| `fieldNumbers` | int[] | all fields | Field numbers to return. When specified, FlowFields are also calculated. |
| `startDateTime` | ISO 8601 | — | Filter by `SystemModifiedAt` ≥ |
| `endDateTime` | ISO 8601 | — | Filter by `SystemModifiedAt` ≤ |
| `tableView` | string | — | BC table view filter (see §11) |
| `skip` | integer | 0 | Pagination offset |
| `take` | integer | 100 | Page size |

Response:
```json
{
  "status": "Success",
  "noOfRecords": 245,
  "result": [
    {
      "id": "7FE8C74C-7A01-F111-A1F9-6045BD750E1F",
      "primaryKey": { "No_": "10000" },
      "fields": {
        "Name": "Adatum Corporation",
        "CreditLimitLCY": 10000.50,
        "Blocked": " "
      }
    }
  ]
}
```

- `id` = SystemId (GUID, uppercase)
- `noOfRecords` = **total count matching all filters** — unaffected by `skip`/`take`. Use for pagination: `totalPages = Math.ceil(noOfRecords / take)`
- `primaryKey` = PK fields only; never appears in `fields`
- `fields` = non-PK fields; only the normalised `jsonName` is used as key
- Option/Enum fields return the **display caption** in the requested `lcid`
- FlowFields are **only calculated when `fieldNumbers` is specified**
- Blank `Date` fields return as `null` or `"0001-01-01"`
- Currency Code blank = LCY code (see §9)
- Dimension Set ID returns as array (see §9)

#### `Data.RecordIds.Get` — IDs + timestamps (fast incremental sync)

Direction: **Outbound**

Same parameters as `Data.Records.Get` except no `fieldNumbers`. Returns only SystemId and `SystemModifiedAt`.

**`startDateTime` and `endDateTime` are both optional:**
- Omit `startDateTime` → defaults to `0DT` (beginning of time, returns all records from the start)
- Omit `endDateTime` → defaults to `CurrentDateTime()` (up to now)
- Omit both → returns IDs for all records in the table

```json
{
  "specversion": "1.0",
  "type": "Data.RecordIds.Get",
  "source": "MyApp v1.0",
  "data": "{\"tableName\":\"Customer\",\"startDateTime\":\"2026-01-01T00:00:00Z\"}"
}
```

Minimal form (all records, no date filter):
```json
{
  "specversion": "1.0",
  "type": "Data.RecordIds.Get",
  "source": "MyApp v1.0",
  "data": "{\"tableName\":\"Customer\"}"
}
```

Response:
```json
{
  "status": "Success",
  "noOfRecords": 150,
  "result": [
    { "id": "3F915906-44FF-F011-A1FB-7CED8DB3A1C7", "modifiedAt": "2026-03-09T20:55:57.89Z" }
  ]
}
```

#### `Data.Records.Set` — Insert or update records

Direction: **Inbound**

Table identified via `subject` (table name or number string) **or** `tableName`/`tableNumber` inside `data`.

```json
{
  "specversion": "1.0",
  "type": "Data.Records.Set",
  "source": "MyApp v1.0",
  "subject": "Customer",
  "data": "{\"data\":[{\"id\":\"7FE8C74C-7A01-F111-A1F9-6045BD750E1F\",\"fields\":{\"Address\":\"New Road 1\",\"City\":\"Reykjavik\"}}]}"
}
```

Each record in the `data` array:

| Field | Use |
|---|---|
| `id` (GUID string) | Update by SystemId — send alongside `fields` |
| `primaryKey` | Insert (if not found) or update (if found) by PK |
| `fields` | Fields to set/update. Never include PK fields here. |
| `identityInsert` | true = insert with the specified `id` as SystemId |

Lookup logic: `id` provided → find by SystemId and update; `primaryKey` only → find-or-insert by PK; both → `id` takes precedence.

**Field values in `fields` must be strings**:
- Decimal: `"CreditLimitLCY": "25000.75"`
- Boolean: `"PrintStatements": "true"`
- Option/Enum: `"Blocked": "Ship"` (AL name, localised caption, or ordinal string — all valid)
- Currency Code: send `"ISK"` (the LCY code) to store blank — see §9
- Dimension Set ID: send the array you received from Get — see §9

Response:
```json
{
  "status": "Success",
  "insertedCount": 1,
  "modifiedCount": 0,
  "result": [{ "id": "…", "primaryKey": {…}, "fields": {…} }]
}
```

---

### 7.2 METADATA OPERATIONS

All metadata types use `/tasks`. `data` must be a JSON string.

#### `Help.Tables.Get` — List all tables

```json
{ "specversion": "1.0", "type": "Help.Tables.Get", "source": "MyApp v1.0", "lcid": 1033 }
```

Single-table lookup — three approaches (evaluated in priority order):
1. `data.tableNumber` — integer in `data`
2. `data.tableName` — string in `data`
3. `subject` — table name or numeric string in the envelope

```json
{ "specversion": "1.0", "type": "Help.Tables.Get", "source": "MyApp", "subject": "Customer" }
{ "specversion": "1.0", "type": "Help.Tables.Get", "source": "MyApp", "data": "{\"tableNumber\":18}", "lcid": 1039 }
```

Response: `{ "status": "Success", "result": [{ "id": 18, "name": "Customer", "caption": "Customer" }] }`

#### `Help.Fields.Get` — Field metadata for a table

```json
{
  "specversion": "1.0",
  "type": "Help.Fields.Get",
  "source": "MyApp v1.0",
  "lcid": 1033,
  "data": "{\"tableName\":\"Customer\",\"fieldNumbers\":[1,2,21,39,59]}"
}
```

Response per field:
```json
{
  "id": 39,
  "name": "Blocked",
  "jsonName": "Blocked",
  "caption": "Blocked",
  "class": "Normal",
  "type": "Option",
  "len": 4,
  "isPartOfPrimaryKey": false,
  "enum": [
    { "value": " ",       "caption": " ",       "ordinal": 0 },
    { "value": "Ship",    "caption": "Ship",    "ordinal": 1 },
    { "value": "Invoice", "caption": "Invoice", "ordinal": 2 },
    { "value": "All",     "caption": "All",     "ordinal": 3 }
  ]
}
```

- `name` → use in `tableView` WHERE clauses
- `jsonName` → use as the key in `Data.Records.Get` / `Data.Records.Set` field objects
- `caption` → display only (changes with `lcid`)
- `enum[].value` → always-English AL name (use in Set and tableView)
- `enum[].caption` → localised caption (matches what Get returns)
- `class` → `"Normal"` or `"FlowField"` (FlowFields only calculated when `fieldNumbers` specified in Get)

#### `Help.MessageTypes.Get` — Discover all message types

```json
{ "specversion": "1.0", "type": "Help.MessageTypes.Get", "source": "MyApp" }
```

Response: `{ "result": [{ "name": "Data.Records.Get", "description": "…", "messageDirection": "Outbound" }] }`

#### `Help.Implementation.Get` — Docs for a specific message type

```json
{
  "specversion": "1.0",
  "type": "Help.Implementation.Get",
  "source": "MyApp",
  "subject": "Data.Records.Get"
}
```

Returns Markdown documentation for the requested message type.

#### `Help.Permissions.Get` — Check table permissions for current user

```json
{
  "specversion": "1.0",
  "type": "Help.Permissions.Get",
  "source": "MyApp",
  "subject": "Customer"
}
```

Response: `{ "tableName": "Customer", "readPermission": true, "writePermission": false }`

---

### 7.3 SALES, CUSTOMER & ITEM OPERATIONS

#### `Customer.CreditLimit.Get`

Direction: **Outbound**. `subject` = customer number.

```json
{ "specversion": "1.0", "type": "Customer.CreditLimit.Get", "source": "MyApp", "subject": "10000" }
```

Response (all verified fields):
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
  "tolerancePercent": 10,
  "remainingCreditWithTolerance": 3500.00,
  "isCreditLimitExceeded": false,
  "hasOverdueBalance": true
}
```

- `remainingCredit` = `creditLimitLCY − balanceLCY − outstandingAmountLCY` (can be negative)
- `remainingCreditWithTolerance` = `creditLimitLCY × (1 + tolerancePercent/100) − balanceLCY − outstandingAmountLCY`
- `isCreditLimitExceeded` = true only when remaining credit **with tolerance** is negative
- Errors: invalid customer number throws a top-level error (no `{"status":"Error"}`)

#### `Customer.SalesHistory.Get`

Direction: **Outbound**. `subject` = customer number (or provide `customerNo` in `data`).

```json
{
  "specversion": "1.0",
  "type": "Customer.SalesHistory.Get",
  "source": "MyApp",
  "subject": "10000",
  "data": "{\"fromDate\":\"2025-01-01\",\"toDate\":\"2025-12-31\"}"
}
```

Parameters: `fromDate` (required, YYYY-MM-DD), `toDate` (optional, defaults to today), `customerNo` (if not in `subject`).

Response:
```json
{
  "status": "Success",
  "noOfRecords": 5,
  "customerNo": "10000",
  "customerName": "Adatum Corporation",
  "fromDate": "2025-01-01",
  "toDate": "2025-12-31",
  "salesHistory": [
    {
      "itemNo": "1000",
      "variantCode": "",
      "description": "Bicycle",
      "unitOfMeasureCode": "PCS",
      "baseUnitOfMeasure": "PCS",
      "baseUOMDescription": "Piece",
      "quantity": 25,
      "noOfOrders": 3
    }
  ]
}
```

Based on posted sales invoices only. `noOfOrders` = count of sales invoice lines for that item.

#### `Item.Availability.Get`

Direction: **Outbound**. `subject` = item number.

```json
{
  "specversion": "1.0",
  "type": "Item.Availability.Get",
  "source": "MyApp",
  "subject": "1000",
  "data": "{\"requestedDeliveryDate\":\"2026-04-01\",\"variantCode\":\"RED\",\"locationFilter\":\"BLUE|RED\"}"
}
```

Optional parameters: `requestedDeliveryDate` (date), `variantCode`, `locationFilter` (BC filter syntax).

Response depends on Cloud Events Setup — two formats:

**Physical Inventory** (simpler):
```json
{
  "status": "Success",
  "itemNo": "1000",
  "itemDescription": "Bicycle",
  "baseUnitOfMeasure": "PCS",
  "inventory": [
    { "locationCode": "BLUE", "inventory": 50 }
  ]
}
```

**Calculated Quantity** (projected availability):
```json
{
  "status": "Success",
  "itemNo": "1000",
  "requestedDeliveryDate": "2026-04-01",
  "availability": [
    {
      "locationCode": "BLUE",
      "inventory": 50,
      "qtyReserved": 10,
      "grossRequirement": 20,
      "scheduledReceipt": 30,
      "plannedOrderReceipt": 15,
      "availableQuantity": 70
    }
  ]
}
```

#### `Item.Price.Get`

Direction: **Outbound**. `subject` = item number.

```json
{
  "specversion": "1.0",
  "type": "Item.Price.Get",
  "source": "MyApp",
  "subject": "1000",
  "data": "{\"customerNo\":\"10000\",\"requestedDeliveryDate\":\"2026-04-01\",\"quantity\":10,\"variantCode\":\"RED\"}"
}
```

Response:
```json
{
  "status": "Success",
  "itemNo": "1000",
  "priceListLines": [
    {
      "priceListCode": "SALES-2026",
      "variantCode": "RED",
      "unitPrice": 100.00,
      "unitPriceExclVAT": 90.91,
      "unitPriceInclVAT": 110.00,
      "vatPct": 11,
      "minimumQuantity": 0
    }
  ]
}
```

When no price list is configured, returns one line with `"priceListCode": "ITEM CARD"`.

#### `Sales.Order.Release` / `Sales.Order.Reopen`

Direction: **Inbound**. `subject` = sales order number or SystemId. Or pass `orderNo` in `data`.

```json
{ "specversion": "1.0", "type": "Sales.Order.Release", "source": "MyApp", "subject": "SO-001" }
```

Success: `{ "status": "Success", "orderNo": "SO-001", "statusAfter": "Released" }`  
Reopen returns `"statusAfter": "Open"`.

#### `Sales.Order.Statistics`

Direction: **Outbound**. `subject` = order number or SystemId. Or pass `orderNo` in `data`.

```json
{ "specversion": "1.0", "type": "Sales.Order.Statistics", "source": "MyApp", "subject": "SO-001" }
```

Response:
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

#### PDF Document Retrieval

Direction: **Outbound**. `subject` = document number or SystemId.

| Type | Document |
|---|---|
| `Sales.SalesInvoice.Pdf` | Posted sales invoice |
| `Sales.SalesShipment.Pdf` | Posted shipment |
| `Sales.SalesCreditMemo.Pdf` | Posted credit memo |
| `Sales.ReturnReceipt.Pdf` | Posted return receipt |

#### PDF Document Retrieval

Direction: **Outbound**. `subject` = document number or SystemId.

| Type | Document |
|---|---|
| `Sales.SalesInvoice.Pdf` | Posted sales invoice |
| `Sales.SalesShipment.Pdf` | Posted shipment |
| `Sales.SalesCreditMemo.Pdf` | Posted credit memo |
| `Sales.ReturnReceipt.Pdf` | Posted return receipt |

```json
{ "specversion": "1.0", "type": "Sales.SalesInvoice.Pdf", "source": "MyApp", "subject": "INV-001" }
```

**Response flow — two steps, same as all other message types:**

The POST to `/tasks` returns a standard JSON envelope. When successful, `datacontenttype`
will be `"application/pdf"` and `data` contains the **full absolute download URL** to
the binary PDF file — exactly the same pattern as `Data.Records.Get`:

```json
{
  "id": "7df25b48-ec25-498f-b8cf-566044ae020d",
  "specversion": "1.0",
  "type": "Sales.SalesInvoice.Pdf",
  "source": "MyApp",
  "subject": "INV-001",
  "datacontenttype": "application/pdf",
  "data": "https://api.businesscentral.dynamics.com/v2.0/{tenantGuid}/UAT/api/origo/cloudEvent/v1.0/companies({companyId})/responses(7df25b48-...)/data"
}
```

Then GET the `data` URL with a Bearer token to download the raw binary PDF bytes:

```javascript
// Step 1 — POST the task
const task = await fetch(`${BASE}/companies(${companyId})/tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ specversion: '1.0', type: 'Sales.SalesInvoice.Pdf',
                         source: 'MyApp', subject: 'INV-001' })
}).then(r => r.json());

// Step 2 — GET the binary PDF from the download URL
const pdfResponse = await fetch(task.data, {
  headers: { Authorization: `Bearer ${token}` }
});
const pdfBlob = await pdfResponse.blob();

// Use in browser — open or trigger download
const url = URL.createObjectURL(pdfBlob);
window.open(url);  // or: downloadLink.href = url; downloadLink.click();
```

> **Key point:** `task.datacontenttype === "application/pdf"` signals that the `data`
> URL returns binary content. Use `response.blob()` or `response.arrayBuffer()` — do
> **not** call `response.json()` on the download step.

Errors from the POST response are thrown as exceptions (not `{"status":"Error"}`):
`"Subject parameter is required"`, `"Sales invoice 'X' not found"`.

---

## 8. Pagination Pattern

`noOfRecords` always equals the **total records matching all filters** regardless of `skip`/`take`. Never changes between pages — use it once to calculate total pages.

```javascript
const take = 100;
let skip = 0;

const first = await cePost(companyId, {
  type: "Data.Records.Get",
  data: JSON.stringify({ tableName: "Customer", skip, take })
});

const totalPages = Math.ceil(first.noOfRecords / take);

// Page N:
skip = pageIndex * take;
```

---

## 9. Special Field Conversions

### Currency Code (blank = LCY)

BC stores blank `Currency Code` to mean Local Currency.

- **Get** → blank is returned as the LCY currency code from G/L Setup, e.g. `"ISK"` or `"USD"`
- **Set** → send that same LCY code string back; API converts it to blank automatically
- Round-trip safe: use the value you received from Get directly in Set

### Dimension Set ID (field 480)

- **Get** → integer is expanded to an array:
  ```json
  "DimensionSetID": [
    { "DimensionCode": "DEPT", "DimensionValueCode": "SALES" }
  ]
  ```
- **Set** → send the same array back; API resolves it to the integer automatically
- Empty array = blank (0) dimension set

### BLOB Fields

- **Get** → plain Base64 string: `"ValueBLOB": "dGhpcyBpcyB0ZXN0..."`
- **Set** → send the same Base64 string

### Media (single image)

- **Get** → `{ "Id": "{GUID}", "Value": "base64string" }`
- **Set** → send the same object

### MediaSet (multiple images)

- **Get** → `{ "Id": "{GUID}", "Media": [{ "Id": "…", "Value": "…" }] }`
- **Set** → send the same object

---

## 10. Enum / Option Handling

**Get** returns the **display caption** for the requested `lcid`.  
Set accepts **any** of:
- AL name (always English): `"Ship"`, `"Invoice"`, `"All"`
- Display caption (localised): `"Afhenda"` (Icelandic for Ship)
- Ordinal as string: `"1"`

Use `Help.Fields.Get` to discover valid values. `enum[].value` = AL name, `enum[].caption` = localised caption.

`Customer.Blocked` example: `" "` (single space string) = not blocked (blank option).

---

## 11. tableView Filter Syntax

`tableView` uses BC's AL table view syntax. Use the **`name`** from `Help.Fields.Get` (not `jsonName`) in WHERE clauses.

```
WHERE(FieldName=CONST(value))                                   ← exact match
WHERE(FieldName=FILTER(>1000))                                  ← comparison
WHERE(FieldName=FILTER(>0&<10000))                              ← range
WHERE(FieldName=FILTER(@*Corp*))                                ← case-insensitive contains (*)
WHERE(FieldName=FILTER(DEPT|SALES))                            ← OR
WHERE(Blocked=CONST( ))                                         ← blank/empty option
WHERE(Posting Date=FILTER(>=2026-01-01&<=2026-12-31))
WHERE(Blocked=CONST( ),Balance (LCY)=FILTER(>0))               ← multiple fields with AND
```

Operators: `CONST` (exact), `FILTER` (pattern/range), `>` `<` `>=` `<=`, `&` (AND on same field), `|` (OR), `*` (wildcard), `@` (case-insensitive), `..` (range).

---

## 12. Creating Sales Orders Workflow

There is no dedicated "create order" message type. Use `Data.Records.Set` for all steps.

### Step 1 — Create Sales Header

```json
{
  "type": "Data.Records.Set",
  "subject": "Sales Header",
  "data": "{\"data\":[{\"primaryKey\":{\"DocumentType\":\"Order\",\"No_\":\"SO-12345\"},\"fields\":{\"SelltoCustomerNo_\":\"C00010\",\"OrderDate\":\"2026-03-09\"}}]}"
}
```

### Step 2 — Add Sales Lines (one call per line)

```json
{
  "type": "Data.Records.Set",
  "subject": "Sales Line",
  "data": "{\"data\":[{\"primaryKey\":{\"DocumentType\":\"Order\",\"DocumentNo_\":\"SO-12345\",\"LineNo_\":10000},\"fields\":{\"Type\":\"Item\",\"No_\":\"ITEM-001\",\"Quantity\":\"5\",\"UnitPrice\":\"100.00\"}}]}"
}
```

Increment `LineNo_` by 10000 for each additional line.

### Step 3 — Release

```json
{ "type": "Sales.Order.Release", "subject": "SO-12345" }
```

Key field name reference:

| BC field | JSON key |
|---|---|
| `Document Type` | `DocumentType` |
| `No.` | `No_` |
| `Sell-to Customer No.` | `SelltoCustomerNo_` |
| `Order Date` | `OrderDate` |
| `External Document No.` | `ExternalDocumentNo_` |
| `Document No.` (line) | `DocumentNo_` |
| `Line No.` (line) | `LineNo_` |
| `Type` (line) | `Type` |
| `No.` (line) | `No_` |
| `Quantity` (line) | `Quantity` |
| `Unit Price` (line) | `UnitPrice` |

---

## 13. Webhooks (External Business Events)

BC raises two native external events:

| Event | Raised when |
|---|---|
| `CloudEventMessageCompleted` | Message processes successfully |
| `CloudEventMessageFailed` | Message processing fails |

Subscribe via BC's Event Subscriptions page. Webhook payload (minimal by design):

```json
{
  "MessageId": "a8f5f167-8f2c-4a42-9b3e-5c6c7d8e9f0a",
  "MessageType": "Customer.CreditLimit.Get",
  "ResponseContentLink": "/api/origo/cloudEvent/v1.0/responses(a8f5f167-…)/data",
  "Timestamp": "2026-03-08T14:30:22Z"
}
```

After receiving the webhook, GET `ResponseContentLink` (with Bearer token) to retrieve the full result.

---

## 14. Language Support (LCID)

Set `lcid` at the message envelope level (not inside `data`) to receive captions in a specific language.

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

If omitted, uses the Default Language Code from Cloud Events Setup.

---

## 15. JavaScript/TypeScript Helper Pattern

```typescript
const BASE = `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/${ENV}/api/origo/cloudEvent/v1.0`;

async function cePost(companyId: string, message: object, token: string) {
  const res = await fetch(`${BASE}/companies(${companyId})/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ specversion: '1.0', source: 'MyApp v1.0', ...message }),
  });
  const task = await res.json();
  // Direct error (PDF types, some inbound)
  if (task.status === 'Error') throw new Error(task.error);
  // Two-step: fetch the data URL
  if (task.data) {
    const dataRes = await fetch(task.data, { headers: { Authorization: `Bearer ${token}` } });
    const result = await dataRes.json();
    if (result.status === 'Error') throw new Error(`${result.error}\n${result.callStack}`);
    return result;
  }
  return task;
}

// Read records example
const customers = await cePost(companyId, {
  type: 'Data.Records.Get',
  data: JSON.stringify({ tableName: 'Customer', fieldNumbers: [1, 2, 5, 7], take: 100 }),
}, token);

// Write record example
await cePost(companyId, {
  type: 'Data.Records.Set',
  subject: 'Customer',
  data: JSON.stringify({ data: [{ id: systemId, fields: { Address: 'New Road 1' } }] }),
}, token);

// Get field metadata
const fields = await cePost(companyId, {
  type: 'Help.Fields.Get',
  data: JSON.stringify({ tableName: 'Customer' }),
  lcid: 1033,
}, token);
```

---

## 16. Common Mistakes to Avoid

1. **`data` must be a JSON string** — `"data": "{\"tableName\":\"Customer\"}"` not `"data": {"tableName": "Customer"}`. Failing to stringify is the most common error.

2. **Don't reconstruct the data URL** — the URL in `task.data` uses the internal tenant GUID. Always use it verbatim.

3. **Field values in `Data.Records.Set` must be strings** — even numbers and booleans: `"Quantity": "5"` not `"Quantity": 5`.

4. **FlowFields are blank unless `fieldNumbers` is specified** in `Data.Records.Get`.

5. **`noOfRecords` does not change with pagination** — it is always the total matching-filter count. Don't re-request it per page.

6. **Primary key fields must never appear in `fields`** in `Data.Records.Set` — put them in `primaryKey` only.

7. **PDF response is binary** — do not try to JSON-parse it. Use `response.arrayBuffer()` or `response.blob()`.

8. **`tableView` field names differ from JSON keys** — use the `name` from `Help.Fields.Get` in WHERE clauses, not `jsonName`.

9. **Enum/Option values in `tableView`** must use the AL name (always English), not the localised caption.

10. **`subject` can accept a GUID** (the record's SystemId) for most typed message types — useful for document lookups when you don't have the document number.

---

## 17. Dynamic Schema Discovery — Know Before You Code

Before hard-coding field numbers or table names, use the metadata message types to
discover exactly what is available in the target BC environment. This pattern is
especially important for multi-tenant integrations where different BC deployments may
have extensions that add extra fields or tables.

### 17.1 Discover Tables

Call `Help.Tables.Get` once at startup (or on company switch) to build a local table
index. Cache the result — it rarely changes.

```javascript
// Fetch all tables, captions in user's language
const tablesRes = await cePost(companyId, {
  type: 'Help.Tables.Get',
  lcid: userLcid   // e.g. 1033
});
// tablesRes.result = [{ id: 18, name: "Customer", caption: "Customer" }, ...]

// Build lookup maps
const tableByName   = Object.fromEntries(tablesRes.result.map(t => [t.name, t]));
const tableById     = Object.fromEntries(tablesRes.result.map(t => [t.id,   t]));
const tableByCaption = Object.fromEntries(tablesRes.result.map(t => [t.caption, t]));

// Resolve a user-chosen table
const customerTable = tableByName['Customer'];   // { id: 18, name: "Customer", caption: "Customer" }
const tableNumber   = customerTable.id;          // 18 — use as tableNumber in Data.Records.Get
```

`BC_Tables.json` (shipped alongside the portal codebase) is a **cached snapshot** of
this call for the reference environment. Use it during development to look up table IDs
without hitting BC. Always prefer a live `Help.Tables.Get` call at runtime.

**Key tables for common integration work:**

| Table No. | Name | Common Use |
|---|---|---|
| 3 | Payment Terms | Lookup dropdown |
| 4 | Currency | Lookup dropdown |
| 8 | Language | UI language picker + customer language field |
| 9 | Country/Region | Address lookups |
| 13 | Salesperson/Purchaser | Dropdown |
| 14 | Location | Dropdown |
| 18 | Customer | Master data |
| 21 | Cust. Ledger Entry | Customer ledger |
| 23 | Vendor | Master data |
| 27 | Item | Product catalog |
| 32 | Item Ledger Entry | Inventory movements |
| 36 | Sales Header | Sales orders, invoices |
| 37 | Sales Line | Sales order lines |
| 92 | Customer Posting Group | Posting setup |
| 110 | Sales Shipment Header | Posted shipments |
| 112 | Sales Invoice Header | Posted invoices |
| 114 | Sales Cr.Memo Header | Posted credit memos |
| 225 | Post Code | Address auto-fill |
| 250 | Gen. Business Posting Group | Posting setup |
| 289 | Payment Method | Lookup dropdown |
| 323 | VAT Business Posting Group | Tax setup |

### 17.2 Discover Fields

Call `Help.Fields.Get` to get the complete field catalogue for a table including:
- Field number (`id`) — use as entries in the `fieldNumbers` array
- `name` — original BC field name — use in `tableView` WHERE clauses
- `jsonName` — normalized JSON key — use in `Data.Records.Set` `fields` objects and to read from `Data.Records.Get` responses
- `caption` — localised display label — use in UI only
- `type` — `Text`, `Code`, `Decimal`, `Integer`, `Boolean`, `Date`, `DateTime`, `Option`, `GUID`, `Blob`, `Media`, `MediaSet`, etc.
- `class` — `Normal` or `FlowField`
- `isPartOfPrimaryKey` — PK fields go in `primaryKey`, not `fields`
- `enum[]` — present when type is Option; lists AL names, captions, and ordinals

```javascript
// Get all fields for Customer table in user's language
const fieldsRes = await cePost(companyId, {
  type: 'Help.Fields.Get',
  data: JSON.stringify({ tableName: 'Customer' }),
  lcid: userLcid
});

// Build lookup: fieldNumber → field metadata
const fieldMeta = Object.fromEntries(fieldsRes.result.map(f => [f.id, f]));

// Look up a specific field
const blockedField = fieldsRes.result.find(f => f.name === 'Blocked');
// blockedField.jsonName  = "Blocked"
// blockedField.enum      = [{ value: " ", caption: "…", ordinal: 0 }, …]

// Build a list of only the fields you care about
const CUSTOMER_FIELDS = [
  2,   // Name
  7,   // City
  35,  // Country/Region Code
  39,  // Blocked
  59,  // Balance (LCY)  ← FlowField — only returned when fieldNumbers specified
  102, // E-Mail
  140, // Image
];
```

**Never guess a `jsonName`** — always derive it from `Help.Fields.Get`. For example:
- `"Credit Limit (LCY)"` → `jsonName: "CreditLimitLCY"`  (parentheses stripped)
- `"No."` → `jsonName: "No_"`  (period replaced with underscore)
- `"Country/Region Code"` → `jsonName: "Country_RegionCode"` (slash replaced, space stripped)
- `"G/L Account No."` → `jsonName: "G_LAccountNo_"`

### 17.3 Field Metadata Caching Pattern

Field metadata is stable within a session but **must be re-fetched when the language
changes** (captions are language-specific).

```javascript
const fieldMetaCache = {};  // keyed: "{companyId}:{lcid}:{tableName}"

async function getFieldMeta(companyId, tableName, lcid, fieldNumbers = []) {
  const key = `${companyId}:${lcid}:${tableName}`;
  if (fieldMetaCache[key]) return fieldMetaCache[key];
  
  const res = await cePost(companyId, {
    type: 'Help.Fields.Get',
    data: JSON.stringify({
      tableName,
      ...(fieldNumbers.length ? { fieldNumbers } : {})
    }),
    lcid
  });
  
  fieldMetaCache[key] = res.result || [];
  return fieldMetaCache[key];
}

// Invalidate on company or language change
function clearFieldMetaCache() { Object.keys(fieldMetaCache).forEach(k => delete fieldMetaCache[k]); }
```

### 17.4 Discover Available Message Types

```javascript
const typesRes = await cePost(companyId, { type: 'Help.MessageTypes.Get' });
// typesRes.result = [
//   { name: "Data.Records.Get", description: "…", messageDirection: "Outbound" },
//   { name: "Customer.CreditLimit.Get", … },
//   …
// ]
const typeNames = typesRes.result.map(t => t.name);
const hasCustomType = typeNames.includes('MyExtension.Custom.Get');
```

### 17.5 Check User Permissions Before Attempting Writes

```javascript
async function checkTablePermissions(companyId, tableName) {
  const res = await cePost(companyId, {
    type: 'Help.Permissions.Get',
    subject: tableName
  });
  return { read: res.readPermission, write: res.writePermission };
}

const perms = await checkTablePermissions(companyId, 'Customer');
if (!perms.write) {
  showError('You do not have write permissions for the Customer table.');
  return;
}
```

---

## 18. Selecting Only the Fields You Need

Always specify `fieldNumbers` instead of requesting all fields. Benefits:
- Dramatically reduces response payload size
- Enables FlowField calculation (FlowFields are **only calculated** when `fieldNumbers` is specified)
- Improves BC-side performance (fewer field reads)
- Reduces transfer time

### Pattern: Declare field lists as named constants

```javascript
// Declare once — use everywhere
const CUSTOMER_LIST_FIELDS   = [2, 7, 35, 39, 59, 83, 102, 140];
// Field 2  = Name
// Field 7  = City
// Field 35 = Country/Region Code
// Field 39 = Blocked (enum — fetch metadata for caption)
// Field 59 = Balance (LCY)  [FlowField — only returned when fieldNumbers present]
// Field 83 = Location Code
// Field 102 = E-Mail
// Field 140 = Image (Media)

const CUSTOMER_DETAIL_FIELDS = [2, 4, 5, 7, 8, 9, 10, 17, 21, 27, 30, 35, 38, 39,
                                 54, 59, 61, 82, 84, 85, 86, 91, 92, 95, 102, 107,
                                 108, 110, 116, 140];

const POST_CODE_FIELDS       = [1, 2, 4, 5];
// Field 1 = Code (PK)
// Field 2 = City
// Field 4 = Country/Region Code
// Field 5 = County

const CUST_LEDGER_FIELDS     = [4, 5, 6, 7, 13, 14, 36];
```

### Pattern: Parallel loading of records + field metadata

Load data and field metadata simultaneously so captions are ready when data arrives:

```javascript
const [recordsRes, fieldMetaRes] = await Promise.all([
  cePost(companyId, {
    type: 'Data.Records.Get',
    data: JSON.stringify({
      tableName: 'Customer',
      fieldNumbers: CUSTOMER_LIST_FIELDS,
      skip: 0,
      take: 50
    })
  }),
  getFieldMeta(companyId, 'Customer', userLcid, [39])  // Only need Blocked enum captions
]);

// Map enum ordinal → caption for the Blocked field
const blockedField = fieldMetaRes.find(f => f.id === 39);
const blockedCaption = val => blockedField?.enum?.find(e => e.value === val)?.caption ?? val;

// Render
for (const rec of recordsRes.result) {
  const name    = rec.fields.Name;
  const blocked = blockedCaption(rec.fields.Blocked);  // " " → "Not blocked" in user's language
  const balance = rec.fields.BalanceLCY;               // FlowField — present because fieldNumbers was set
}
```

### Pattern: Build a generic field-driven form from metadata

```javascript
async function buildForm(companyId, tableName, lcid) {
  const fields = await getFieldMeta(companyId, tableName, lcid);
  
  for (const field of fields) {
    if (field.isPartOfPrimaryKey) continue;  // PK fields shown separately
    if (field.class === 'FlowField') continue;  // Read-only calculated fields
    
    const label = field.caption;  // Localised
    let control;
    
    switch (field.type) {
      case 'Option':
        // Build <select> from enum[]
        control = buildSelect(field.enum.map(e => ({ value: e.value, label: e.caption })));
        break;
      case 'Boolean':
        control = buildCheckbox();
        break;
      case 'Date':
        control = buildDateInput();
        break;
      case 'Decimal':
      case 'Integer':
      case 'BigInteger':
        control = buildNumberInput();
        break;
      case 'Blob':
        // BLOB — file upload; value is a plain Base64 string
        control = buildFileInput({ encoding: 'base64', returnAs: 'string' });
        break;
      case 'Media':
        // Single image — value is { Id: "{GUID}", Value: "base64string" }
        control = buildFileInput({ encoding: 'base64', returnAs: 'mediaObject' });
        break;
      case 'MediaSet':
        // Multiple images — value is { Id: "{GUID}", Media: [{ Id: "…", Value: "…" }] }
        control = buildFileInput({ encoding: 'base64', returnAs: 'mediaSetObject', multiple: true });
        break;
      default:
        // Text, Code
        control = buildTextInput(field.len);
    }
    
    addFormRow(label, control, field.jsonName);
  }
}
```

### 17.6 Binary Field Types — Blob, Media, MediaSet

These three field types carry binary content (files, images). They are handled
differently from all other field types — each has its own JSON shape on read and write.

#### Blob

A raw binary field (e.g. `Value BLOB` on table 823 Name/Value Buffer). Identified in
`Help.Fields.Get` response as `"type": "Blob"`.

**Read (`Data.Records.Get`):**
Returned as a plain Base64-encoded string.
```json
"ValueBLOB": "dGhpcyBpcyB0ZXN0IGRhdGE="
```

**Write (`Data.Records.Set`):**
Send the same plain Base64 string back in the `fields` object.
```json
"fields": {
  "ValueBLOB": "dGhpcyBpcyB0ZXN0IGRhdGE="
}
```

**JavaScript — encode a file for write:**
```javascript
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);  // strip data-URL prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const base64 = await fileToBase64(fileInputElement.files[0]);
// Send: fields: { ValueBLOB: base64 }
```

**JavaScript — decode a Blob value for display/download:**
```javascript
function base64ToBlob(base64, mimeType = 'application/octet-stream') {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

const blob = base64ToBlob(rec.fields.ValueBLOB, 'application/pdf');
const url  = URL.createObjectURL(blob);
```

---

#### Media (single image)

A single image field (e.g. `Image` on table 18 Customer). Identified as `"type": "Media"`.

**Read (`Data.Records.Get`):**
Returned as a JSON object with a GUID identifier and the Base64-encoded image.
```json
"Image": {
  "Id": "{D6E0EA8A-88A5-4F03-BC75-A5FBC2806FB1}",
  "Value": "/9j/4AAQSkZJRgABAQAA..."
}
```
- `Id` — the media GUID in BC (curly-braced uppercase)
- `Value` — Base64-encoded image bytes

**Write (`Data.Records.Set` — update existing):**
Send the same object back. BC replaces the image.
```json
"fields": {
  "Image": {
    "Id": "{D6E0EA8A-88A5-4F03-BC75-A5FBC2806FB1}",
    "Value": "/9j/4AAQ..."  
  }
}
```

**Write (`Data.Records.Set` — new image, no existing GUID):**
Generate a new GUID and supply it as `Id`. Use all uppercase and include curly braces.
```javascript
function newMediaGuid() {
  // Generate RFC4122 v4 UUID wrapped in braces, uppercase
  return '{' + crypto.randomUUID().toUpperCase() + '}';
}

const base64Image = await fileToBase64(fileInputElement.files[0]);
const imageField  = { Id: newMediaGuid(), Value: base64Image };
// Send: fields: { Image: imageField }
```

**Display in browser:**
```javascript
function mediaToDataUrl(mediaObj, mimeType = 'image/jpeg') {
  if (!mediaObj?.Value) return null;
  return `data:${mimeType};base64,${mediaObj.Value}`;
}

imgElement.src = mediaToDataUrl(rec.fields.Image);
```

---

#### MediaSet (multiple images)

A collection of images (rare on standard tables). Identified as `"type": "MediaSet"`.

**Read (`Data.Records.Get`):**
Returned as a JSON object with a set GUID and an array of individual media items.
```json
"Pictures": {
  "Id": "{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}",
  "Media": [
    { "Id": "{GUID-1}", "Value": "base64string1" },
    { "Id": "{GUID-2}", "Value": "base64string2" }
  ]
}
```

**Write (`Data.Records.Set`):**
Send the same object back. Each item in `Media` needs its own GUID and Base64 value.
To add a new image, append a new entry to `Media` with a freshly generated GUID.
To replace all images, reconstruct the `Media` array.
```javascript
const existingSet = rec.fields.Pictures; // from a prior Data.Records.Get

// Add a new image to the set
const newFile = fileInputElement.files[0];
const newBase64 = await fileToBase64(newFile);
existingSet.Media.push({ Id: newMediaGuid(), Value: newBase64 });

// Send back
// fields: { Pictures: existingSet }
```

**Round-trip rule:** Always read the current value first, then modify and send it back.
Never send a partial `Media` array unless you intentionally want to remove entries.

---

## 19. tableView — Filtering and Sorting in BC Style

`tableView` is a Business Central AL table view string. It is the **only supported
server-side filtering mechanism** in `Data.Records.Get` and `Data.RecordIds.Get`.

### 19.1 Filtering Syntax

Use the **`name`** from `Help.Fields.Get` (original BC field name, may contain spaces
and punctuation) — not the `jsonName`.

```
WHERE(FieldName=OPERATOR(value))
WHERE(Field1=OPERATOR(val1),Field2=OPERATOR(val2))    ← AND (comma-separated)
```

**Operators:**

| Operator | Meaning | Example |
|---|---|---|
| `CONST(value)` | Exact match — single value | `WHERE(No.=CONST(10000))` |
| `FILTER(value)` | Pattern/range match | `WHERE(Balance (LCY)=FILTER(>1000))` |
| `FILTER(v1\|v2)` | OR — multiple values | `WHERE(Type=FILTER(Item\|Resource))` |
| `FILTER(lo..hi)` | Inclusive range | `WHERE(No.=FILTER(10000..20000))` |
| `FILTER(>val)` | Greater than | `WHERE(Balance (LCY)=FILTER(>0))` |
| `FILTER(>=val)` | Greater than or equal | `WHERE(Posting Date=FILTER(>=2026-01-01))` |
| `FILTER(<val)` | Less than | `WHERE(Credit Limit (LCY)=FILTER(<10000))` |
| `FILTER(lo&hi)` | Combined conditions on same field | `WHERE(Balance (LCY)=FILTER(>0&<50000))` |
| `FILTER(@*text*)` | Case-insensitive contains | `WHERE(Name=FILTER(@*Corporation*))` |
| `FILTER(text*)` | Starts with | `WHERE(No.=FILTER(C*))` |

**Blank/empty option values** — use `CONST( )` with a single space:
```
WHERE(Blocked=CONST( ))         ← not blocked customers
WHERE(Document Type=CONST(Order),Status=CONST(Open))
```

**Dynamic values in template literals:**
```javascript
// Exact match from variable
const tableView = `WHERE(Registration Number=CONST(${regNo}))`;

// Numeric range from variables
const tableView = `WHERE(Balance (LCY)=FILTER(>${minBalance}&<${maxBalance}))`;

// Date range (use BC date format YYYY-MM-DD in FILTER)
const tableView = `WHERE(Posting Date=FILTER(>=${fromDate}&<=${toDate}))`;

// Multiple conditions (AND)
const tableView = `WHERE(Customer No.=CONST(${customerNo}),Open=CONST(true))`;

// OR values
const tableView = `WHERE(Document Type=FILTER(Order|Invoice))`;
```

**Special characters in values** — most separator characters are safe inside `CONST()`.
For `FILTER()`, avoid embedding `&`, `|`, `.."` as they are filter operators.

### 19.2 Sorting Syntax

`tableView` also supports sorting via an `ORDER BY` clause appended after `WHERE`.
BC sorts results using the BC-side key ordering — you can specify the key fields and direction.

```
SORTING(FieldName1,FieldName2) ORDER(Ascending|Descending)
WHERE(Blocked=CONST( )) SORTING(Name) ORDER(Ascending)
SORTING(Posting Date,Entry No.) ORDER(Descending)
```

Full combined example:
```javascript
const tableView = `WHERE(Customer No.=CONST(${custNo}),Open=CONST(true)) SORTING(Due Date) ORDER(Ascending)`;
```

> **Important:** SORTING field names use the **original BC field name** (with spaces),
> same as WHERE clauses. Not the `jsonName`. Example: `SORTING(Due Date)` not `SORTING(DueDate)`.

**Common sort patterns:**

```javascript
// Customers A–Z
tableView: 'SORTING(Name) ORDER(Ascending)'

// Most recent entries first
tableView: 'WHERE(Customer No.=CONST(10000)) SORTING(Posting Date,Entry No.) ORDER(Descending)'

// Items by No. ascending
tableView: 'SORTING(No.) ORDER(Ascending)'

// Active customers sorted by balance (highest first)
tableView: 'WHERE(Blocked=CONST( )) SORTING(Balance (LCY)) ORDER(Descending)'
```

### 19.3 tableView Quick Reference

```javascript
// Only active (non-blocked) customers
tableView: "WHERE(Blocked=CONST( ))"

// Specific customer's open ledger entries
tableView: `WHERE(Customer No.=CONST(${custNo}),Open=CONST(true))`

// Sales orders (not invoices) for a customer
tableView: `WHERE(Document Type=CONST(Order),Sell-to Customer No.=CONST(${custNo}))`

// Items with quantity on hand
tableView: "WHERE(Inventory=FILTER(>0))"

// Records modified in date range (combine with startDateTime/endDateTime for SystemModifiedAt)
// Note: tableView date filters apply to regular BC date fields; startDateTime/endDateTime targets SystemModifiedAt
tableView: `WHERE(Posting Date=FILTER(>=${fromDate}&<=${toDate}))`

// Post Code table lookup
tableView: `WHERE(Code=CONST(${postCode}))`

// Check for duplicate customer by registration number
tableView: `WHERE(Registration Number=CONST(${regNo}))`

// Payment Terms table — look up by code
tableView: `WHERE(Code=CONST(${paymentTermsCode}))`

// Gen. Business Posting Group — all unblocked groups
tableView: "WHERE(Blocked=CONST(false))"
```

### 19.4 Client-Side vs Server-Side Sorting

`tableView` SORTING pushes sorting to BC (efficient for large datasets). For small
result sets already in memory, client-side sorting is simpler:

```javascript
function sortRecords(records, jsonFieldName, direction = 'asc') {
  return [...records].sort((a, b) => {
    const valA = a.fields?.[jsonFieldName] ?? a.primaryKey?.[jsonFieldName] ?? '';
    const valB = b.fields?.[jsonFieldName] ?? b.primaryKey?.[jsonFieldName] ?? '';
    
    // Numeric sort
    if (typeof valA === 'number' && typeof valB === 'number') {
      return direction === 'asc' ? valA - valB : valB - valA;
    }
    
    // String sort
    const cmp = String(valA).localeCompare(String(valB));
    return direction === 'asc' ? cmp : -cmp;
  });
}

// Usage
const sorted = sortRecords(salesHistory, 'quantity', 'desc');
```

Use **server-side SORTING** when:
- Fetching large datasets with pagination (sort affects which records land on each page)
- You need the BC-native key ordering

Use **client-side sorting** when:
- All records are already loaded (no pagination)
- Sorting by a computed or display value not matching a BC field directly
- User is clicking table column headers after initial load

---

## 20. UI Translations via BC Translation Table

The Cloud Events extension includes a `Cloud Event Translation` table that enables
**web or integration UIs to store and retrieve their own translatable strings directly
in Business Central**. This means your integration can be fully multi-lingual without
maintaining a separate translation file or service.

### 20.1 How It Works

The translation table has three primary key fields:
- `Source` — identifies the application (e.g. `"BC Portal"`, `"MyWebApp v1"`)
- `Windows Language ID` — the LCID integer as a `Code[10]` string (e.g. `"1039"`)
- `Source Text` — the English string to translate

And one value field:
- `Target Text` — the translated string

Business users fill in translations directly in BC. Your app reads them at runtime.

### 20.2 Fetching UI Translations

```javascript
const UI_STRINGS = [
  'Loading...',
  'Customers',
  'Customer Number',
  'Name',
  'City',
  'Balance',
  'Blocked',
  'Active',
  'Save',
  'Cancel',
  'Search...',
  'No records found',
  // add all UI labels here
];

let uiTranslations = {};

async function loadUiTranslations(companyId, lcid, appSource = 'MyApp') {
  uiTranslations = {};
  if (lcid === 1033) return;  // English — no translation needed
  
  const res = await cePost(companyId, {
    type: 'Data.Records.Get',
    data: JSON.stringify({
      tableName: 'Cloud Event Translation',
      tableView: `WHERE(Windows Language ID=CONST(${lcid}),Source=CONST(${appSource}))`,
      take: UI_STRINGS.length + 50
    })
  });
  
  for (const rec of (res.result || [])) {
    const src = rec.primaryKey?.SourceText;
    const tgt = rec.fields?.TargetText;
    if (src && tgt) uiTranslations[src] = tgt;
  }
}

// Translation helper with English fallback
function t(s) {
  return uiTranslations[s] || s;
}
```

### 20.3 Auto-Creating Placeholder Records for Missing Translations

When a language is selected but some strings are not yet translated in BC, create
placeholder records automatically. Business users can then fill them in via the standard
BC UI.

```javascript
async function ensureTranslationPlaceholders(companyId, lcid, appSource = 'MyApp') {
  // Find which strings are missing
  const res = await cePost(companyId, {
    type: 'Data.Records.Get',
    data: JSON.stringify({
      tableName: 'Cloud Event Translation',
      tableView: `WHERE(Windows Language ID=CONST(${lcid}),Source=CONST(${appSource}))`,
      take: UI_STRINGS.length + 50
    })
  });
  
  const existing = new Set((res.result || []).map(r => r.primaryKey?.SourceText));
  const missing  = UI_STRINGS.filter(s => !existing.has(s));
  
  if (!missing.length) return;
  
  // Insert placeholder records with empty TargetText
  await cePost(companyId, {
    type: 'Data.Records.Set',
    subject: 'Cloud Event Translation',
    data: JSON.stringify({
      data: missing.map(s => ({
        primaryKey: {
          Source: appSource,
          WindowsLanguageID: String(lcid),
          SourceText: s
        },
        fields: { TargetText: '' }
      }))
    })
  });
}
```

### 20.4 Applying Translations to HTML

Use `data-t` and `data-tp` (placeholder) attributes on HTML elements:

```html
<!-- Text content -->
<span data-t="Customers">Customers</span>
<button data-t="Save">Save</button>
<h2 data-t="Customer Number">Customer Number</h2>

<!-- Input placeholder -->
<input data-tp="Search..." placeholder="Search...">
```

Apply after loading:
```javascript
function applyUiTranslations() {
  document.querySelectorAll('[data-t]').forEach(el => {
    el.textContent = t(el.dataset.t);
  });
  document.querySelectorAll('[data-tp]').forEach(el => {
    el.placeholder = t(el.dataset.tp);
  });
}
```

### 20.5 Language Selector

Use the **`Allowed Language`** table (3563) — not the `Language` table — to get the
languages that are enabled for use in this BC environment.

| Field No. | BC Field Name | `jsonName` | Description |
|---|---|---|---|
| 1 | `Language Id` | `LanguageId` | Windows Language ID (LCID integer) — matches `Windows Language ID` on the Language table |
| 2 | `Language` | `Language` | Display name (e.g. `"English"`, `"Icelandic"`) |

```javascript
async function loadLanguages(companyId) {
  const res = await cePost(companyId, {
    type: 'Data.Records.Get',
    data: JSON.stringify({
      tableNumber: 3563,   // Allowed Language
      fieldNumbers: [1, 2] // Language Id (LCID), Language (display name)
    })
  });

  return (res.result || []).map(rec => ({
    lcid: rec.primaryKey.LanguageId ?? parseInt(rec.fields.LanguageId, 10),
    name: rec.fields.Language ?? ''
  }));
}
```

> The `Language Id` value from `Allowed Language` is the Windows Language ID (LCID)
> and maps directly to the `lcid` field used in Cloud Events message envelopes and to
> the `Windows Language ID` field on the `Language` table (8).
```

### 20.6 Full Language-Change Workflow

```javascript
let selectedLcid = 1033;
let fieldMetaCache = {};
let uiTranslations = {};

async function onLanguageChange(newLcid, companyId) {
  selectedLcid = newLcid;
  
  // Clear caches — captions and translations are language-specific
  fieldMetaCache = {};
  uiTranslations = {};
  
  // Reload translations and refresh UI
  await loadUiTranslations(companyId, newLcid);
  await ensureTranslationPlaceholders(companyId, newLcid);
  applyUiTranslations();
  
  // Reload any data that shows captions (e.g. enum fields, table captions)
  await refreshCurrentView();
}
```

### 20.7 Using Field Captions as Column Headers

After calling `Help.Fields.Get` with a `lcid`, the `caption` for each field is the
localised column header. This means column headers in your UI automatically match the
BC field label in the user's language:

```javascript
async function buildTableHeaders(companyId, tableName, fieldNumbers, lcid) {
  const meta = await getFieldMeta(companyId, tableName, lcid, fieldNumbers);
  
  // meta[i].caption is already in the user's language
  return fieldNumbers
    .map(no => meta.find(f => f.id === no))
    .filter(Boolean)
    .map(f => ({ fieldNo: f.id, jsonName: f.jsonName, caption: f.caption }));
}

// Example output for Customer fields [1, 2, 7, 102] with lcid=1039 (Icelandic):
// [
//   { fieldNo: 1,   jsonName: "No_",  caption: "Nr." },
//   { fieldNo: 2,   jsonName: "Name", caption: "Heiti" },
//   { fieldNo: 7,   jsonName: "City", caption: "Bær" },
//   { fieldNo: 102, jsonName: "EMail", caption: "Tölvupóstur" }
// ]
```

---

## 21. Looking Up Reference Data (Dropdowns / Lookup Tables)

Many BC fields have table relations — the field value is a code that references another
table. Use `Data.Records.Get` with specific `fieldNumbers` to populate dropdowns.

### Common Lookup Table Reference

```javascript
const LOOKUP_TABLES = {
  paymentTerms: { tableNo: 3,   fields: [1, 5],        pkField: 'Code',        labelField: 'Description' },
  currency:     { tableNo: 4,   fields: [1, 15],       pkField: 'Code',        labelField: 'Description' },
  language:     { tableNo: 8,   fields: [1, 2, 3],     pkField: 'Code',        labelField: 'Name' },
  salesperson:  { tableNo: 13,  fields: [1, 2],        pkField: 'Code',        labelField: 'Name' },
  location:     { tableNo: 14,  fields: [1, 2],        pkField: 'Code',        labelField: 'Name' },
  customerPostingGroup: { tableNo: 92,  fields: [1, 20], pkField: 'Code',      labelField: 'Description' },
  postCode:     { tableNo: 225, fields: [1, 2, 4, 5],  pkField: 'Code',        labelField: 'City' },
  genBusPostingGroup: { tableNo: 250, fields: [1, 2, 3], pkField: 'Code',      labelField: 'Description' },
  paymentMethod: { tableNo: 289, fields: [1, 2],       pkField: 'Code',        labelField: 'Description' },
  vatBusPostingGroup: { tableNo: 323, fields: [1, 2],  pkField: 'Code',        labelField: 'Description' },
};

async function loadLookup(companyId, def) {
  const res = await cePost(companyId, {
    type: 'Data.Records.Get',
    data: JSON.stringify({ tableNumber: def.tableNo, fieldNumbers: def.fields, take: 500 })
  });
  return (res.result || []).map(rec => ({
    value: rec.primaryKey[def.pkField] ?? rec.primaryKey[Object.keys(rec.primaryKey)[0]],
    label: rec.fields[def.labelField] ?? '',
    raw: rec
  }));
}

// Load all lookups in parallel
const [payTerms, currencies, locations] = await Promise.all([
  loadLookup(companyId, LOOKUP_TABLES.paymentTerms),
  loadLookup(companyId, LOOKUP_TABLES.currency),
  loadLookup(companyId, LOOKUP_TABLES.location),
]);
```

### Post Code Auto-Fill Pattern

```javascript
async function onPostCodeBlur(companyId, postCode) {
  if (!postCode) return;
  
  const res = await cePost(companyId, {
    type: 'Data.Records.Get',
    data: JSON.stringify({
      tableNumber: 225,  // Post Code
      fieldNumbers: [1, 2, 4, 5],  // Code, City, Country/Region Code, County
      tableView: `WHERE(Code=CONST(${postCode}))`
    })
  });
  
  if (res.result?.length) {
    const rec = res.result[0];
    return {
      city:          rec.fields.City2 ?? rec.fields.City ?? '',   // check jsonName via Help.Fields.Get
      countryCode:   rec.fields.CountryRegionCode ?? '',
      county:        rec.fields.County ?? ''
    };
  }
  return null;
}
```

### Gen. Bus. Posting Group → VAT Bus. Posting Group Auto-Fill

```javascript
// Load Gen. Bus. Posting Groups with field 3 (Def. VAT Bus. Posting Group)
const genBusGroups = await loadLookup(companyId, LOOKUP_TABLES.genBusPostingGroup);
const genBusToVATMap = Object.fromEntries(
  genBusGroups.map(g => [g.value, g.raw.fields.Def_VATBusPostingGroup ?? ''])
);

function onGenBusChange(selectedCode) {
  const vatCode = genBusToVATMap[selectedCode] || '';
  document.getElementById('vat-bus-posting-group').value = vatCode;
}
```

---

## 22. Duplicate / Existence Checking Pattern

Before inserting, check whether a record with the same unique identifier already exists:

```javascript
async function recordExists(companyId, tableName, tableView) {
  const res = await cePost(companyId, {
    type: 'Data.Records.Get',
    data: JSON.stringify({
      tableName,
      tableView,
      fieldNumbers: [1],  // Only PK — minimal payload
      take: 1
    })
  });
  return (res.result?.length ?? 0) > 0;
}

// Check customer by registration number
const exists = await recordExists(
  companyId,
  'Customer',
  `WHERE(Registration Number=CONST(${regNo}))`
);
if (exists) {
  showError(`A customer with registration number ${regNo} already exists.`);
  return;
}
```
