# Requirement 5: BC Metadata Explorer

## Overview
A developer tool for browsing the complete table and field catalogue of a Business Central company via the Cloud Events API. Shows field names (AL), JSON keys, captions (in the selected language), types, lengths, class (Normal / FlowField), primary key membership, and enumeration values with captions. Includes table-level read/write permission checking and bulk export to YAML / JSON / CSV / Markdown.

**Key Features:**
- ✅ **Full Table Catalogue**: All BC tables loaded via `Help.Tables.Get`, sortable and searchable; each entry includes `dataPerCompany` indicating whether data is stored per-company or shared globally across the environment
- ✅ **Field Detail View**: All fields per table via `Help.Fields.Get` — name, JSON key, caption, type, length, class, PK membership, enum values, enum captions
- ✅ **Read/Write Permission Check**: `Help.Permissions.Get` called in parallel with `Help.Fields.Get`; badges displayed in stats bar and table subtitle
- ✅ **Dynamic Language Selection**: Available languages loaded from BC `Allowed Language` → `Language` tables; LCID selector updates captions on change
- ✅ **Field Search & Filter**: Client-side filter on table name and table number
- ✅ **Bulk Export**: Download field definitions for selected table or all tables in YAML, JSON, CSV, or Markdown
- ✅ **Results Caching**: Fields and permissions cached per table name; invalidated on company/language change
- ✅ **Stats Bar**: Field count, PK field count, FlowField count, primary key field names, read/write status

## Architecture

### Deployment Model
- **Hosting**: Azure Static Web Apps
- **File**: `bc-metadata-explorer.html`
- **API Proxy**: `api/explorer/index.js` (shared with CE Explorer)
- **Route**: `/bc-metadata-explorer` → `bc-metadata-explorer.html` (via `staticwebapp.config.json`)

### Technology Stack
- **Frontend**: Vanilla JavaScript, HTML5, CSS3 (dark theme, JetBrains Mono + Syne fonts)
- **Backend**: Azure Functions (Node.js) — `api/explorer/index.js`
- **Authentication**: OAuth 2.0 client credentials — same header pattern as CE Explorer

## Connection Configuration

Five connection fields in the sidebar config area, identical to CE Explorer:

| Header | Field |
|---|---|
| `x-bc-tenant` | Azure AD Tenant ID |
| `x-bc-environment` | BC Environment name |
| `x-bc-company` | Company ID (GUID) |
| `x-bc-client-id` | App Registration Client ID |
| `x-bc-client-secret` | App Registration Client Secret |

Below the connection fields, a **Language** `<select>` dropdown (`id="cfgLcid"`) allows switching the UI/caption language. Pressing **Load Tables** triggers both the table list and the language list load.

## Layout

Two-column layout (`280px | flex`):

```
┌─────────────────────────────────────────────────────┐
│  Header: Logo · Title · Status indicator · Nav      │
├──────────────┬──────────────────────────────────────┤
│  Sidebar     │  Main Panel                          │
│  (280px)     │  (flex)                              │
│              │                                      │
│  Connection  │  Table title + subtitle              │
│  fields      │  Stats bar (field counts + perms)   │
│              │  Action buttons (filter / download) │
│  Language    │                                      │
│  selector    │  Field sections:                    │
│              │  · Primary Key Fields [table]        │
│  Load Tables │  · Fields [table]                   │
│  button      │  · FlowFields [table]                │
│              │                                      │
│  Search box  │                                      │
│  Table list  │                                      │
│  (all BC     │                                      │
│   tables)    │                                      │
└──────────────┴──────────────────────────────────────┘
```

### Sidebar `.sb-cfg` overflow fix
`.sb-cfg` has `flex-shrink:0; overflow-y:auto; max-height:60vh` to ensure the language selector remains visible on short viewports.

## API Message Types Used

| Message Type | Purpose |
|---|---|
| `Help.Tables.Get` | Load all tables; response includes `id`, `name`, `caption`, `dataPerCompany` per table |
| `Help.Fields.Get` | Load field metadata for a specific table |
| `Help.Permissions.Get` | Check read/write permissions for a table (subject = table name) |
| `Data.Records.Get` on `Allowed Language` | Get LCIDs available in this BC company |
| `Data.Records.Get` on `Language` | Get display names for those LCIDs |

## Language Loading

Dynamic language loading happens after `loadTables()` succeeds:

**Step 1** — `Data.Records.Get` on `Allowed Language` (no data/filter):
```json
{ "specversion": "1.0", "type": "Data.Records.Get", "source": "Metadata-Explorer v1.0", "subject": "Allowed Language" }
```
→ Returns records with `primaryKey.LanguageId` — extract numeric LCID values.

**Step 2** — `Data.Records.Get` on `Language` filtered by those LCIDs:
```json
{
  "specversion": "1.0", "type": "Data.Records.Get", "source": "Metadata-Explorer v1.0",
  "data": "{\"tableName\":\"Language\",\"tableView\":\"WHERE(Windows Language ID=FILTER(1033|1039|1030))\"}"
}
```
→ Returns records with `fields.WindowsLanguageID` and `fields.Name` — rebuild the `<select>` options.

**Fallback**: If either step fails, the static `LCID_NAMES` map is used (9 languages: English, Icelandic, Danish, German, French, Spanish, Dutch, Swedish, Norwegian).

**On language change** (`onLangChange()`):
- `fieldsCache` is cleared (captions differ by language)
- `permissionsCache` is cleared
- `loadTables()` is re-called (refetches table captions in new language)

## Permission Check Pattern

`Help.Permissions.Get` is called in parallel with `Help.Fields.Get` using `Promise.all`:

```javascript
const [fieldsRes, permRes] = await Promise.all([
  cePost({ specversion:'1.0', type:'Help.Fields.Get', subject: tableName, ... }),
  cePost({ specversion:'1.0', type:'Help.Permissions.Get', subject: tableName }),
]);
```

**Response normalization** — the API returns `{ status: 'Success', permissions: { read: true, write: false } }`, not the flat `{ readPermission, writePermission }` shape. The client normalizes at store time:

```javascript
const p = permRes.permissions || permRes;
currentPermissions = {
  readPermission:  !!(p.read  ?? p.readPermission),
  writePermission: !!(p.write ?? p.writePermission),
};
```

## Fields Table Structure

For each table, fields are grouped into three sections rendered sequentially:
1. **Primary Key Fields** — `isPartOfPrimaryKey === true`
2. **Fields** — `class !== 'FlowField'` and not part of PK
3. **FlowFields** — `class === 'FlowField'`

Each table section renders a `<table class="ftable">` with columns:

| Column | Content |
|---|---|
| `#` | Field ID number |
| Name (AL) | AL field name |
| JSON Key | `jsonName` (or `name` if same) |
| Caption | Localized caption — shown only when different from `name` |
| Type | BC field type (Text, Code, Integer, etc.) |
| Len | `len` for Text/Code fields |
| Class | `Normal` or `FlowField` badge |
| PK | Dot indicator if `isPartOfPrimaryKey` |
| Enum values | Tags for each enum option value |
| Enum captions | Tags for each enum option caption (separate column, `.enum-caption-tag` style) |

## Stats Bar

Displayed above the field table after a table is selected. Shows:
- Total field count
- PK field count
- FlowField count
- Normal field count
- Primary key field names (joined)
- **Read** badge: ✓ (green) or ✗ (red)
- **Write** badge: ✓ (green) or ✗ (red)
- **Data** badge: `Per Company` (green pill) or `Global` (grey pill) — from `currentTable.dataPerCompany`

Permission badges and the Data badge also appear inline in the table subtitle below the table name.

## Caching Strategy

```javascript
let fieldsCache = {};      // tableName → fields[]   — cleared on language change or Load Tables
let permissionsCache = {}; // tableName → { readPermission, writePermission }
```

Both caches are checked before making API calls in `selectTable()`. Both are cleared together since permissions may change between loads.

## Bulk Export

A **Download** modal allows exporting field definitions:

**Scope options**:
- Current table only
- All tables (fetches missing tables on demand, shows progress)

**Format options**:
- YAML (`.yaml`) — human-readable nested structure
- JSON (`.json`) — machine-readable
- CSV (`.csv`) — spreadsheet-compatible
- Markdown (`.md`) — documentation tables

Export builds a map of `{ tableName → fields[] }`, iterates through all tables fetching any not yet in `fieldsCache`, then serializes to the chosen format and triggers a browser download.

## Key JavaScript Functions

| Function | Description |
|---|---|
| `loadTables()` | Calls `Help.Tables.Get`, populates `allTables` (each entry retains `dataPerCompany`), then calls `loadLanguages()` |
| `loadLanguages()` | Two-step BC query to populate language `<select>` dynamically |
| `getLcid()` | Reads current value of `#cfgLcid` select |
| `onLangChange()` | Clears caches, re-runs `loadTables()` on language switch |
| `filterTables(q)` | Client-side search by name or table number |
| `renderTableList()` | Renders sidebar list; each item shows name, `#id`, and a `Per Co.`/`Global` pill from `dataPerCompany` |
| `selectTable(tableId)` | Parallel fetch of fields + permissions; updates main panel |
| `renderFields()` | Splits fields into PK / Normal / FlowField sections, renders stats bar including Data badge |
| `fieldsTable(fields)` | Renders HTML table with 10 columns |
| `openDownloadModal(scope)` | Opens export scope/format selection modal |
| `startDownload()` | Fetches all missing field data, serializes, triggers download |
| `cePost(envelope)` | Proxy call to `/api/explorer` with auth headers |

## Testing Checklist

- [ ] Connect with valid credentials → table list loads, status turns green
- [ ] Language selector populated from BC `Allowed Language` table
- [ ] Switching language clears cache and reloads tables with new captions
- [ ] Sidebar list items show `Per Co.` (green) or `Global` (grey) pill correctly
- [ ] Selecting a table → fields shown in three sections (PK / Normal / FlowField)
- [ ] Stats bar and subtitle show Data badge (`Per Company` or `Global`)
- [ ] Permissions bar shows ✓/✗ Read and Write badges correctly
- [ ] Caption column show localized caption when it differs from AL name
- [ ] Enum columns show value tags and caption tags separately
- [ ] Table search filters by name and by number
- [ ] Download current table → YAML/JSON/CSV/MD file downloaded
- [ ] Download all tables → progress shown, all tables collected, file downloaded
- [ ] Language select visible on short viewport (no overflow clipping)
- [ ] Caching: selecting same table twice does not make a second API call
