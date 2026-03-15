# Requirement 3: Date Range Filter for Ledger Entries and Documents

## Overview

Add a date range filter bar to the **Ledger Entries** tab and the **Documents** tab in the customer detail view, matching the UX pattern already established by the Sales History tab. Users can narrow the records shown by specifying a From/To date range. The filter uses the `startDateTime` / `endDateTime` parameters of `Data.Records.Get` to offload filtering to BC.

**Current Status:** Ready for Implementation

**Key Features:**
- Date range filter bar (From / To date pickers + Refresh button) on both Ledger Entries and Documents tabs
- Default range: last 12 months (same default as Sales History)
- Validation: From required, To cannot be in the future, From cannot be after To
- Filter is applied server-side via `startDateTime` / `endDateTime` on `Data.Records.Get`
- Changing the date range and clicking Refresh reloads only the active tab's data
- Empty-state subtitle when no records exist in the selected period
- All new UI strings added to `UI_STRINGS` for translation
- Lazy loading preserved: Ledger Entries loads immediately on customer open; Documents loads immediately; filter state persists while the tab is open

---

## API Reference

### `Data.Records.Get` — Date Range Parameters

Both tabs use `Data.Records.Get`. The `startDateTime` / `endDateTime` parameters filter by `SystemModifiedAt` (≥ / ≤ respectively).

```json
{
  "specversion": "1.0",
  "type": "Data.Records.Get",
  "source": "BC Portal",
  "data": "{\"tableName\":\"Cust. Ledger Entry\",\"fieldNumbers\":[4,5,6,7,13,14,36],\"tableView\":\"WHERE(Customer No.=CONST(10000))\",\"startDateTime\":\"2025-03-15T00:00:00Z\",\"endDateTime\":\"2026-03-15T23:59:59Z\",\"skip\":0,\"take\":20}"
}
```

| Parameter | Type | Description |
|---|---|---|
| `startDateTime` | ISO 8601 UTC string | Filter by `SystemModifiedAt` ≥ this value |
| `endDateTime` | ISO 8601 UTC string | Filter by `SystemModifiedAt` ≤ this value |

Both parameters are **optional** and can be combined with `tableView`. When omitted, no date filter is applied.

#### Converting a date picker value to ISO 8601

Date inputs return `YYYY-MM-DD`. Convert to ISO 8601 UTC before sending:

```javascript
// From date: start of day UTC
const startDateTime = fromDate ? `${fromDate}T00:00:00Z` : null;

// To date: end of day UTC
const endDateTime = toDate ? `${toDate}T23:59:59Z` : null;
```

---

## Implementation

### Module-Level State

Add alongside the existing `salesHistoryData` / `salesHistorySortCol` variables:

```javascript
// Date filter state — persists while the customer detail view is open
let ledgerFromDate = null;   // YYYY-MM-DD string or null
let ledgerToDate   = null;   // YYYY-MM-DD string or null
let docsFromDate   = null;   // YYYY-MM-DD string or null
let docsToDate     = null;   // YYYY-MM-DD string or null
```

Initialise these to the default range (last 12 months) when a customer is selected, alongside the existing state resets in `showCustomerDetail()`:

```javascript
const defaultDates = shGetDefaultDates(); // reuse the existing helper
ledgerFromDate = defaultDates.from;
ledgerToDate   = defaultDates.to;
docsFromDate   = defaultDates.from;
docsToDate     = defaultDates.to;
```

---

### Shared Date Filter Helpers

Reuse the existing `shGetDefaultDates()` and `shValidateDates()` helpers already defined for Sales History — no new helpers are needed.

---

### Ledger Entries — Filter Bar

#### HTML structure rendered inside `ledger-content`

The filter bar is rendered at the top of the tab content as part of `loadLedger()`, matching the Sales History pattern:

```javascript
const filterBar = `<div class="sales-history-filters">
  <div class="date-filter-group">
    <span class="date-filter-label">${t('From')}</span>
    <input class="date-filter-input" type="date" id="ledger-from-date" value="${ledgerFromDate || ''}">
  </div>
  <div class="date-filter-group">
    <span class="date-filter-label">${t('To')}</span>
    <input class="date-filter-input" type="date" id="ledger-to-date" value="${ledgerToDate || ''}">
  </div>
  <button class="btn-refresh" onclick="ledgerRefresh()">${t('Refresh')}</button>
</div>`;
```

#### `ledgerRefresh()` — validate and reload

```javascript
function ledgerRefresh() {
  const fromDate = document.getElementById('ledger-from-date')?.value || null;
  const toDate   = document.getElementById('ledger-to-date')?.value   || null;
  const v = shValidateDates(fromDate, toDate);
  if (!v.valid) { toast(v.error, 'error'); return; }
  ledgerFromDate = fromDate;
  ledgerToDate   = toDate;
  loadLedger(0);
}
```

#### Updated `loadLedger(skip)` with date parameters

```javascript
async function loadLedger(skip = 0) {
  const take = pageSize();
  const el = document.getElementById('ledger-content');
  el.innerHTML = `<div class="loader-wrap"><div class="spinner"></div>
    <span class="loader-label">${t('Loading ledger entries...')}</span></div>`;
  try {
    const startDateTime = ledgerFromDate ? `${ledgerFromDate}T00:00:00Z` : null;
    const endDateTime   = ledgerToDate   ? `${ledgerToDate}T23:59:59Z`   : null;

    const dataPayload = {
      tableName: 'Cust. Ledger Entry',
      fieldNumbers: [4, 5, 6, 7, 13, 14, 36],
      tableView: `WHERE(Customer No.=CONST(${selectedCustomer.number}))`,
      skip,
      take
    };
    if (startDateTime) dataPayload.startDateTime = startDateTime;
    if (endDateTime)   dataPayload.endDateTime   = endDateTime;

    const [res, meta] = await Promise.all([
      cePost(selectedCompany.id, {
        specversion: '1.0', type: 'Data.Records.Get', source: 'BC Portal',
        data: JSON.stringify(dataPayload)
      }),
      getFieldMeta('Cust. Ledger Entry', [1, 4, 5, 6, 7, 13, 14, 36])
    ]);

    const filterBar = buildLedgerFilterBar();
    const cap = {};
    meta.forEach(f => { cap[f.id] = f.caption; });
    const rows = res.result || [];
    const total = res.noOfRecords || 0;

    if (!rows.length) {
      el.innerHTML = filterBar +
        `<div class="empty-state"><div class="empty-icon">📒</div>
          <p>${t('No ledger entries')}</p>
          <p class="empty-sub">${t('No ledger entries in the selected period.')}</p>
        </div>`;
      return;
    }

    rows.sort((a, b) =>
      parseInt((b.primaryKey || {}).EntryNo_ || 0) -
      parseInt((a.primaryKey || {}).EntryNo_ || 0)
    );

    el.innerHTML = filterBar + `<div class="table-wrap"><table>
      <thead><tr>
        <th>${cap[1]  || t('Entry No.')}</th>
        <th>${cap[4]  || t('Date')}</th>
        <th>${cap[5]  || t('Doc Type')}</th>
        <th>${cap[6]  || t('Doc No.')}</th>
        <th>${cap[7]  || t('Description')}</th>
        <th class="num">${cap[13] || t('Amount')}</th>
        <th class="num">${cap[14] || t('Remaining')}</th>
        <th>${cap[36] || t('Status')}</th>
      </tr></thead>
      <tbody>${rows.map(rec => {
        const f  = rec.fields      || {};
        const pk = rec.primaryKey  || {};
        return `<tr>
          <td>${pk.EntryNo_ || '—'}</td>
          <td>${fmtDate(f.PostingDate)}</td>
          <td>${f.DocumentType  || '—'}</td>
          <td><strong>${f.DocumentNo_ || '—'}</strong></td>
          <td>${f.Description   || '—'}</td>
          <td class="${parseFloat(f.Amount || 0) >= 0 ? 'amount-pos' : 'amount-neg'}">${fmt(f.Amount)}</td>
          <td class="num">${fmt(f.RemainingAmount)}</td>
          <td>${f.Open
            ? `<span class="chip open">● ${t('Open')}</span>`
            : `<span class="chip closed">✓ ${t('Closed')}</span>`}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
    paginate('ledger-pagination', total, skip, take, 'loadLedger');
  } catch (e) {
    const filterBar = buildLedgerFilterBar();
    const errorDetails = e.stack || e.message;
    el.innerHTML = filterBar +
      `<div class="empty-state"><div class="empty-icon">⚠</div>
        <p style="white-space:pre-wrap;text-align:left;font-size:0.75rem">${errorDetails}</p>
      </div>`;
    toast(errorDetails, 'error');
  }
}

function buildLedgerFilterBar() {
  return `<div class="sales-history-filters">
    <div class="date-filter-group">
      <span class="date-filter-label">${t('From')}</span>
      <input class="date-filter-input" type="date" id="ledger-from-date" value="${ledgerFromDate || ''}">
    </div>
    <div class="date-filter-group">
      <span class="date-filter-label">${t('To')}</span>
      <input class="date-filter-input" type="date" id="ledger-to-date" value="${ledgerToDate || ''}">
    </div>
    <button class="btn-refresh" onclick="ledgerRefresh()">${t('Refresh')}</button>
  </div>`;
}
```

---

### Documents — Filter Bar

Documents fetches three tables in parallel (`Sales Header`, `Sales Invoice Header`, `Sales Cr.Memo Header`). The date filter is passed to all three requests.

#### `docsRefresh()` — validate and reload

```javascript
function docsRefresh() {
  const fromDate = document.getElementById('docs-from-date')?.value || null;
  const toDate   = document.getElementById('docs-to-date')?.value   || null;
  const v = shValidateDates(fromDate, toDate);
  if (!v.valid) { toast(v.error, 'error'); return; }
  docsFromDate = fromDate;
  docsToDate   = toDate;
  loadDocuments();
}
```

#### Updated `loadDocuments()` with date parameters

```javascript
async function loadDocuments() {
  const take = pageSize();
  const el = document.getElementById('documents-content');
  el.innerHTML = `<div class="loader-wrap"><div class="spinner"></div>
    <span class="loader-label">${t('Loading documents...')}</span></div>`;
  try {
    const startDateTime = docsFromDate ? `${docsFromDate}T00:00:00Z` : null;
    const endDateTime   = docsToDate   ? `${docsToDate}T23:59:59Z`   : null;

    const addDates = (payload) => {
      if (startDateTime) payload.startDateTime = startDateTime;
      if (endDateTime)   payload.endDateTime   = endDateTime;
      return payload;
    };

    const [ordRes, invRes, crmRes, metaOrd, metaInv] = await Promise.all([
      cePost(selectedCompany.id, {
        specversion: '1.0', type: 'Data.Records.Get', source: 'BC Portal',
        data: JSON.stringify(addDates({
          tableName: 'Sales Header',
          fieldNumbers: [19, 20, 61, 120, 5790],
          tableView: `WHERE(Document Type=CONST(Order),Sell-to Customer No.=CONST(${selectedCustomer.number}))`,
          skip: 0, take
        }))
      }).catch(() => ({ result: [] })),
      cePost(selectedCompany.id, {
        specversion: '1.0', type: 'Data.Records.Get', source: 'BC Portal',
        data: JSON.stringify(addDates({
          tableName: 'Sales Invoice Header',
          fieldNumbers: [20, 24, 61],
          tableView: `WHERE(Sell-to Customer No.=CONST(${selectedCustomer.number}))`,
          skip: 0, take
        }))
      }).catch(() => ({ result: [] })),
      cePost(selectedCompany.id, {
        specversion: '1.0', type: 'Data.Records.Get', source: 'BC Portal',
        data: JSON.stringify(addDates({
          tableName: 'Sales Cr.Memo Header',
          fieldNumbers: [20, 24, 61],
          tableView: `WHERE(Sell-to Customer No.=CONST(${selectedCustomer.number}))`,
          skip: 0, take
        }))
      }).catch(() => ({ result: [] })),
      getFieldMeta('Sales Header', [19, 20, 61, 120, 5790]),
      getFieldMeta('Sales Invoice Header', [20, 24, 61])
    ]);

    const filterBar = buildDocsFilterBar();
    // ... rest of existing rendering logic unchanged ...
  } catch (e) {
    const filterBar = buildDocsFilterBar();
    const errorDetails = e.stack || e.message;
    el.innerHTML = filterBar +
      `<div class="empty-state"><div class="empty-icon">⚠</div>
        <p style="white-space:pre-wrap;text-align:left;font-size:0.75rem">${errorDetails}</p>
      </div>`;
    toast(errorDetails, 'error');
  }
}

function buildDocsFilterBar() {
  return `<div class="sales-history-filters">
    <div class="date-filter-group">
      <span class="date-filter-label">${t('From')}</span>
      <input class="date-filter-input" type="date" id="docs-from-date" value="${docsFromDate || ''}">
    </div>
    <div class="date-filter-group">
      <span class="date-filter-label">${t('To')}</span>
      <input class="date-filter-input" type="date" id="docs-to-date" value="${docsToDate || ''}">
    </div>
    <button class="btn-refresh" onclick="docsRefresh()">${t('Refresh')}</button>
  </div>`;
}
```

---

### UI Strings to Add

Add these entries to the `UI_STRINGS` array in `index.html`:

```javascript
'No ledger entries in the selected period.',
'No documents in the selected period.',
```

The strings `'From'`, `'To'`, and `'Refresh'` are already in `UI_STRINGS` (added for Sales History).

---

### State Reset on Customer Change

In `showCustomerDetail()` (or wherever customer state is reset), initialise the date state:

```javascript
const defaultDates = shGetDefaultDates();
ledgerFromDate = defaultDates.from;
ledgerToDate   = defaultDates.to;
docsFromDate   = defaultDates.from;
docsToDate     = defaultDates.to;
```

---

## CSS

No new CSS is required. The filter bar reuses:
- `.sales-history-filters` — flex row container
- `.date-filter-group` — label + input pair
- `.date-filter-label` — dim uppercase label
- `.date-filter-input` — date picker input
- `.btn-refresh` — refresh button
- `.empty-sub` — muted subtitle under empty-state message

All of these are already defined for the Sales History tab.

---

## Acceptance Criteria

- [ ] Ledger Entries tab shows a From/To date filter bar above the table
- [ ] Documents tab shows a From/To date filter bar above the table
- [ ] Default range is last 12 months on customer open
- [ ] Clicking Refresh with a valid range reloads only that tab's data
- [ ] `startDateTime` / `endDateTime` are included in the `Data.Records.Get` payload when a date is set
- [ ] Validation: From is required for Refresh, To cannot be in the future, From cannot be after To
- [ ] Empty state shows a translated subtitle when no records match the period
- [ ] Filter bar remains visible in the empty state and error state
- [ ] Date filter state persists when switching away from and back to the tab
- [ ] Date state resets to last 12 months when a different customer is opened
- [ ] New UI strings are added to the translation system
- [ ] No regression on existing Ledger Entries or Documents behaviour
