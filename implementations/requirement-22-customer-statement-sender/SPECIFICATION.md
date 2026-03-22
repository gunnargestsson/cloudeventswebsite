# Requirement 22: Customer Statement Sender

## Overview
A standalone sub-page (`customer-statement-sender.html`) that lets staff select a company and
one or more customers, fetch each customer's account-statement PDF from Business Central via
the Cloud Events API, and email it directly to the customer's address using the existing
`/api/email` Azure Function and the shared `emailService.js` module.

**Key Features:**
- ✅ **Company + Customer Selection**: Reuses the existing BC company/customer lookup pattern
- ✅ **PDF Retrieval**: Calls `Customer.Statement.Pdf` Cloud Events message type; receives binary PDF
- ✅ **Email Dispatch**: Uses `sendEmail()` from `emailService.js` with the PDF as a base64 attachment
- ✅ **Date Range Filter**: From / To date inputs to scope the statement period
- ✅ **Batch Send**: Select multiple customers and send all in one action; per-row status feedback
- ✅ **Full Localisation**: All UI strings in `UI_STRINGS` → `t()` → Icelandic translations via BC

---

## Architecture

### Deployment Model
Same as all other pages:
- **Hosting**: Azure Static Web Apps (static HTML/JS/CSS)
- **API Runtime**: Azure Functions (Node.js 18) — existing `/api/bc` and `/api/email` endpoints
- **No new Azure Function required** — `emailService.js` already posts to `/api/email`

### Technology Stack
- **Frontend**: Vanilla JavaScript, HTML5, CSS3 — matching the dark-theme design system
- **API calls**: `cePost()` helper identical to `bc-portal.html`
- **Email**: `sendEmail()` from `emailService.js`

---

## File Inventory

| File | Action | Notes |
|---|---|---|
| `customer-statement-sender.html` | **Create** | New sub-page |
| `emailService.js` | **Existing** — no changes needed | Already implemented |
| `api/email/index.js` | **Existing** — no changes needed | Already implemented |
| `api/email/function.json` | **Existing** — no changes needed | |
| `implementations/requirement-22-customer-statement-sender/SPECIFICATION.md` | **Create** | This file |

---

## Cloud Events API Call — Statement PDF

### Message Type
```
Customer.Statement.Pdf
```

### Request Envelope
```json
{
  "specversion": "1.0",
  "type": "Customer.Statement.Pdf",
  "source": "customer-statement-sender",
  "subject": "<customer-no>",
  "data": "{\"startDate\":\"2025-01-01\",\"endDate\":\"2025-12-31\"}"
}
```

`subject` is the customer number (e.g. `"10000"`). `data` is a **JSON string** (not an object)
containing `startDate` and `endDate` (ISO 8601). Both are optional; omitting them defaults to
the last 30 days.

Optional `data` fields:
- `customerNo` — overrides `subject`
- `startDate` — ISO date, defaults to today − 30 days
- `endDate` — ISO date, defaults to today
- `dateChoice` — `"Due Date"` (default) or `"Posting Date"`

### Response — Two-Step flow inside `/api/bc`

BC Cloud Events tasks are asynchronous. The `/api/bc` function handles the two steps
transparently so the client only makes a single HTTP call:

**Step 1** — POST the envelope to the BC tasks endpoint. BC queues/executes the report
and returns a Cloud Events task object:
```json
{
  "data": "https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/origo/cloudEvent/v1.0/responses({guid})",
  "datacontenttype": "application/pdf"
}
```

**Step 2** — `/api/bc` detects `datacontenttype` contains `"pdf"`, calls `binaryGet()` to
fetch the raw PDF bytes from the `data` URL (authenticated with the same Bearer token), and
streams them straight back to the browser:
```
HTTP 200  Content-Type: application/pdf
<raw PDF bytes>
```

**Client-side** — a single `fetch('/api/bc?companyId=...')` therefore receives a binary
PDF response. Read it with `r.arrayBuffer()`, convert to base64, and attach to the email.

### Endpoint
```
POST /api/bc?companyId={companyId}
Content-Type: application/json
Body: <Cloud Events envelope above>
```

---

## Email Dispatch

Uses `sendEmail()` from `emailService.js`:

```javascript
const result = await sendEmail({
  to:      customer.email,          // from BC customer record (EMail field)
  subject: t('Customer Statement'), // localised
  body:    t('Please find your account statement attached.'),
  isHtml:  false,
  attachments: [{
    filename:    `statement-${customer.no}.pdf`,
    contentType: 'application/pdf',
    base64:      pdfBase64,
  }],
});
```

---

## UI Specification

### Layout — Three-Step Flow

```
[ Step 1: Company ]  →  [ Step 2: Customers + Date Range ]  →  [ Step 3: Send / Results ]
```

The page keeps a single `currentStep` state (1–3) and hides/shows the relevant `<section>`.

---

### Step 1 — Select Company

Identical to the company-selection view in `bc-portal.html`:
- Grid of company cards loaded from `GET /api/bc?path=companies`
- Click a card to advance to Step 2

---

### Step 2 — Select Customers & Date Range

#### Date Range Panel
```
┌─────────────────────────────────────────────────────────┐
│  Statement Period                                        │
│  From: [date input]     To: [date input]                │
│  [Default to first day of current year → today]         │
└─────────────────────────────────────────────────────────┘
```

#### Customer Table
```
┌──┬────────────┬───────────────────┬────────────────────┬──────────┐
│☐ │ No.        │ Name              │ E-Mail             │ Status   │
├──┼────────────┼───────────────────┼────────────────────┼──────────┤
│☐ │ C00010     │ Acme Corporation  │ acme@example.com   │ —        │
│☑ │ C00020     │ Beta Ltd          │ beta@example.com   │ ✓ Sent   │
│☐ │ C00030     │ Gamma ehf.        │ (no email)         │ ⚠ No email│
└──┴────────────┴───────────────────┴────────────────────┴──────────┘
[ Select All ]  [ Deselect All ]          [ Send to Selected (1) ]
```

- Customers are loaded from `Data.Records.Get` on table **18** (Customer), fieldNumbers `[2, 102]` (Name, EMail — No_ is always included in `primaryKey`)
- Customers with blank `EMail` show a warning badge and are not selectable
- Pagination: 50 per page with Prev / Next buttons (matches existing pattern)
- Search input filters by name or number (client-side, same as `bc-portal.html`)

---

### Step 3 — Send Progress / Results

When "Send to Selected" is clicked:
1. The button disables and shows a spinner
2. For each selected customer **sequentially**:
   a. Fetch statement PDF via Cloud Events (`Customer.Statement.Pdf`)
   b. Convert ArrayBuffer → base64
   c. Call `sendEmail()`
   d. Update the row's Status column: `⏳ Sending...` → `✓ Sent` or `✗ Error: <message>`
3. When all rows are processed, button label changes to "Done" and re-enables

No separate "Step 3 view" is needed — status feedback is inline on the customer table.

---

## UI Strings (Icelandic Translations Required)

All strings below must appear in `UI_STRINGS` and be wrapped in `t()` in the HTML.
Icelandic translations must be registered via the `set_translations` MCP tool.

| English (`sourceText`) | Icelandic (`targetText`) |
|---|---|
| Customer Statement Sender | Sendandi reikningsyfirlits |
| Select Company | Veldu fyrirtæki |
| Select Customers | Veldu viðskiptavini |
| Statement Period | Tímabil yfirlits |
| From | Frá |
| To | Til |
| Customer No. | Viðskiptavinsnr. |
| Customer Name | Nafn viðskiptavinar |
| E-Mail | Netfang |
| Status | Staða |
| Select All | Velja allt |
| Deselect All | Afvelja allt |
| Send to Selected | Senda til valinna |
| Sending... | Sendandi... |
| Sent | Sent |
| No email address | Ekkert netfang |
| Failed | Mistókst |
| Customer Statement | Reikningsyfirlit |
| Please find your account statement attached. | Vinsamlegast sjáið meðfylgjandi reikningsyfirlit. |
| Loading companies... | Hleð fyrirtæki... |
| Loading customers... | Hleð viðskiptavini... |
| Fetching PDF... | Sæki PDF... |
| Sending email... | Sendi tölvupóst... |
| No customers found | Engir viðskiptavinir fundust |
| Back to Companies | Til baka í fyrirtæki |
| Back to Customers | Til baka í viðskiptavini |
| Done | Lokið |
| Search by name or number... | Leita eftir nafni eða númeri... |
| selected | valið |
| Authenticating... | Auðkenning... |

---

## JavaScript Architecture

```javascript
// ── State ────────────────────────────────────────────────────────────────────
let companyId    = '';          // selected BC company GUID
let companyName  = '';
let customers    = [];          // full loaded customer list
let filteredList = [];          // after search filter
let pageIndex    = 0;
const PAGE_SIZE  = 50;

// ── cePost ───────────────────────────────────────────────────────────────────
// Identical helper to bc-portal.html — posts a Cloud Events envelope to /api/bc
async function cePost(companyId, event) { ... }     // JSON-response Cloud Events calls

// ── fetchCustomers ────────────────────────────────────────────────────────────
// Loads table 18 (Customer), fieldNumbers [2, 102] via Data.Records.Get
async function fetchCustomers(companyId) { ... }

// ── fetchStatementPdf ─────────────────────────────────────────────────────────
// Posts Customer.Statement.Pdf; receives binary PDF; returns base64 string
async function fetchStatementPdf(customerNo, startDate, endDate) { ... }

// ── sendStatements ────────────────────────────────────────────────────────────
// Loops over checked rows; for each: fetchStatementPdf → sendEmail → update status
async function sendStatements() { ... }

// ── Translation helpers ────────────────────────────────────────────────────────
// loadUiTranslations(), t() — identical pattern to bc-portal.html
```

---

## cePost Helper

Direct copy of the pattern in `bc-portal.html`. Used for JSON-response calls only
(e.g. `Data.Records.Get`, `Data.Records.Set`). PDF fetching uses raw `fetch` because
the response is binary.

```javascript
async function cePost(companyId, event) {
  const r = await fetch('/api/bc?companyId=' + encodeURIComponent(companyId), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...event, lcid: selectedLcid }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || 'API error ' + r.status);
  }
  const result = await r.json();
  if (result.status === 'Error') throw new Error(result.error || 'Cloud Events task failed');
  return result;
}
```

---

## fetchStatementPdf Helper

Uses **raw `fetch`** (not `cePost`) because the `/api/bc` response is binary, not JSON.
The proxy internally does the two-step dance (POST task → binary GET PDF URL) and
returns raw bytes with `Content-Type: application/pdf`.

```javascript
async function fetchStatementPdf(customerNo, startDate, endDate) {
  // Raw fetch — /api/bc streams back binary PDF (not JSON) for this message type.
  const r = await fetch('/api/bc?companyId=' + encodeURIComponent(selectedCompany.id), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      specversion: '1.0',
      type:        'Customer.Statement.Pdf',
      source:      'customer-statement-sender',
      subject:     customerNo,          // customer No. — e.g. "10000"
      lcid:        selectedLcid,
      data:        JSON.stringify({ startDate, endDate }),  // JSON string, not object
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || 'HTTP ' + r.status);
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    // Unexpected JSON response — surface any Cloud Events error
    const result = await r.json().catch(() => ({}));
    if (result.status === 'Error') throw new Error(result.error || 'PDF generation failed');
    throw new Error(result.error || 'Unexpected response type: ' + ct);
  }
  // Convert ArrayBuffer → base64 for use as email attachment
  const bytes = new Uint8Array(await r.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
```
```

---

## Security Considerations

- Credentials (BC and email) are **never** stored client-side — all auth stays in Azure Function env vars
- `EMAIL_TENANT_ID`, `EMAIL_CLIENT_ID`, `EMAIL_CLIENT_SECRET` are already configured in `local.settings.json` (blank — must be filled in Azure Portal for production)
- The `/api/email` function validates the `to` address with a regex before calling Graph
- CORS on `/api/email` is restricted to `https://dynamics.is`

---

## Implementation Checklist

- [ ] Create `customer-statement-sender.html` with three-step flow
- [ ] Add `UI_STRINGS` array and `loadUiTranslations()` / `t()` helpers
- [ ] Implement `cePost()` for Cloud Events calls
- [ ] Implement `fetchCustomers()` — table 18, fields 1/2/102
- [ ] Implement `fetchStatementPdf()` — `Customer.Statement.Pdf`, ArrayBuffer → base64
- [ ] Implement `sendStatements()` — sequential send loop with per-row status
- [ ] Add page link to `index.html` navigation grid
- [ ] Register all Icelandic translations via `set_translations` MCP tool
- [ ] Test with real BC UAT environment

---

## Dependencies

- `emailService.js` — already implemented (Requirement 22 pre-requisite: email Azure Function)
- `/api/bc` — existing Azure Function proxy
- `/api/email` — existing Azure Function (Microsoft Graph email sender)
- `settings.js` — shared credential loader

---

## BC Message Type Reference

| Message Type | Table | Purpose |
|---|---|---|
| `Data.Records.Get` | 18 (Customer) | Load customer list with No_, Name, EMail (fieldNumbers 2, 102) |
| `Customer.Statement.Pdf` | 18 (Customer) | Fetch customer account statement as PDF |
