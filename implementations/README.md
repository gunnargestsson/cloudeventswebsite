# Implementation Requirements

This folder contains detailed implementation specifications for the Business Central Cloud Events web portal and its features.

## Structure
Each requirement is stored in its own subfolder with complete implementation details:
- Architecture and design patterns
- Field specifications
- Validation rules
- UI/UX structure  
- API integration details
- JavaScript implementation
- Testing checklist

## Requirements

### Requirement 0: BC Portal - Core Infrastructure
**Folder**: `requirement-0-bc-portal/`  
**Status**: ✅ Implemented  
**Description**: Foundation web portal connecting to Microsoft Dynamics 365 Business Central via Cloud Events API.

**Key Features**:
- OAuth 2.0 authentication with Microsoft Identity Platform
- Cloud Events API integration (two-step task posting)
- Multi-company support with context persistence
- Multi-language support via BC Translation table
- Customer list with search, filter, and pagination
- Modern dark theme UI with responsive layouts
- Server-side token caching for performance
- Field metadata caching per company and language

**Files**:
- `SPECIFICATION.md` - Complete infrastructure documentation

**Technical Stack**:
- Frontend: Vanilla JS, HTML5, CSS3
- Backend: Azure Functions (Node.js 18)
- Hosting: Azure Static Web Apps
- API: Business Central Cloud Events API v1.0

---

### Requirement 1: Customer Creation
**Folder**: `requirement-1-customer-creation/`  
**Status**: ✅ Implemented  
**Description**: Create new customer records in Business Central with validation, auto-population, and lookup support.

**Key Features**:
- Icelandic Kennitala validation
- Auto-population (Registration Number → Customer No., Post Code → City/Country, Gen. Bus. → VAT Bus.)
- 10 lookup tables for dropdowns
- Image upload support
- Required field validation

**Files**:
- `SPECIFICATION.md` - Complete implementation guide

### Requirement 2: Sales History Tab
**Folder**: `requirement-2-sales-history/`  
**Status**: ✅ Implemented  
**Description**: Display item-level sales history for selected customer in a new tab positioned between "Ledger Entries" and "Documents".

**Key Features**:
- Item-level sales aggregation (quantity and order count per item)
- Date range filter (from/to dates with defaults)
- Sortable table columns
- Localized field captions and UI strings
- Customer.SalesHistory.Get Cloud Events API integration
- Tab positioned between Ledger Entries and Documents

**Files**:
- `SPECIFICATION.md` - Complete implementation guide with API details, field specs, and testing checklist

**Implementation Progress**:
- ✅ Tab UI structure implemented
- ✅ Tab switching logic completed
- ✅ Translation strings added
- ✅ Lazy loading implemented
- ✅ Complete specification documented
- ✅ Core functionality implemented

---

### Requirement 3: Date Range Filter for Ledger Entries and Documents
**Folder**: `requirement-3-date-filter-ledger-documents/`
**Status**: ✅ Implemented
**Description**: Add From/To date range filter bars to the Ledger Entries and Documents tabs in the customer detail view, matching the UX pattern of the Sales History tab.

**Key Features**:
- Date pickers with last-12-months default
- Server-side filtering via `startDateTime` / `endDateTime` on `Data.Records.Get`
- Validation: From required, To ≤ today, From ≤ To
- Empty-state subtitle when no records match the period
- All new UI strings added to `UI_STRINGS` for translation

**Files**:
- `SPECIFICATION.md` - Complete implementation guide with API details and testing checklist

---

### Requirement 4: BC Cloud Events Explorer
**Folder**: `requirement-4-cloud-events-explorer/`
**Status**: ✅ Implemented
**Description**: Developer tool for interactively composing, sending, and inspecting Business Central Cloud Events API messages. Browse all message types, compose JSON envelopes, inspect responses, and replay historical requests.

**Key Features**:
- All BC message types listed and grouped by namespace
- Interactive JSON compose panel with source/subject/lcid/data fields
- Live response inspector with Result, Request JSON, and Raw tabs
- History replay via `/requests({id})/data` (direct, single-step)
- Queue support: async message posting + GetStatus / RetryTask actions
- PDF response rendering inline
- Source filter for history

**Files**:
- `SPECIFICATION.md` - Complete implementation guide

---

### Requirement 5: BC Metadata Explorer
**Folder**: `requirement-5-metadata-explorer/`
**Status**: ✅ Implemented
**Description**: Developer tool for browsing the complete table and field catalogue of a Business Central company. Shows field names, JSON keys, captions, types, enums, and permissions.

**Key Features**:
- All BC tables via `Help.Tables.Get` with search/filter
- Field detail view: Name, JSON Key, Caption, Type, Len, Class, PK, Enum values + captions
- Read/Write permission check via `Help.Permissions.Get` (parallel with field load)
- Dynamic language selector populated from BC `Allowed Language` + `Language` tables
- Results cached per table; cache invalidated on language change
- Bulk export to YAML / JSON / CSV / Markdown

**Files**:
- `SPECIFICATION.md` - Complete implementation guide

---

### Requirement 6: AI Sales Order Assistant
**Folder**: `requirement-6-sales-order-assistant/`
**Status**: ✅ Implemented
**Description**: Conversational AI assistant powered by Anthropic Claude for creating Business Central sales orders from natural language or uploaded documents (Excel, PDF, images, emails).

**Key Features**:
- Natural language order entry via multi-turn Claude conversation
- Document upload: Excel, PDF, images, .eml, .msg parsed server-side
- Real-time BC lookups: customer search, item search, availability, pricing, credit check
- Agentic tool loop: 6 BC-integrated tools, up to 10 turns per message
- Order confirmation panel with lines, stock warnings, VAT totals before committing
- BC order creation via `Data.Records.Set` on Sales Header + Sales Lines

**Technical Stack**:
- Frontend: `sales-assistant.html`
- API: `api/chat/index.js` (agentic loop), `api/upload/index.js` (file parsing), `api/shared/bcClient.js` (shared utilities)
- AI Model: `claude-sonnet-4-20250514`
- npm deps: `busboy`, `xlsx`, `msg-parser`

**Files**:
- `SPECIFICATION.md` - Complete implementation guide

---

### Requirement 7: Global Connection Settings
**Folder**: `requirement-7-global-settings/`
**Status**: ✅ Implemented
**Description**: Centralise BC connection parameters in `localStorage` so credentials entered once persist across all pages and sessions. Adds a company-name dropdown (instead of raw GUID), language selection, and auto-fill from server environment variables.

**Key Features**:
- Shared `settings.js` module with `bcSettingsLoad()`, `bcSettingsSave()`, `bcSettingsClear()`, `bcSettingsReady()`, `bcSettingsHeaders()` helpers
- New `GET /api/companies` Azure Function — fetches company list using client-supplied credentials
- Settings panel component used by `bc-metadata-explorer.html`, `bc-cloud-events-explorer.html`, `sales-assistant.html`
- Company dropdown auto-populated via `/api/companies` after credentials entered
- Language dropdown loaded from BC `Allowed Language` + `Language` tables per company
- All settings persisted in `localStorage` with `bc_portal_` prefix
- LCID synced to/from `index.html` so language choice is consistent across all pages

**Files**:
- `SPECIFICATION.md` - Complete implementation guide with module API, endpoint spec, boot sequence, page-by-page changes, and testing checklist

---

### Requirement 8: BC Metadata MCP Server
**Folder**: `requirement-8-mcp-server/`
**Status**: ✅ Implemented  
**Description**: Model Context Protocol server that exposes Business Central metadata and data to AI assistants (GitHub Copilot, Claude Desktop, Cursor) via a single HTTP POST endpoint at `/api/mcp`. Supports the MCP Streamable HTTP transport (`2024-11-05`).

**Current Tools (implemented)**:
- `list_tables`, `get_table_info`, `get_table_fields` — BC table and field metadata
- `list_companies`, `list_message_types`, `get_message_type_help`, `call_message_type`
- `get_records`, `set_records`, `search_customers`, `search_items`
- `list_translations`, `set_translations`
- `get_record_count`, `get_sales_order_statistics`
- `get_integration_timestamp`, `set_integration_timestamp`, `reverse_integration_timestamp`
- `encrypt_data`, `decrypt_data` — AES-256-GCM symmetric encryption using server-side key

**Credential handling:**
- Server-side env vars (`BC_TENANT_ID`, `BC_CLIENT_ID`, `BC_CLIENT_SECRET`) are the default
- Per-call `tenantId` / `clientId` / `clientSecret` / `environment` params override env vars
- `encryptedConn` — Base64 AES-256-GCM blob containing JSON credentials; see §18 in SPECIFICATION.md
- `x-encrypted-conn` HTTP header — workspace-level encrypted credentials set once in `.vscode/mcp.json`; automatically injected into every tool call (§18)

**Selecting the default company (`x-company-id`):**

Set the `x-company-id` header in `.vscode/mcp.json` to pin a specific company GUID for every tool call:
```json
{
  "servers": {
    "bc-metadata": {
      "type": "http",
      "url": "https://dynamics.is/api/mcp",
      "headers": {
        "x-encrypted-conn": "",
        "x-company-id": "<company GUID>"
      }
    }
  }
}
```

If `x-company-id` is **empty or omitted**, the server falls back to the `BC_COMPANY_ID` env var, then the first company in the environment. To find the right GUID, ask the AI assistant:

> "Give me a list of companies and their IDs"

It will call the `list_companies` tool and return a table like:

| Name | ID |
|---|---|
| CRONUS IS | `1998a733-7a01-f111-a1f9-6045bd750e1f` |
| DataShip Test1 | `8a1b4113-af17-f111-8340-0022489b46a1` |
| … | … |

Copy the GUID of the company you want and paste it into `x-company-id` in `.vscode/mcp.json`.

**Planned Additions**:
- Optional `MCP_API_KEY` bearer token guard (§11a)
- Updated `/.well-known/mcp.json` discovery document (§13)

---

### Requirement 9: Dedicated Connection Landing Page
**Folder**: `requirement-9-landing-page/`
**Status**: ⏳ Ready for Implementation (pending design decisions Q1–Q6)
**Description**: Restructure the site so that `index.html` becomes a dedicated connection/configuration landing page. The existing BC Portal content moves to `bc-portal.html`. The landing page presents a credential form (using `settings.js`), a company dropdown, and a language selector. Once connected, a navigation card grid leads users to all available tools.

**Key Features**:
- Credential form on `index.html` using `bcSettingsLoad/Save/Clear()` from `settings.js`
- Company dropdown populated via `GET /api/companies` (Requirement 7 endpoint)
- Language selector persisted to `bc_portal_lcid`
- Navigation card grid (BC Portal, Cloud Events Explorer, Metadata Explorer, AI Sales Assistant)
- Cards shown only after `bcSettingsReady()` is true
- "← Home" navigation link on all sub-pages replacing the three-pill header toolbar
- `bc-portal.html` — current `index.html` BC Portal content moved with minimal changes
- Optional guard redirect on sub-pages when settings are missing

**Open Design Decisions**:
- Q1: What defines "connected" — local validation only vs. live API verification?
- Q2: Fate of settings panels on sub-pages — remove, keep as fallback, or keep gated?
- Q3: Scope of the single menu — landing page only vs. all pages?
- Q4: `bc-portal.html` credential mode — server-side (env vars) or client-supplied?
- Q5: Auto-redirect when already configured — always show config, auto-jump, or jump with override?
- Q6: Back navigation target — `index.html` (home), `bc-portal.html`, or both?

**Files**:
- `SPECIFICATION.md` - Architecture, layout wireframe, HTML skeleton, JS logic, CSS, testing checklist
- Optional `MCP_API_KEY` bearer token auth
- Table name input validation to prevent injection
- `BC_COMPANY_ID` / `BC_COMPANY_NAME` env vars for explicit company targeting
- Updated `/.well-known/mcp.json` discovery document

**Files**:
- `SPECIFICATION.md` - Full documentation of current implementation, all proposed additions, implementation order, and testing checklist

---

### Requirement 11: BC Open Mirror
**Folder**: `requirement-11-open-mirror/`
**Status**: 📝 Specification — Awaiting clarification
**Description**: Standalone page (`bc-open-mirror.html`) that reads data from BC tables via `CSV.Records.Get` and sends it to a configured mirror destination. Supports both manual ("Run Now") and automatic per-table interval-based mirroring. Mirror destination connection config is stored encrypted in the BC `Cloud Events Storage` table. The `Cloud Events Integration` table tracks the last successful mirror timestamp per table.

**Key Features**:
- Navigation card on landing page alongside BC Portal, CE Explorer, Metadata Explorer
- Single encrypted mirror destination connection config (stored in `Cloud Events Storage`, source `"BC Open Mirror"`, id `11111111-1111-1111-1111-000000000001`)
- Per-table config (table name/number, field numbers, tableView filter, interval, active toggle) stored in `Cloud Events Storage` (id `11111111-1111-1111-1111-000000000002`)
- Timestamp workflow using `Cloud Events Integration` (source `"BC Open Mirror"`, tableId = BC table number)
- Pre-fetch count check via `Data.Records.Get` with `take:1` before calling `CSV.Records.Get`
- Timestamp stored **before** the CSV fetch; rolled back via `reverse_integration_timestamp` on failure
- Browser-based per-table interval scheduler (runs while page is open)
- Manual "Run Now" button per table
- Session-scoped run log (timestamp, record count, status, duration)

**Open Questions (blocking)**:
- Q1: Mirror destination type (Fabric Open Mirroring ADLS? Generic HTTP POST? Blob storage? Other?)
- Q2: Connection fields for the chosen destination type
- Q3: Encryption mechanism — reuse `/api/mcp` `encrypt_data` tool or add dedicated endpoint?
- Q4: Does the CSV transit through the browser, or should a server-side hop fetch+push?
- Q5: Error handling — auto-rollback timestamp on failure? (recommended: yes)
- Q6: Table config details — active/inactive toggle? Display name alias? Additional tableView filter?
- Q7: Single vs. multiple mirror destinations?
- Q8: Run history — last-run indicator only, or session log, or persistent log?

**Files**:
- `SPECIFICATION.md` - Full specification with proposed architecture, layout wireframe, timestamp workflow, and all open questions

---

### Requirement 12: Claude Website Chat via MCP
**Folder**: `requirement-12-claude-mcp-chat/`
**Status**: ✅ Implemented
**Description**: Add a dedicated website chat page that uses Anthropic Claude with the existing Business Central MCP server as its tool backend. The chat bridge forwards the active BC access configuration from the website to the MCP server so Claude operates against the same BC environment and company selected by the user.

**Key Features**:
- Dedicated `claude-mcp-chat.html` page with chat transcript and MCP tool activity panel
- New `/api/claude-chat` Azure Function that runs the Claude tool loop server-side
- Dynamic tool discovery from `/api/mcp` via `tools/list`
- BC config forwarding from website settings to MCP for both server mode and custom mode
- Company-aware Claude conversations using the selected BC company from the landing page
- API key required from webpage input (aligned with the AI Sales Assistant pattern)
- Model selection handled automatically server-side (no user model picker)

**Files**:
- `SPECIFICATION.md` - Complete implementation guide for Claude chat over MCP

---

### Requirement 13: Global Top Bar + API Key Center
**Folder**: `requirement-13-global-topbar-and-api-key-center/`
**Status**: ✅ Implemented
**Description**: Introduce a consistent top bar across all pages with `Home`, `Connected`, and `API Key` controls, and centralize API key management in a dedicated page. Remove page-local API key entry from AI Sales Assistant and Claude MCP Chat.

**Key Features**:
- Shared top-bar UX contract across all feature pages
- Dedicated API key settings page (`api-key-settings.html`)
- Removal of inline API key editors from `sales-assistant.html` and `claude-mcp-chat.html`
- Unified Claude API key (localStorage) consumed by both assistants
- Cross-page connection status visibility using existing `settings.js`
- Same top-bar controls also on `index.html`

**Files**:
- `SPECIFICATION.md` - Complete implementation guide with UX contract, scope, implementation plan, and test checklist

---

### Requirement 14: Azure Blob Cache Service
**Folder**: `requirement-14-cache-service/`
**Status**: ❌ Not Implemented
**Description**: Generic cache service as an Azure Function that stores temporary data (XML, JSON, text, binary) in Azure Blob Storage and returns a publicly accessible URI. Supports caching of Business Central API responses, large payloads, temporary file storage, and shareable data URIs. Adapted from an existing C# implementation into JavaScript/Node.js to match the current application stack.

**Key Features**:
- HTTP POST endpoint `/api/cache` accepting data, contentType, ttl, fileName, encoding
- Azure Blob Storage integration with public read access
- GUID-based blob naming prevents collisions
- TTL (time-to-live) metadata with configurable expiry (1 min to 7 days)
- Support for text (UTF-8) and binary (base64) encoding
- Content-Type detection and configuration
- Returns URI, blobName, expiresAt, sizeBytes
- CORS support for cross-origin requests
- Extension extraction from fileName or contentType
- Input validation (required fields, TTL bounds, MIME type)

**Use Cases**:
- Cache large XML/JSON responses from BC API
- Temporary file storage for sharing
- Base64 image upload and hosting
- Document preview link generation

**Technical Stack**:
- Backend: Azure Functions (Node.js 18)
- Storage: Azure Blob Storage (SDK v12)
- Container: `cache` with blob-level public access
- Dependencies: `@azure/storage-blob`, `uuid`

**Files**:
- `SPECIFICATION.md` - Complete implementation guide with API spec, validation rules, code skeleton, dependencies, use cases, testing checklist, and migration notes from C# original

**Optional Enhancements (Future)**:
- GET /api/cache/{blobName} with expiry validation
- DELETE /api/cache/{blobName} for manual cleanup
- Timer-triggered cleanup function (daily sweep)
- Compression support (gzip for large text/JSON)
- Authentication (API key or Azure AD token)

---

## Architecture Overview

```
Client (Browser)
    ↓ HTTP POST
Azure Function (/api/bc?companyId=xxx)
    ↓ OAuth Token (cached)
    ↓ POST /tasks
Business Central Cloud Events API
    ↓ Returns task with data URL
Azure Function
    ↓ GET /data
Business Central Cloud Events API
    ↓ Returns result
Azure Function
    ↓ JSON Response
Client (Browser)
```

### Key Concepts

**Cloud Events Messages:**
- Standard format: specversion, type, source, subject, data
- Types: Data.Records.Get, Data.Records.Set, Help.Fields.Get
- Two-step process: POST task → GET data URL

**Language Support:**
- LCID (Windows Language ID) sent with every request
- Field captions localized via Help.Fields.Get
- UI strings translated via Cloud Event Translation table
- Auto-creation of translation placeholders

**Caching Strategy:**
- OAuth tokens: Server-side, 60-second pre-expiry refresh
- Field metadata: Client-side per company+language+table
- Cleared on context changes (company/language switch)

**State Management:**
```javascript
let selectedCompany = null;     // Current company context
let selectedLcid = 1033;        // Current language (1033=English, 1039=Icelandic)
let fieldMetaCache = {};        // Field metadata cache
let uiTranslations = {};        // UI string translations
let allLanguages = [];          // All languages for dropdowns
```

### Development Guidelines

1. **Always specify field numbers** - Don't retrieve all fields
2. **Cache field metadata** - Use `getFieldMeta()` helper
3. **Support multiple languages** - Use `t()` translation function, add strings to UI_STRINGS
4. **Handle errors comprehensively** - Display full error details for debugging
5. **Follow naming conventions** - Use `cePost()` for Cloud Events, `bcGet()` for legacy API
6. **Validate inputs** - Check required fields before API calls
7. **Use semantic HTML** - Proper structure with data-* attributes for translation

### Adding New Features

1. Create new requirement folder: `requirement-N-feature-name/`
2. Write SPECIFICATION.md with complete details
3. Add UI constants to `UI_STRINGS` array in index.html
4. Implement feature in appropriate view
5. Use `cePost()` for all BC Cloud Events API calls
6. Handle language changes in feature code
7. Add feature to this README with status
8. Test thoroughly using checklist in specification

## Usage
Developers should read the SPECIFICATION.md file in each requirement folder for complete implementation details including:
- Data structures
- API endpoints
- Validation logic
- UI components
- Event handlers
- Testing requirements
