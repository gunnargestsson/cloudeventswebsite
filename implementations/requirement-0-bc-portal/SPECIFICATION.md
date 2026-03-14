# Requirement 0: Business Central Cloud Events Portal - Core Infrastructure

## Overview
A modern, web-based portal that connects to Microsoft Dynamics 365 Business Central via the Cloud Events API, providing a foundation for building custom business applications with full authentication, company selection, multi-language support, and customer management.

**Key Features:**
- ✅ **OAuth 2.0 Authentication**: Secure client credentials flow with Microsoft identity platform
- ✅ **Cloud Events API Integration**: Two-step task posting and result retrieval
- ✅ **Multi-Company Support**: Company listing and selection with context persistence
- ✅ **Multi-Language Support**: UI translations via BC Cloud Event Translation table
- ✅ **Customer Management**: List, search, filter, and paginate customers
- ✅ **Modern UI**: Dark theme with gradient accents, responsive grid layouts
- ✅ **Token Caching**: Server-side token caching for performance
- ✅ **Error Handling**: Comprehensive error reporting with stack traces

## Architecture

### Deployment Model
- **Hosting**: Azure Static Web Apps
- **API Runtime**: Azure Functions (Node.js 18)
- **Configuration**: Environment variables for BC credentials

### Technology Stack
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Azure Functions (Node.js)
- **API**: Business Central Cloud Events API v1.0
- **Authentication**: Microsoft Identity Platform OAuth 2.0

## Authentication & Authorization

### OAuth 2.0 Client Credentials Flow

**Environment Variables Required:**
```bash
BC_TENANT_ID=<azure-ad-tenant-id>
BC_CLIENT_ID=<app-registration-client-id>
BC_CLIENT_SECRET=<app-registration-secret>
BC_ENVIRONMENT=<environment-name>  # Default: "UAT"
```

**Token Endpoint:**
```
https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token
```

**Required Scope:**
```
https://api.businesscentral.dynamics.com/.default
```

### Token Caching Strategy

**Server-Side Caching (Azure Function):**
- Token cached at module level (survives warm invocations)
- Automatic refresh 60 seconds before expiry
- No client-side token storage (security best practice)

**Implementation:**
```javascript
let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken(tenantId, clientId, clientSecret) {
  // Return cached token if valid for at least 60 more seconds
  if (_cachedToken && Date.now() < _tokenExpiry - 60000) {
    return _cachedToken;
  }
  
  // Request new token
  const data = await post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://api.businesscentral.dynamics.com/.default"
    }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _cachedToken;
}
```

## API Architecture

### Azure Function Endpoints

#### 1. `/api/token` - Token Acquisition (Deprecated)
Direct token endpoint - not used in current implementation (tokens handled server-side only).

#### 2. `/api/config` - Configuration Info
Returns non-sensitive configuration for client debugging:
```json
{
  "BC_TENANT_ID": "xxx-xxx-xxx",
  "BC_CLIENT_ID": "xxx-xxx-xxx",
  "BC_CLIENT_SECRET": true,
  "BC_ENVIRONMENT": "UAT"
}
```

#### 3. `/api/bc` - Main BC Proxy

**Mode 1: Legacy V2.0 API (Company List)**
```
GET/POST /api/bc?path=<relative-path>
```
- Used for pre-company-selection operations
- Example: `?path=companies` returns company list

**Mode 2: Cloud Events API (All other operations)**
```
POST /api/bc?companyId=<guid>
Body: Cloud Events envelope (JSON)
```

**Two-Step Process:**
1. **POST to /tasks**: Create Cloud Events task
2. **GET /data**: Follow `data` URL to retrieve result

**Response Types:**
- **JSON**: Standard Cloud Events result with status/result fields
- **Binary**: PDF or other binary content (streams directly)
- **Error**: Returns error messages with call stacks for debugging

### Cloud Events API Integration

#### Message Structure

**Request Envelope:**
```json
{
  "specversion": "1.0",
  "type": "Data.Records.Get",
  "source": "BC Portal",
  "subject": "Customer",
  "data": "{\"tableName\":\"Customer\",\"fieldNumbers\":[2,7,35,39]}",
  "lcid": 1033
}
```

**Key Fields:**
- `specversion`: Always "1.0"
- `type`: API operation (Data.Records.Get, Help.Fields.Get, etc.)
- `source`: Application identifier ("BC Portal")
- `subject`: Optional table name for certain operations
- `data`: JSON string containing operation-specific parameters
- `lcid`: Windows Language ID (added automatically by proxy)

**Response Structure:**
```json
{
  "status": "Success" | "Error",
  "result": [...],
  "error": "error message",
  "callStack": "detailed stack trace",
  "noOfRecords": 123
}
```

#### Core API Operations

**1. Data.Records.Get - Retrieve Records**
```javascript
await cePost(companyId, {
  specversion: '1.0',
  type: 'Data.Records.Get',
  source: 'BC Portal',
  subject: 'Customer',  // Optional
  data: JSON.stringify({
    tableName: 'Customer',
    fieldNumbers: [2, 7, 35, 39, 59],  // Specific fields for performance
    skip: 0,
    take: 20,
    tableView: 'WHERE(Blocked=CONST())'  // Optional filter
  })
});
```

**2. Data.Records.Set - Create/Update Records**
```javascript
await cePost(companyId, {
  specversion: '1.0',
  type: 'Data.Records.Set',
  source: 'BC Portal',
  subject: 'Customer',
  data: JSON.stringify({
    data: [{
      primaryKey: { No_: '10000' },
      fields: {
        Name: 'Acme Corp',
        City: 'Reykjavik',
        // ... other fields
      }
    }]
  })
});
```

**3. Help.Fields.Get - Field Metadata**
```javascript
await cePost(companyId, {
  specversion: '1.0',
  type: 'Help.Fields.Get',
  source: 'BC Portal',
  data: JSON.stringify({
    tableName: 'Customer',
    fieldNumbers: [2, 7, 35, 39]  // Returns localized captions
  })
});
```

Returns:
```json
{
  "result": [
    {
      "id": 2,
      "name": "Name",
      "jsonName": "Name",
      "caption": "Name",
      "class": "Normal",
      "type": "Text",
      "len": 100,
      "isPartOfPrimaryKey": false
    }
  ]
}
```

## Multi-Language Support

### Language Selection

**Two Language Contexts:**
1. **Allowed Languages** (`Table 8, WHERE(Allowed LANGUAGE=CONST(true))`): For UI language selector
2. **All Languages** (`Table 8`): For customer language dropdown field

**Language State:**
```javascript
let selectedLcid = 1033;  // Windows Language ID (1033 = English, 1039 = Icelandic)
let allLanguages = [];    // All languages for customer dropdown
```

### UI Translation System

**Translation Table:**
- **Table**: Cloud Event Translation
- **Primary Key**: Source, Windows Language ID, Source Text
- **Fields**: Target Text

**Translation Workflow:**
1. Define UI strings in `UI_STRINGS` array
2. On language change, fetch translations from BC
3. Auto-create placeholder records for missing translations
4. Apply translations to DOM elements with `data-t` / `data-tp` attributes

**Implementation:**
```javascript
// UI constants to translate
const UI_STRINGS = [
  'Loading customers...',
  'companies',
  'customers',
  'Active',
  'Search customers...',
  // ... 50+ strings
];

// Fetch translations from BC
async function loadUiTranslations() {
  uiTranslations = {};
  if (selectedLcid === 1033) return;  // English - no translation needed
  
  const res = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    subject: 'Cloud Event Translation',
    data: JSON.stringify({
      tableView: `WHERE(Windows Language ID=CONST(${selectedLcid}),Source=CONST(BC Portal))`,
      take: UI_STRINGS.length + 50
    })
  });
  
  const rows = res.result || [];
  for (const rec of rows) {
    const src = rec.primaryKey?.SourceText;
    const tgt = rec.fields?.TargetText;
    if (src && tgt) uiTranslations[src] = tgt;
  }
  
  // Create placeholder records for missing translations
  const existing = new Set(rows.map(r => r.primaryKey?.SourceText));
  const missing = UI_STRINGS.filter(s => !existing.has(s));
  
  if (missing.length) {
    await cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Data.Records.Set',
      source: 'BC Portal',
      subject: 'Cloud Event Translation',
      data: JSON.stringify({
        data: missing.map(s => ({
          primaryKey: {
            Source: 'BC Portal',
            WindowsLanguageID: String(selectedLcid),
            SourceText: s
          },
          fields: { TargetText: '' }
        }))
      })
    });
  }
}

// Apply translations to DOM
function applyUiTranslations() {
  // Text content
  document.querySelectorAll('[data-t]').forEach(el => {
    el.textContent = t(el.dataset.t);
  });
  
  // Placeholders
  document.querySelectorAll('[data-tp]').forEach(el => {
    el.placeholder = t(el.dataset.tp);
  });
}

// Translation lookup with fallback
function t(s) {
  return uiTranslations[s] || s;  // Fallback to English
}
```

**HTML Usage:**
```html
<span data-t="Loading customers...">Loading customers...</span>
<input data-tp="Search customers..." placeholder="Search customers...">
```

### Language Change Handler

```javascript
function onLangChange() {
  const select = document.getElementById('lang-select');
  selectedLcid = parseInt(select.value, 10);
  fieldMetaCache = {};  // Clear field metadata cache (captions are language-specific)
  
  // Reload UI translations
  loadUiTranslations().then(() => {
    applyUiTranslations();
    
    // Refresh current view
    if (document.getElementById('view-customers').style.display === 'block') {
      loadCustomers();
    } else if (document.getElementById('view-detail').style.display === 'block') {
      selectCustomer(selectedCustomer?.id);
    }
  });
}
```

## Company Management

### Company Listing

**API Call:**
```javascript
async function loadCompanies() {
  const d = await bcGet('companies');  // Legacy v2.0 API
  companies = d.value || [];
  // ... render company grid
}
```

**Legacy API Helper:**
```javascript
async function bcGet(path) {
  const r = await fetch('/api/bc?path=' + encodeURIComponent(path));
  if (!r.ok) throw new Error(`API error ${r.status}`);
  return r.json();
}
```

**Company Data Structure:**
```json
{
  "id": "guid",
  "name": "Company Name",
  "displayName": "Display Name",
  "systemVersion": "24.0",
  "businessProfileId": "profile-guid"
}
```

### Company Selection

**Selection Flow:**
1. User clicks company card
2. Store selected company in global state
3. Clear all caches (field metadata, enums, translations)
4. Load language options
5. Load UI translations
6. Navigate to customer list

**Implementation:**
```javascript
let selectedCompany = null;

async function selectCompany(id) {
  selectedCompany = companies.find(c => c.id === id);
  if (!selectedCompany) return;
  
  // Clear caches (new company context)
  fieldMetaCache = {};
  blockedEnumCaptions = {};
  uiTranslations = {};
  
  // Update breadcrumbs
  const name = selectedCompany.displayName || selectedCompany.name;
  document.getElementById('crumb-company').textContent = name;
  document.getElementById('crumb-company2').textContent = name;
  document.getElementById('customers-company-label').textContent = name;
  
  // Show customers view
  show('view-customers');
  
  // Load data
  await loadLanguages();        // Allowed languages for UI selector
  await loadAllLanguages();     // All languages for customer dropdown
  await loadUiTranslations();
  applyUiTranslations();
  await loadCustomers();
}
```

## Customer Management

### Customer List

**Fields Retrieved:**
- Field 2: Name
- Field 7: City
- Field 35: Country/Region Code
- Field 39: Blocked (enum)
- Field 59: Balance (LCY)
- Field 82: Prices Including VAT
- Field 83: Location Code
- Field 102: E-Mail
- Field 140: Image (Media)

**API Call with Pagination:**
```javascript
async function loadCustomers(skip = 0) {
  const take = pageSize();  // Dynamic based on viewport
  
  const [res, metaCust] = await Promise.all([
    cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Data.Records.Get',
      source: 'BC Portal',
      data: JSON.stringify({
        tableName: 'Customer',
        fieldNumbers: [2, 7, 35, 39, 59, 82, 83, 102, 140],
        skip,
        take
      })
    }),
    getFieldMeta('Customer', [39])  // Get enum captions for Blocked field
  ]);
  
  customers = (res.result || []).map(mapCustomer);
  const total = res.noOfRecords || 0;
  
  renderCustomers(customers);
  paginate('customer-pagination', total, skip, take, 'loadCustomers');
}
```

### Field Metadata Caching

**Purpose**: Avoid repeated API calls for field metadata (captions, enums)

**Implementation:**
```javascript
const fieldMetaCache = {};

async function getFieldMeta(tableName, fieldNumbers) {
  const key = `${selectedCompany.id}:${selectedLcid}:${tableName}`;
  
  // Return cached result if available
  if (fieldMetaCache[key]) return fieldMetaCache[key];
  
  // Fetch from BC
  const res = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Help.Fields.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName, fieldNumbers })
  });
  
  const meta = res.result || [];
  fieldMetaCache[key] = meta;
  return meta;
}
```

**Cache Invalidation:**
- Cleared on company change
- Cleared on language change (captions are language-specific)

### Customer Search & Filter

**Search Implementation:**
```javascript
function searchCustomers() {
  const q = document.getElementById('customer-search').value.toLowerCase();
  if (!q) {
    renderCustomers(customers);
    return;
  }
  
  const filtered = customers.filter(c =>
    (c.displayName && c.displayName.toLowerCase().includes(q)) ||
    (c.number && c.number.toLowerCase().includes(q)) ||
    (c.city && c.city.toLowerCase().includes(q)) ||
    (c.email && c.email.toLowerCase().includes(q))
  );
  
  renderCustomers(filtered);
}
```

### Pagination

**Dynamic Page Size:**
```javascript
function pageSize() {
  const w = window.innerWidth;
  if (w < 768) return 12;
  if (w < 1200) return 18;
  return 24;
}
```

**Pagination UI:**
```javascript
function paginate(containerId, total, skip, take, loadFn) {
  const pages = Math.ceil(total / take);
  const current = Math.floor(skip / take) + 1;
  
  let html = '<div class="pagination">';
  
  if (current > 1) {
    html += `<button onclick="${loadFn}(${(current - 2) * take})">‹</button>`;
  }
  
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || (i >= current - 2 && i <= current + 2)) {
      const cls = i === current ? 'active' : '';
      html += `<button class="${cls}" onclick="${loadFn}(${(i - 1) * take})">${i}</button>`;
    } else if (i === current - 3 || i === current + 3) {
      html += '<span>...</span>';
    }
  }
  
  if (current < pages) {
    html += `<button onclick="${loadFn}(${current * take})">›</button>`;
  }
  
  html += '</div>';
  document.getElementById(containerId).innerHTML = html;
}
```

## UI/UX Design

### Color Scheme

**CSS Variables:**
```css
:root {
  --bg: #0a0d14;           /* Dark background */
  --surface: #111520;      /* Card background */
  --surface2: #171d2e;     /* Darker surface */
  --border: #1e2640;       /* Subtle borders */
  --border-bright: #2d3a5e;
  --accent: #4f7fff;       /* Primary blue */
  --accent2: #7c5cfc;      /* Secondary purple */
  --accent-glow: rgba(79,127,255,0.18);
  --text: #e8ecf5;         /* Primary text */
  --text-dim: #6b7799;     /* Dimmed text */
  --text-mid: #9ba8c8;     /* Mid-tone text */
  --green: #27c08a;        /* Success/positive */
  --red: #f25f5c;          /* Error/negative */
  --amber: #f5a623;        /* Warning */
  --radius: 12px;
  --radius-sm: 7px;
}
```

### Typography

**Fonts:**
- **Headings**: Syne (Google Fonts) - Bold, modern geometric sans-serif
- **Body**: DM Mono (Google Fonts) - Monospace for technical feel

**Font Loading:**
```html
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet" />
```

### Layout Components

**Header:**
- Sticky position with backdrop blur
- Logo with icon
- Status indicator (connected/error with pulsing dot)
- Language selector dropdown
- Translucent background

**Breadcrumb Navigation:**
- Home > Company > View hierarchy
- Clickable navigation elements
- Updates based on current view

**Grid Layouts:**
- Company cards: `repeat(auto-fill, minmax(300px, 1fr))`
- Customer cards: `repeat(auto-fill, minmax(280px, 1fr))`
- Responsive with CSS Grid

**Card Hover Effects:**
- Border color change to accent
- Vertical lift transform (`translateY(-2px)`)
- Box shadow with accent glow
- Top border gradient reveal

### Status & Feedback

**Status Indicator:**
```javascript
function setStatus(s) {
  const dot = document.querySelector('.status-dot');
  const txt = document.querySelector('.status-text');
  dot.className = 'status-dot ' + s;
  txt.textContent = t(s === 'connected' ? 'Connected' : 'Error');
}
```

**Toast Notifications:**
```javascript
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}
```

**Loading Spinner:**
```html
<div class="loader-wrap">
  <div class="spinner"></div>
  <span class="loader-label" data-t="Loading...">Loading...</span>
</div>
```

## Error Handling

### Error Display Strategy

**1. Network/API Errors:**
- Show full error message with stack trace
- Display in empty-state container
- Toast notification for user feedback

**2. Cloud Events Task Errors:**
- Check `status === 'Error'` in response
- Extract `error` message and `callStack`
- Format for developer debugging

**3. Validation Errors:**
- Inline field validation
- Form-level error summary
- Prevent submission until resolved

**Error Handling Example:**
```javascript
try {
  const result = await cePost(companyId, event);
  
  // Check for BC task error
  if (result.status === 'Error') {
    let errorMsg = result.error || 'Cloud Events task failed';
    
    if (result.callStack) {
      errorMsg += '\n\nCall Stack:\n' + result.callStack;
    }
    
    errorMsg += '\n\nFull Response:\n' + JSON.stringify(result, null, 2);
    throw new Error(errorMsg);
  }
  
  return result;
} catch (e) {
  // Network error or thrown task error
  const errorDetails = e.stack || e.message;
  toast(errorDetails, 'error');
  
  // Display in UI
  document.getElementById('container').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚠</div>
      <p style="white-space: pre-wrap; text-align: left; font-size: 0.75rem;">
        ${errorDetails}
      </p>
    </div>
  `;
}
```

## File Structure

```
cloudeventswebsite/
├── index.html              # Main portal HTML
├── index.js                # Legacy - not used in current version
├── staticwebapp.config.json # Azure Static Web App configuration
├── package.json            # Node.js dependencies (API functions)
├── api/                    # Azure Functions
│   ├── host.json          # Functions host configuration
│   ├── package.json       # API dependencies
│   ├── token/            # Token acquisition endpoint (deprecated)
│   │   ├── function.json
│   │   └── index.js
│   ├── config/           # Configuration info endpoint
│   │   ├── function.json
│   │   └── index.js
│   └── bc/               # Main BC proxy
│       ├── function.json
│       └── index.js      # Cloud Events two-step proxy
└── implementations/       # Feature specifications
    ├── requirement-0-bc-portal/  # This specification
    └── requirement-1-customer-creation/  # Customer creation feature
```

## Configuration Files

### staticwebapp.config.json
```json
{
  "routes": [
    {
      "route": "/api/*",
      "allowedRoles": ["anonymous"]
    }
  ],
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/api/*"]
  },
  "responseOverrides": {
    "404": {
      "rewrite": "/index.html"
    }
  },
  "platform": {
    "apiRuntime": "node:18"
  }
}
```

### api/host.json
```json
{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[3.*, 4.0.0)"
  }
}
```

### api/function.json (bc endpoint)
```json
{
  "bindings": [
    {
      "authLevel": "anonymous",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["get", "post"]
    },
    {
      "type": "http",
      "direction": "out",
      "name": "res"
    }
  ]
}
```

## Deployment

### Azure Static Web Apps

**Requirements:**
- Azure subscription
- GitHub repository (for CI/CD)
- Azure Static Web App resource

**Environment Variables (Portal Configuration):**
```bash
BC_TENANT_ID=<your-azure-ad-tenant-id>
BC_CLIENT_ID=<your-app-registration-client-id>
BC_CLIENT_SECRET=<your-app-registration-secret>
BC_ENVIRONMENT=UAT  # or Production, Sandbox, etc.
```

**Deployment Steps:**
1. Create Azure Static Web App resource
2. Connect to GitHub repository
3. Configure build settings:
   - App location: `/`
   - API location: `/api`
   - Output location: `` (empty - no build step)
4. Add environment variables in Azure Portal
5. Commit triggers automatic deployment

### API Permissions

**Azure AD App Registration:**
- API Permissions: `Dynamics 365 Business Central` > `API.ReadWrite.All`
- Grant admin consent
- Generate client secret

## Performance Optimizations

### 1. Token Caching
Server-side token caching reduces identity platform calls by ~99%.

### 2. Field Metadata Caching
Cache `Help.Fields.Get` results per company+language+table to avoid redundant API calls.

### 3. Specific Field Numbers
Always specify exact field numbers instead of retrieving all fields.

### 4. Pagination
Load customers in pages (12-24 per page) instead of all at once.

### 5. Parallel Loading
Use `Promise.all()` for independent operations:
```javascript
await Promise.all([
  loadLanguages(),
  loadAllLanguages(),
  loadUiTranslations()
]);
```

### 6. Dynamic Page Size
Adjust page size based on viewport for optimal performance and UX.

## Security Considerations

### 1. No Client-Side Secrets
- Tokens never sent to client
- API proxy handles all authentication
- Environment variables server-side only

### 2. HTTPS Only
- Azure Static Web Apps enforces HTTPS
- All API communication encrypted

### 3. CORS Configuration
- Managed by Azure Static Web Apps
- API only accessible from same origin

### 4. Input Validation
- Validate all user inputs before API calls
- Sanitize data for display
- Use parameterized Cloud Events messages

## Browser Support

**Minimum Requirements:**
- Modern browsers with ES6+ support
- CSS Grid support
- Fetch API support

**Tested Browsers:**
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Future Enhancements

### Planned Features
- [ ] Customer creation form (Requirement 1 - implemented)
- [ ] Sales order creation
- [ ] Purchase order management
- [ ] Item inventory lookups
- [ ] Real-time notifications
- [ ] Advanced filtering and search
- [ ] Export functionality (Excel, CSV)
- [ ] Audit trail viewer
- [ ] User preferences persistence
- [ ] Offline mode with sync

### Technical Improvements
- [ ] TypeScript migration
- [ ] React/Vue component framework
- [ ] State management (Redux/Pinia)
- [ ] Unit test coverage
- [ ] E2E testing (Playwright)
- [ ] Performance monitoring
- [ ] Analytics integration
- [ ] Progressive Web App capabilities

## Troubleshooting

### Common Issues

**1. "Server configuration missing" error**
- Verify environment variables set in Azure Portal
- Check variable names match exactly
- Restart Azure Function after changes

**2. Companies not loading**
- Verify BC_ENVIRONMENT matches your BC environment name
- Check app registration has API.ReadWrite.All permission
- Verify admin consent granted
- Check token endpoint returns valid token

**3. Translation not working**
- Verify Cloud Event Translation table exists in BC
- Check lcid value is correct Windows Language ID
- Ensure UI_STRINGS array is populated
- Check network tab for translation API calls

**4. Caching issues**
- Clear fieldMetaCache on language/company change
- Browser cache: Hard refresh (Ctrl+Shift+R)
- Server cache: Token cache expires automatically

**5. Image display issues**
- Verify image data is base64 encoded
- Check image MIME type (data:image/jpeg;base64,...)
- Ensure Image field (140) included in field numbers

## Testing Checklist

### Authentication
- [ ] Token acquired successfully
- [ ] Token cached and reused
- [ ] Token refreshes before expiry
- [ ] Error handling for auth failures

### Company Management
- [ ] Company list loads
- [ ] Companies displayed with proper info
- [ ] Company selection works
- [ ] Breadcrumb updates
- [ ] Context switches properly

### Language Support
- [ ] Language selector populates
- [ ] Language change updates UI
- [ ] Translations loaded from BC
- [ ] Placeholders created for missing translations
- [ ] Field captions update with language

### Customer Management
- [ ] Customer list loads with pagination
- [ ] Search filters correctly
- [ ] Images display properly
- [ ] Blocked status shows enum captions
- [ ] Pagination navigation works
- [ ] Customer detail view works

### Error Handling
- [ ] Network errors display properly
- [ ] BC task errors show details
- [ ] Toast notifications appear
- [ ] Empty states show correctly
- [ ] Loading indicators work

### Performance
- [ ] Initial load < 3 seconds
- [ ] Company switch < 2 seconds
- [ ] Customer list load < 2 seconds
- [ ] Language change < 1 second
- [ ] No memory leaks on navigation

## Conclusion

This Business Central Cloud Events Portal provides a solid foundation for building custom business applications with modern UX, robust authentication, multi-language support, and efficient API integration. The architecture supports extensibility through additional feature requirements while maintaining security, performance, and maintainability.
