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
**Status**: ✅ Ready for Implementation  
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
- ⏳ Core functionality pending implementation

---

### Requirement 3:
 Date Range Filter for Ledger Entries and Documents
**Folder**: `requirement-3-date-filter-ledger-documents/`
**Status**: ⏳ Ready for Implementation
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
**Status**: ⏳ Ready for Implementation
**Description**: Centralise BC connection parameters in `localStorage` so credentials entered once persist across all pages and sessions. Adds a company-name dropdown (instead of raw GUID), language selection, and auto-fill from server environment variables.

**Key Features**:
- Shared `settings.js` module with `bcSettingsLoad()`, `bcSettingsSave()`, `bcSettingsClear()`, `bcSettingsReady()`, `bcSettingsHeaders()` helpers
- New `GET /api/companies` Azure Function — fetches company list using client-supplied credentials
- Settings panel component used by `bc-metadata-explorer.html`, `bc-cloud-events-explorer.html`, `sales-assistant.html`
- Pre-fill from `/api/config` (tenant / clientId / environment) on first load
- Company dropdown auto-populated via `/api/companies` after credentials entered
- Language dropdown loaded from BC `Allowed Language` + `Language` tables per company
- All settings (including client secret) persisted in `localStorage` with `bc_portal_` prefix
- LCID synced to/from `index.html` so language choice is consistent across all pages

**Files**:
- `SPECIFICATION.md` - Complete implementation guide with module API, endpoint spec, boot sequence, page-by-page changes, and testing checklist

---

## Architecture Overview

### Cloud Events API Flow

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
