# Requirement 4: BC Cloud Events Explorer

## Overview
A standalone developer tool for interactively sending and inspecting Business Central Cloud Events API messages. Enables developers to compose arbitrary Cloud Events envelopes, fire them directly at BC, inspect responses, and replay historical requests — all from the browser.

**Key Features:**
- ✅ **Message Type Browser**: All BC Cloud Events message types listed and grouped by namespace (Data, Help, Customer, Item, etc.)
- ✅ **Interactive Compose Panel**: JSON editor for composing Cloud Events envelopes with field auto-population
- ✅ **Live Response Inspector**: Formatted JSON, PDF viewer, and raw text response panels
- ✅ **History Replay**: Browse `/tasks` (synchronous) and `/queues` (async) history; reload original request payload via `/requests({id})/data`
- ✅ **Queue Actions**: `Microsoft.NAV.GetStatus` and `Microsoft.NAV.RetryTask` on queued messages
- ✅ **Source Filter**: Filter history by `source` field
- ✅ **PDF Support**: Inline PDF rendering for document-type responses
- ✅ **Per-request CORS proxy**: All BC calls proxied through `/api/explorer` Azure Function to avoid browser CORS restrictions

## Architecture

### Deployment Model
- **Hosting**: Azure Static Web Apps
- **File**: `bc-cloud-events-explorer.html`
- **API Proxy**: `api/explorer/index.js` (Azure Function)
- **Route**: `/bc-cloud-events-explorer` → `bc-cloud-events-explorer.html` (via `staticwebapp.config.json`)

### Technology Stack
- **Frontend**: Vanilla JavaScript, HTML5, CSS3 (dark theme, JetBrains Mono + Syne fonts)
- **Backend**: Azure Functions (Node.js) — `api/explorer/index.js`
- **Authentication**: OAuth 2.0 client credentials — credentials sent per-request from browser via custom request headers

## Connection Configuration

The sidebar collects five fields, all passed as HTTP request headers to `/api/explorer`:

| Header | Field | Notes |
|---|---|---|
| `x-bc-tenant` | Azure AD Tenant ID | Required |
| `x-bc-environment` | BC Environment name | e.g. `UAT` |
| `x-bc-company` | Company ID (GUID) | Required |
| `x-bc-client-id` | App Registration Client ID | Required |
| `x-bc-client-secret` | App Registration Client Secret | Required |

Credentials are never stored — they exist only in the input fields for the duration of the browser session.

## Layout

Three-column layout (`250px | flex | 360px`):

```
┌─────────────────────────────────────────────────────┐
│  Header: Logo · Title · Status indicator            │
├──────────────┬────────────────────┬─────────────────┤
│  Sidebar     │  Compose / Output  │  Inspector      │
│  (250px)     │  (flex)            │  (360px)        │
│              │                    │                 │
│  Connection  │  Message type      │  Response tabs: │
│  fields      │  selector          │  · Result       │
│              │  JSON editor       │  · Request JSON │
│  Message     │  Send button       │  · Raw          │
│  type list   │                    │                 │
│  History     │                    │                 │
│  panel       │                    │                 │
└──────────────┴────────────────────┴─────────────────┘
```

### Sidebar Sections

1. **Config area** (`.sb-cfg`): Five connection input fields + Connect button
2. **Message type list** (`.sb-types`): All types from `Help.MessageTypes.Get`, grouped by namespace, with direction badges (IN / OUT / META / BOTH)
3. **History panel**: Tabs for Tasks and Queues; each row shows message ID, type, source, date, and status badge; source filter dropdown

### Compose Panel (middle column)

- Message type display (from sidebar selection)
- `subject` input
- `source` input (defaults to `BC-Explorer`)
- `lcid` selector (numeric language ID)
- `data` textarea (JSON string for the message payload)
- **Send** button → `POST /tasks`
- For queue types: **Queue** button → `POST /queues`; **GetStatus** / **RetryTask** buttons appear after queuing

### Inspector Panel (right column)

Three tabs:
1. **Result** — pretty-printed JSON result or inline PDF viewer
2. **Request JSON** — reconstructed envelope JSON sent to BC
3. **Raw** — raw text/binary response

## API Integration

### Primary proxy: `/api/explorer`

The Azure Function (`api/explorer/index.js`) handles multiple sub-operations via the `x-bc-endpoint` header:

| `x-bc-endpoint` value | Operation |
|---|---|
| `tasks` | `POST /tasks` (synchronous) — post envelope, follow `task.data` URL |
| `queues` | `POST /queues` (asynchronous) |
| `GetStatus` | `GET /queues({id})/Microsoft.NAV.GetStatus` |
| `RetryTask` | `POST /queues({id})/Microsoft.NAV.RetryTask` |
| `history` | `GET /tasks` + `GET /queues` (combined, last N entries) |
| `fetch-result` | `GET <data URL>` — fetch result by known URL |
| `fetch-request` | `GET /requests({id})/data` — fetch original request payload directly |

### `fetch-request` Endpoint

**Key design decision**: Rather than fetching `/requests({id})` first and following the `data` URL, the proxy calls `/requests({id})/data` directly. This saves one HTTP round-trip and avoids the intermediate envelope parse.

```
GET /companies({companyId})/requests({id})/data
→ returns the original Cloud Events JSON envelope body
```

### `tasks` Two-Step Flow

```
1. POST /companies({companyId})/tasks
   Body: Cloud Events envelope
   → { id, data: "<result URL>", ... }

2. GET <data URL>
   Authorization: Bearer <token>
   → Result JSON (or PDF binary)
```

## History Replay

When a user clicks a history row:
1. The envelope fields (`type`, `source`, `subject`, `lcid`) from the stored task/queue record are restored to the compose panel
2. `ceFetchRequest(itemId)` is called → `fetch-request` endpoint → `/requests({id})/data`
3. The returned JSON string is parsed; the `data` field is extracted and placed in the compose `data` textarea
4. If the response result is still available (`task.data` URL), it is fetched via `ceFetchResult()` and shown in the inspector

## Status Indicator

The header displays a live connection status dot (`.sd`):
- `.sd.ok` — green, pulsing — types loaded successfully
- `.sd.ld` — yellow, fast-pulse — loading in progress
- `.sd.err` — red — error state

## Message Type Badges

Each message type in the sidebar has a direction badge:
- **IN** (orange) — inbound-only types
- **OUT** (cyan) — outbound-only types  
- **META** (purple) — metadata query types
- **BOTH** (green) — bidirectional types

Badge is determined from the `direction` field of the `Help.MessageTypes.Get` result.

## Key JavaScript Functions

| Function | Description |
|---|---|
| `connectAndLoad()` | Sends `Help.MessageTypes.Get`, populates sidebar |
| `buildSidebar()` | Groups types by namespace prefix, renders list |
| `selectType(name)` | Loads type schema/description, prefills compose panel |
| `sendMessage()` | Builds envelope, calls `cePost()`, renders result |
| `cePost(envelope, endpoint)` | Core proxy call — sends to `/api/explorer` with auth headers |
| `ceQueueAction(queueId, action)` | Queue-specific proxy call |
| `ceHistory()` | Fetches task + queue history |
| `ceFetchResult(dataUrl, datacontenttype)` | Fetches known result URL via proxy |
| `ceFetchRequest(itemId)` | Fetches original request body via `/requests({id})/data` |
| `openHistoryItem(item)` | Restores envelope fields + data to compose panel |
| `renderResult(data)` | Formats JSON or renders inline PDF in inspector |

## Testing Checklist

- [ ] Connect with valid credentials → types list populates, status turns green
- [ ] Connect with invalid credentials → error state, informative error message
- [ ] Select a type → compose panel prefilled with correct envelope shape
- [ ] Send `Help.MessageTypes.Get` → list of types returned
- [ ] Send `Data.Records.Get` with `tableName` in data → customer/item records returned
- [ ] Send `Data.Records.Set` → record created, returns created record
- [ ] Queue an async message → queue ID returned, GetStatus shows `Created`/`Updated`
- [ ] Retry a queued message via RetryTask → new task created
- [ ] Load history → tasks and queues appear in sidebar
- [ ] Click a history row → compose panel restored, data textarea populated
- [ ] Click a history row for a PDF response → PDF rendered in inspector
- [ ] Source filter → only matching rows shown
- [ ] PDF response (e.g. Sales Invoice) → inline PDF viewer renders correctly
