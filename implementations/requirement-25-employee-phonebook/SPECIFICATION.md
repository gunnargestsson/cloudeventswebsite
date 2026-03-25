# Requirement 25: Employee Phonebook

## Status: Specification

---

## Overview

A standalone page (`employee-phonebook.html`) at the same level as `bc-portal.html`,
`bc-open-mirror.html`, and other sub-pages. It reuses the same connection and language
infrastructure (`settings.js` / landing-page flow) as all other pages.

**Goal:** Provide a searchable employee directory sourced from the BC **Employee** table
(table 5200). Users can toggle between a **tile view** (card grid with photo, name,
phone, email) and a **list view** (compact table rows). The page is accessible from the
start page (`index.html`) via a new navigation card.

### Key Features

- ✅ Fetches employee records from BC Employee table (5200) via Cloud Events `Data.Records.Get`
- ✅ Displays employee photo (Media field), full name, job title, mobile phone, email, and department (Global Dimension 1)
- ✅ Two view modes: **tiles** (card grid) and **list** (table rows) — user toggle persisted in `localStorage`
- ✅ Real-time client-side search filtering across name, phone, email, job title, and department
- ✅ Pagination for large employee directories
- ✅ Full translation support via `UI_STRINGS` / `t()` pattern
- ✅ Linked from the start page as a navigation card
- ✅ Same dark theme, header, and status pill pattern as all other pages

---

## Design Decisions

| # | Decision | Answer |
|---|----------|--------|
| D1 | BC connection source | Same `settings.js` / landing-page flow as the other pages |
| D2 | Language selector | Same shared language setup as other pages |
| D3 | BC source table | **Employee** (table 5200) |
| D4 | Fields to fetch | No. (1), First Name (2), Middle Name (3), Last Name (4), Job Title (5920), Phone No. (6), Mobile Phone No. (7), Company E-Mail (65), E-Mail (18), Global Dimension 1 Code (10), Image (19) |
| D5 | Display name | Composed from `First Name` + `Middle Name` + `Last Name` |
| D6 | Contact fields shown | Mobile Phone No. (primary), Phone No. (secondary), E-Mail or Company E-Mail (whichever is non-empty, Company E-Mail preferred) |
| D7 | Department source | Global Dimension 1 Code (field 10) — resolved to display name via a separate `Data.Records.Get` on the **Dimension Value** table (349), filtered by `WHERE(Global Dimension No.=CONST(1))`, loading Code (1) and Name (2). Cached as a `dimensionValueMap` lookup (`code → name`). |
| D8 | Default view mode | Tiles (card grid) |
| D9 | View mode persistence | `localStorage` key `bc_portal_employee_view` (`'tiles'` or `'list'`) |
| D10 | Search scope | Client-side filter on all loaded records; searches across name, phone, email, job title, department |
| D11 | Pagination | Same skip/take pattern as other pages; default `take: 50` |
| D12 | Employee photo | Media field (field 19 "Image"); displayed as circular avatar in tiles, small thumbnail in list |
| D13 | Photo fallback | Generic person silhouette SVG placeholder when no image is available |
| D14 | Sorting | Server-side `SORTING(First Name,Last Name,Middle Name) ORDER(Ascending)` |
| D15 | Filter — active only | Only show employees with `Status = Active` — `WHERE(Status=CONST(Active))` |
| D16 | Page URL route | `/employee-phonebook` → `/employee-phonebook.html` in `staticwebapp.config.json` |
| D17 | Navigation card | Added to `index.html` nav-cards grid with 📞 icon |

---

## BC Employee Table — Field Reference (Table 5200)

| Field No. | BC Field Name | jsonName | Type | Purpose |
|-----------|---------------|----------|------|---------|
| 1 | No. | No_ | Code[20] | Employee number (PK) |
| 2 | First Name | FirstName | Text[30] | First name |
| 3 | Middle Name | MiddleName | Text[30] | Middle name |
| 4 | Last Name | LastName | Text[30] | Last name |
| 5920 | Job Title | JobTitle | Text[30] | Job title / position |
| 6 | Phone No. | PhoneNo_ | Text[30] | Landline phone |
| 7 | Mobile Phone No. | MobilePhoneNo_ | Text[30] | Mobile phone |
| 18 | E-Mail | EMail | Text[80] | Personal email |
| 65 | Company E-Mail | CompanyEMail | Text[80] | Company email |
| 10 | Global Dimension 1 Code | GlobalDimension1Code | Code[20] | Department / division |
| 19 | Image | Image | Media | Employee photo |
| 1100 | Status | Status | Option | Active / Inactive / Terminated |

> **Note:** Field numbers and jsonNames above follow standard BC 24+ schema.
> Always verify against the live instance using `Help.Fields.Get` with `tableName: "Employee"` on first load and cache the metadata.

### Dimension Value Table — Department Lookup (Table 349)

To display the department **name** (not just the code), fetch Dimension Values filtered to Global Dimension 1:

| Field No. | BC Field Name | jsonName | Type | Purpose |
|-----------|---------------|----------|------|---------|
| 1 | Dimension Code | DimensionCode | Code[20] | PK — Dimension code |
| 2 | Code | Code | Code[20] | PK — Dimension value code (matches Employee.Global Dimension 1 Code) |
| 3 | Name | Name | Text[50] | Display name for the dimension value |
| 10 | Global Dimension No. | GlobalDimensionNo_ | Integer | 1 = Global Dimension 1 |

```javascript
const DIMENSION_VALUE_FIELDS = [1, 2, 3, 10];
// tableView: 'WHERE(Global Dimension No.=CONST(1))'
```

The result is cached as a map: `{ [code]: name }`. When rendering employee department,
look up `dimensionValueMap[employee.department]` to show the full name (e.g. "Framleiðslusvið")
instead of the raw code (e.g. "FRAML").

---

## Field Number Constants

```javascript
const EMPLOYEE_LIST_FIELDS = [2, 3, 4, 5920, 6, 7, 18, 65, 10, 19, 1100];
// Field 2    = First Name
// Field 3    = Middle Name
// Field 4    = Last Name
// Field 5920 = Job Title
// Field 6    = Phone No.
// Field 7    = Mobile Phone No.
// Field 18   = E-Mail
// Field 65   = Company E-Mail
// Field 10   = Global Dimension 1 Code
// Field 19   = Image (Media)
// Field 1100 = Status (Option — filter Active only)
```

---

## Cloud Events API Integration

### Loading Employees

```javascript
async function loadEmployees(skip = 0, take = 50) {
  const headers = bcSettingsHeaders();
  const settings = bcSettingsLoad();
  
  const res = await fetch('/api/bc?companyId=' + settings.companyId, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      specversion: '1.0',
      type: 'Data.Records.Get',
      source: 'BC Portal',
      subject: 'Employee',
      lcid: parseInt(settings.lcid || '1033', 10),
      data: JSON.stringify({
        tableName: 'Employee',
        fieldNumbers: EMPLOYEE_LIST_FIELDS,
        tableView: 'SORTING(First Name,Last Name,Middle Name) ORDER(Ascending) WHERE(Status=CONST(Active))',
        skip,
        take
      })
    })
  });
  
  return await res.json();
}
```

### Loading Department Names (Dimension Values)

```javascript
let dimensionValueMap = {};

async function loadDimensionValues() {
  const headers = bcSettingsHeaders();
  const settings = bcSettingsLoad();
  
  const res = await fetch('/api/bc?companyId=' + settings.companyId, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      specversion: '1.0',
      type: 'Data.Records.Get',
      source: 'BC Portal',
      subject: 'Dimension Value',
      lcid: parseInt(settings.lcid || '1033', 10),
      data: JSON.stringify({
        tableName: 'Dimension Value',
        fieldNumbers: [1, 2, 3, 10],
        tableView: 'WHERE(Global Dimension No.=CONST(1))',
        take: 500
      })
    })
  });
  
  const data = await res.json();
  dimensionValueMap = {};
  for (const rec of (data.result || [])) {
    const code = rec.fields.Code || rec.primaryKey.Code || '';
    const name = rec.fields.Name || '';
    if (code) dimensionValueMap[code] = name;
  }
}
```

### Data Mapper

```javascript
function mapEmployee(rec) {
  const f = rec.fields;
  const firstName = f.FirstName || '';
  const middleName = f.MiddleName || '';
  const lastName = f.LastName || '';
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
  
  // Prefer Company E-Mail, fall back to personal E-Mail
  const email = f.CompanyEMail || f.EMail || '';
  
  // Employee photo — Media field returns { Id, Value }
  let photoUrl = null;
  if (f.Image && f.Image.Value) {
    photoUrl = `data:image/jpeg;base64,${f.Image.Value}`;
  }
  
  return {
    id: rec.id,
    number: rec.primaryKey.No_,
    fullName,
    firstName, lastName,
    jobTitle: f.JobTitle || '',
    phone: f.PhoneNo_ || '',
    mobile: f.MobilePhoneNo_ || '',
    email,
    departmentCode: f.GlobalDimension1Code || '',
    department: dimensionValueMap[f.GlobalDimension1Code] || f.GlobalDimension1Code || '',
    photoUrl,
    status: f.Status || ''
  };
}
```

---

## UI Layout

### Header

Same pattern as other sub-pages:
- Origo logo (left)
- Header pills (right): Home link, Status pill with connection dot, API Key link
- Below header: page title "Employee Phonebook" + view toggle buttons (tiles | list) + search input

### View Toggle

Two icon buttons next to the search bar:
- **Grid icon** (⊞) — tiles view (default)
- **List icon** (☰) — list view

Selected state indicated by `var(--accent)` border highlight. Persisted in `localStorage`.

### Tiles View (Default)

Grid layout using `display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));`

Each tile:
```
┌─────────────────────────────────┐
│  ┌──────┐                       │
│  │ Photo│  Full Name            │
│  │(circ)│  Job Title            │
│  └──────┘                       │
│                                 │
│  📱  +354 862-0158              │
│  ✉️   adamthor@internet.is      │
│  🏢  Framleiðslusvið            │
└─────────────────────────────────┘
```

- Photo: 64×64px circular, centered vertically alongside name/title
- Name: bold, `font-family: 'Syne'`, `font-weight: 700`
- Job title: smaller, `color: var(--text-mid)`
- Contact lines: icon + value, `font-size: 0.78rem`
- Department shown as a subtle tag/badge at the bottom
- Phone number is a clickable `tel:` link; email is a clickable `mailto:` link

### List View

A compact table with columns:

| Photo | Name | Job Title | Mobile | Email | Department |
|-------|------|-----------|--------|-------|------------|
| 32×32 thumb | Full name | Job Title | Clickable tel: link | Clickable mailto: link | Dim 1 Code |

- Sortable column headers (client-side, all records loaded)
- Hover row highlight with `var(--surface2)` background
- Photo: 32×32 circular thumbnail

### Search Bar

- Positioned above the employee grid/table, full width with search icon overlay
- `oninput` triggers client-side filter
- Searches across: `fullName`, `jobTitle`, `mobile`, `phone`, `email`, `department`
- Case-insensitive substring match
- Debounced (150ms) to avoid excessive re-renders

### Pagination

Same pattern as BC Portal:
- Page indicators: "Page N of M"
- Previous / Next buttons
- Hidden when total records fit in one page

### Empty State

When no employees match the search filter:
```
No employees found
```

When the table has no records at all:
```
No employee records available
```

---

## Translation Strings (UI_STRINGS)

```javascript
const UI_STRINGS = [
  'Home',
  'API Key',
  'Connected',
  'Not connected',
  'Employee Phonebook',
  'Search employees...',
  'Name',
  'Job Title',
  'Mobile',
  'Phone',
  'Email',
  'Department',
  'No employees found',
  'No employee records available',
  'Page',
  'of',
  'Previous',
  'Next',
  'Tiles',
  'List',
  'Loading...',
  'Employee directory from Business Central'
];
```

These will be registered with `bcLoadTranslations()` for automatic Icelandic (1039)
translation support. Missing translations auto-create placeholder records in BC.

---

## Navigation Card on Start Page

Add to `index.html` nav-cards section:

```html
<a href="employee-phonebook.html" class="nav-card">
  <div class="nav-card-icon">📞</div>
  <div class="nav-card-title" id="nav-phonebook-title">Employee Phonebook</div>
  <div class="nav-card-desc" id="nav-phonebook-desc">Employee directory from Business Central</div>
</a>
```

Add to `index.html` UI_STRINGS and `applyUiTranslations()`:
```javascript
UI_STRINGS.push('Employee Phonebook', 'Employee directory from Business Central');

// in applyUiTranslations():
const phonebookTitle = document.getElementById('nav-phonebook-title');
const phonebookDesc = document.getElementById('nav-phonebook-desc');
if (phonebookTitle) phonebookTitle.textContent = t('Employee Phonebook');
if (phonebookDesc) phonebookDesc.textContent = t('Employee directory from Business Central');
```

---

## Static Web App Route

Add to `staticwebapp.config.json`:

```json
{
  "route": "/employee-phonebook",
  "rewrite": "/employee-phonebook.html"
}
```

---

## CSS Design Notes

- Same dark theme CSS variables as all other pages (`:root` block with `--bg`, `--surface`, etc.)
- Same Google Fonts: `Syne` (headings) + `DM Mono` (body)
- Tile cards: same `var(--surface)` background, `var(--border)` border, `var(--radius)` corners
- Tile hover: `border-color: var(--accent); transform: translateY(-2px);` — same as nav-cards
- Circular photos: `border-radius: 50%; object-fit: cover;`
- View toggle buttons: pill-shaped, `var(--surface)` default, `var(--accent)` border when active
- Search input: same `.search-wrap` pattern as BC Portal customer search
- Responsive: grid auto-fills tiles; list view scrolls horizontally on small screens

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No BC connection (settings missing) | Redirect to `index.html` |
| Cloud Events API error | Toast with error message (same pattern as other pages) |
| Employee table read permission denied | Toast: "You do not have permission to view employee records" |
| Image field returns null/empty | Show placeholder SVG avatar |
| Search returns no results | Show "No employees found" message |

---

## Implementation Checklist

- [ ] Create `employee-phonebook.html` with header, search, view toggle, tiles/list views, pagination
- [ ] Fetch employees from BC via `Data.Records.Get` on Employee table (5200)
- [ ] Implement `mapEmployee()` data mapper
- [ ] Implement tiles view (card grid with photos)
- [ ] Implement list view (table rows with thumbnails)
- [ ] Implement client-side search with debounce
- [ ] Implement pagination (skip/take)
- [ ] Implement view toggle with `localStorage` persistence
- [ ] Add `UI_STRINGS` and `loadUiTranslations()` / `applyUiTranslations()`
- [ ] Add navigation card to `index.html`
- [ ] Add route to `staticwebapp.config.json`
- [ ] Register Icelandic translations via MCP `set_translations` tool
- [ ] Test with live BC data
