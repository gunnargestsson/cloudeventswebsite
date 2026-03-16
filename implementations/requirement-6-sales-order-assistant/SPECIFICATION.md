# Requirement 6: AI Sales Order Assistant

## Overview
A conversational AI assistant powered by Anthropic Claude that helps users create Business Central sales orders from natural language descriptions and uploaded documents (Excel, PDF, images, emails). The assistant interacts with BC in real time to look up customers and items, check prices and availability, and ultimately creates the order in BC after user confirmation.

**Key Features:**
- ✅ **Conversational Order Entry**: Natural language input drives the entire order creation workflow
- ✅ **Document Upload**: Excel/CSV, PDF, images, `.eml`, and `.msg` files parsed server-side; extracted data fed to the AI
- ✅ **Real-Time BC Lookups**: Customer search, item search, availability check, price lookup, and credit check — all live against BC
- ✅ **Agentic Tool Loop**: Claude calls 6 BC-integrated tools autonomously, up to 10 turns per message
- ✅ **Order Confirmation Panel**: Full order card with lines, unit prices, stock warnings, subtotal/VAT/total before committing
- ✅ **BC Order Creation**: Creates `Sales Header` + `Sales Line` records via `Data.Records.Set` on confirmation
- ✅ **ISK / Multi-Currency**: Currency displayed per customer record; totals shown excl. and incl. VAT (24% rate)
- ✅ **Settings Panel**: Per-session configuration for Claude API key and BC connection

## Architecture

### Deployment Model
- **Hosting**: Azure Static Web Apps
- **Frontend**: `sales-assistant.html`
- **API Functions**:
  - `api/chat/index.js` — main chat endpoint, runs agentive tool loop
  - `api/upload/index.js` — file parsing + Claude extraction
  - `api/shared/bcClient.js` — shared BC + Anthropic client utilities
- **Routes**: `/sales-assistant` → `sales-assistant.html`

### Technology Stack
- **Frontend**: Vanilla JavaScript, HTML5, CSS3 (dark theme)
- **Backend**: Azure Functions (Node.js), native `https` module
- **AI Model**: Anthropic Claude (`claude-sonnet-4-20250514`) — server-side only
- **File Parsing**: `busboy` (multipart), `xlsx` (Excel), `msg-parser` (Outlook .msg)
- **Authentication**: OAuth 2.0 client credentials (BC), Bearer token (Anthropic)
- **CORS**: Restricted to `https://dynamics.is`

### npm Dependencies (`api/package.json`)
```json
{
  "dependencies": {
    "busboy":     "^1.6.0",
    "xlsx":       "^0.18.5",
    "msg-parser": "^2.0.0"
  }
}
```

## Layout

Two-column layout (`340px settings | flex main`):

```
┌─────────────────────────────────────────────────────┐
│  Header: Logo · Title · Settings toggle · Nav       │
├─────────────────┬───────────────────────────────────┤
│  Settings Panel │  Chat / Confirm Area              │
│  (340px)        │  (flex)                           │
│                 │                                   │
│  Claude API Key │  [Chat history]                   │
│  Tenant ID      │  [File drop zone]                 │
│  Environment    │  [Message input + Send]           │
│  Company ID     │                                   │
│  Client ID      │  — or —                           │
│  Client Secret  │                                   │
│                 │  [Order Confirmation Panel]       │
│  [Save Settings]│  [Confirm] [Cancel]               │
└─────────────────┴───────────────────────────────────┘
```

Settings panel auto-collapses (is hidden) when all six fields are already filled in `sessionStorage`.

## Settings & Authentication

Settings are persisted in `sessionStorage` for the browser session:

| Setting | `sessionStorage` Key | Notes |
|---|---|---|
| Claude API Key | `sa_claude_key` | Sent to `/api/chat` and `/api/upload` in request body; never server-stored |
| Tenant ID | `sa_tenant` | BC Entra tenant |
| Environment | `sa_env` | e.g. `UAT` |
| Company ID | `sa_company` | BC company GUID |
| Client ID | `sa_clientId` | App registration |
| Client Secret | `sa_clientSecret` | App registration secret |

The API key and BC credentials are included in every request body (not headers) and used only for the duration of that single request.

## `/api/chat` — Agentic Chat Endpoint

### Request Body

```json
{
  "messages": [ { "role": "user", "content": "Order 5 units of item 1000 for customer MEGA" } ],
  "apiKey": "<claude api key>",
  "bcConfig": {
    "tenantId": "...",
    "environment": "UAT",
    "companyId": "...",
    "clientId": "...",
    "clientSecret": "..."
  }
}
```

The special message `__CONFIRM_ORDER__` in the last user message triggers `createSalesOrder()` instead of the normal agent loop.

### Response

```json
{
  "reply": "I found customer MEGA Corp (No. MEGA01)...",
  "pendingOrder": { "customerNo": "MEGA01", "lines": [...] },
  "orderNo": "SO-00123"
}
```

- `reply` — AI text response rendered in the chat panel
- `pendingOrder` — present when the AI has proposed a complete order (triggers confirmation panel on frontend)
- `orderNo` — present when order was successfully created in BC

### System Prompt

The system prompt instructs Claude to:
1. Extract customer and order lines from the user message or uploaded document
2. Use `lookup_customer` to find and confirm the BC customer
3. Use `lookup_item` for each product
4. Use `check_item_availability` for each resolved item
5. Use `get_item_price` for each item (with `customerNo` for customer-specific pricing)
6. Only call `propose_sales_order` once ALL lines and the customer are confirmed to real BC records
7. On `__CONFIRM_ORDER__`, create the order and report the order number

Tone: professional, concise. Currency: ISK (króna) unless customer record shows otherwise. Prices shown excl. VAT in lines; both excl. and incl. VAT in totals.

### Agentic Tool Loop

`runAgentLoop()` runs up to **10 turns**:

```
1. POST to Anthropic /v1/messages with current messages + tools
2. If response stop_reason === 'tool_use':
   a. Execute all tool_use blocks via executeTool()
   b. Append tool_result blocks to messages
   c. Loop
3. If stop_reason === 'end_turn' or max turns reached:
   a. Extract pendingOrder from any propose_sales_order tool call
   b. Return { reply, pendingOrder }
```

### Tools

| Tool | BC API Call | Description |
|---|---|---|
| `lookup_customer` | `Data.Records.Get` on `Customer`, fields [1,2,5,7,21,22], `tableView: "WHERE(No_=FILTER(*q*)\|Name=FILTER(*q*))"`, take 5 | Search customer by name or number |
| `lookup_item` | `Data.Records.Get` on `Item`, fields [1,3,30,8], take 5 | Search item by number or description |
| `check_item_availability` | `Item.Availability.Get` with `itemNo`, optional `requestedDeliveryDate` | Get projected available quantity |
| `get_item_price` | `Item.Price.Get` with `itemNo`, optional `customerNo` and `quantity` | Get sales price (customer-specific if provided) |
| `check_customer_credit` | `Customer.CreditLimit.Get` | Get credit limit and outstanding balance |
| `propose_sales_order` | (no BC call — returns data to frontend) | Signals a complete order proposal; returns `{ customerNo, orderDate, requestedDeliveryDate, externalDocumentNo, lines[] }` |

### Order Creation (`createSalesOrder`)

Two-step `Data.Records.Set` process:

**Step 1 — Sales Header:**
```json
{
  "type": "Data.Records.Set",
  "data": "{\"tableName\":\"Sales Header\",\"fields\":{\"DocumentType\":\"Order\",\"No_\":\"\",\"SelltoCustomerNo_\":\"MEGA01\",\"OrderDate\":\"2026-03-16\",\"RequestedDeliveryDate\":\"2026-04-01\",\"ExternalDocumentNo_\":\"PO-123\"}}"
}
```
`No_: ""` instructs BC to assign the next number from the number series. The returned record contains the assigned `No_`.

**Step 2 — Sales Lines (one per line):**
```json
{
  "type": "Data.Records.Set",
  "data": "{\"tableName\":\"Sales Line\",\"fields\":{\"DocumentType\":\"Order\",\"DocumentNo_\":\"SO-00123\",\"LineNo_\":10000,\"Type\":\"Item\",\"No_\":\"1000\",\"Quantity\":5,\"UnitPrice\":1200.00,\"UnitOfMeasureCode\":\"PCS\"}}"
}
```
`LineNo_` increments by 10,000 per line.

## `/api/upload` — File Parsing Endpoint

### Request
Multipart form-data with a single `file` field. Max size: 10 MB.

### Supported File Types

| Extension | Parsing Method | Sent to Claude as |
|---|---|---|
| `.xlsx`, `.xls`, `.csv` | `XLSX.utils.sheet_to_json()` → JSON array as text | Text block |
| `.pdf` | Buffer → base64 | Document block (`application/pdf`) |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | Buffer → base64 | Image block |
| `.eml` | Strip to From/To/Subject/Date headers + plain body (8 KB cap) | Text block |
| `.msg` | `msg-parser` library → subject + body | Text block (with fallback) |

### Claude Extraction Prompt

The file content is sent to Claude with a structured extraction prompt asking for:
```json
{
  "customerHint": "name or PO number that identifies the customer",
  "lines": [
    { "itemHint": "...", "quantity": 0, "unitPrice": 0, "unit": "..." }
  ],
  "orderDate": "ISO date or null",
  "requestedDeliveryDate": "ISO date or null",
  "externalDocumentNo": "PO number or reference or null",
  "notes": "anything else relevant"
}
```

### Response

```json
{
  "extractedData": { "customerHint": "...", "lines": [...] },
  "rawText": "..."
}
```

The frontend constructs a descriptive user message from `extractedData` (e.g. "I uploaded a document. Customer: Mega Corp. Lines: 5× Item 1000 @ 1,200 ISK.") and appends it to the chat messages before calling `/api/chat`.

## Frontend State Management

| Variable | Type | Description |
|---|---|---|
| `messages` | `Array` | Full Anthropic-format conversation history (`{role, content}`) |
| `pendingOrder` | `Object \| null` | Draft order from `propose_sales_order`; shown in confirmation panel |
| `isBusy` | `boolean` | Prevents concurrent API calls |

## Chat Flow

```
User types message → sendMessage()
  → pushes {role:'user', content} to messages[]
  → calls _callChatApi()
    → POST /api/chat with full messages[] + settings
    → renders data.reply as assistant bubble
    → if data.pendingOrder → showConfirmPanel(order)
    → if data.orderNo → showSuccessBanner(orderNo)

User drops file → uploadFile(file)
  → POST /api/upload (multipart)
  → constructs descriptive user message from extractedData
  → pushes to messages[]
  → calls _callChatApi() (same as above)
```

## Order Confirmation Panel

Shown instead of the chat panel when `pendingOrder` is set:

- **Header row**: Customer No., Customer Name, Order Date, Requested Delivery Date, External Doc No.
- **Lines table**: Item No. | Description | Qty | Unit | Unit Price | Line Amount | Stock Warning
  - Rows with `stockOk === false` highlighted in amber
- **Totals**: Subtotal (excl. VAT), VAT at 24%, Total (incl. VAT)
- **Confirm button** → `confirmOrder()` → calls `sendMessage('__CONFIRM_ORDER__')` with `pendingOrder` in the body
- **Cancel button** → returns to chat panel, `pendingOrder` cleared

## Success State

After order creation:
- A green success banner replaces the chat/confirm panel
- Shows the BC order number (`SO-xxxxx`)
- "Start New Order" button clears `messages[]`, `pendingOrder`, and restores the chat panel

## `api/shared/bcClient.js`

Shared utility module used by both `api/chat` and `api/upload`:

| Export | Description |
|---|---|
| `getToken(tenantId, clientId, clientSecret)` | OAuth 2.0 client credentials → access token string |
| `bcTask(tenantId, env, companyId, auth, type, subject, data)` | Two-step: `POST /tasks` → `GET data URL` → parsed JSON |
| `sanitizeFilter(s)` | Strips `()`, CONST/FILTER/WHERE keywords, control characters — prevents tableView injection |
| `callAnthropic(apiKey, payload)` | `POST https://api.anthropic.com/v1/messages` → parsed response |

All HTTP calls use Node.js native `https` module (no external HTTP library).

## Markdown Rendering

`renderMarkdown(text)` in the frontend provides minimal markdown parsing for assistant bubbles:
- `**bold**` → `<strong>`
- `` `code` `` → `<code>`

## Testing Checklist

- [ ] Settings auto-collapse when all fields are pre-filled from `sessionStorage`
- [ ] Send plain text message describing an order → AI responds, calls lookup tools
- [ ] AI asks for clarification when customer is ambiguous
- [ ] AI asks for clarification when item description is ambiguous
- [ ] Stock warning shown in confirmation panel for out-of-stock items
- [ ] Price shown correctly (customer-specific pricing if applicable)
- [ ] Confirm order → BC Sales Header + Lines created, order number returned
- [ ] Success banner shows correct order number
- [ ] "Start New Order" clears state and resets chat
- [ ] Upload Excel file → extracted lines appear in chat, AI continues workflow
- [ ] Upload PDF → Claude extracts order intent from invoice/quote
- [ ] Upload image → Claude reads handwritten or printed order
- [ ] Upload .eml email → headers + body extracted, AI identifies customer and items
- [ ] Cancel confirmation panel → returns to chat without creating order
- [ ] Error from BC (e.g. invalid item) → AI surfaces error as chat message
- [ ] `__CONFIRM_ORDER__` with wrong/missing `pendingOrder` → handled gracefully
