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
