# Requirement 2: Sales History Tab - Implementation Specification

## Overview
Add a "Sales History" tab to the customer detail view that displays item-level sales history for the selected customer. This tab shows which items have been sold to the customer, aggregated by item with total quantities and order counts. The tab will appear between "Ledger Entries" and "Documents" in the customer detail view.

**Current Status:** Ready for Implementation

**Key Features:**
- ✅ Display sales history by item for selected customer
- ✅ Tab positioned between "Ledger Entries" and "Documents"
- ✅ Lazy loading - content loads only when tab is clicked
- ✅ Date range filter (from/to dates)
- ✅ Localized UI strings and field captions
- ✅ Shows aggregated quantities and order counts per item

## API Reference
This implementation follows the **Business Central Cloud Events API** specification.

**Primary API Message Type:**
- `Customer.SalesHistory.Get` - Retrieve aggregated sales history by item for a specific customer

**Request Format:**
```json
{
  "specversion": "1.0",
  "type": "Customer.SalesHistory.Get",
  "source": "BC Portal",
  "subject": "{customerNo}",
  "data": "{\"fromDate\":\"2025-01-01\",\"toDate\":\"2025-12-31\"}"
}
```

**Response Format:**
```json
{
  "status": "Success",
  "noOfRecords": 5,
  "customerNo": "10000",
  "customerName": "Adatum Corporation",
  "fromDate": "2025-01-01",
  "toDate": "2025-12-31",
  "salesHistory": [
    {
      "itemNo": "1000",
      "variantCode": "",
      "description": "Bicycle",
      "unitOfMeasureCode": "PCS",
      "baseUnitOfMeasure": "PCS",
      "baseUOMDescription": "Piece",
      "quantity": 25,
      "noOfOrders": 3
    }
  ]
}
```

All API calls must be made using the `cePost()` function with proper authentication and company context.

## Implementation Structure Prepared

### UI Components (Already Implemented)
- ✅ Tab button added to customer detail view
- ✅ Tab panel (`#tab-sales-history`) with content area
- ✅ Translation strings added to UI_STRINGS array
- ✅ Tab switching logic updated to include 'sales-history'
- ✅ Lazy loading implemented - `loadSalesHistory()` called on first tab access
- ✅ Placeholder function `loadSalesHistory()` created at line ~1238 of index.html

### Tab Position
**Order in Customer Detail View:**
1. Ledger Entries (existing)
2. **Sales History (new)** ← positioned here
3. Documents (existing)
4. Create Order (existing)

## Data Source & Business Logic

### Primary Data Source
- **Message Type**: `Customer.SalesHistory.Get`
- **Data Aggregation**: By Item (not by document)
- **Source Data**: Posted Sales Invoices only
- **Item Types**: Item table entries only (excludes G/L Accounts, Resources, etc.)

### Date Range Filter
- **Default**: Last 12 months from current date
- **User Configurable**: Yes - from/to date pickers
- **Date Field**: Posting Date of sales invoices
- **Format**: YYYY-MM-DD

### Customer Filter
- **Automatic**: Based on selected customer (`activeCustomer.no`)
- **Passed in**: Cloud Event `subject` field

## Field Specifications

### Response Fields (from API)

| Field | Type | Description | Display |
|-------|------|-------------|---------|
| itemNo | Code[20] | Item number | Yes |
| variantCode | Code[10] | Item variant code | Yes (if not blank) |
| description | Text[100] | Item description from invoice line | Yes |
| unitOfMeasureCode | Code[10] | UOM used on invoice line | Yes |
| baseUnitOfMeasure | Code[10] | Base UOM from item card | No (reference only) |
| baseUOMDescription | Text[50] | Base UOM description | No (reference only) |
| quantity | Decimal | Total quantity sold (aggregated) | Yes (formatted) |
| noOfOrders | Integer | Count of unique invoices | Yes |

### Additional Display Fields

| Field | Source | Description | Display |
|-------|--------|-------------|---------|
| customerNo | Response root | Customer number | Header only |
| customerName | Response root | Customer name | Header only |
| fromDate | Response root | Query start date | Header only |
| toDate | Response root | Query end date | Header only |
| noOfRecords | Response root | Total item count | Header summary |

## Display Format

### Layout: Table/Grid
Display as a sortable table similar to ledger entries pattern.

**Table Structure:**
```
┌─────────────────────────────────────────────────────────────────────────┐
│ Sales History: {customerNo} - {customerName}                            │
│ Period: {fromDate} to {toDate}                    {noOfRecords} items   │
├──────────┬─────────────────────┬──────────┬──────────┬──────────────────┤
│ Item No. │ Description         │ Variant  │ Quantity │ # Orders         │
├──────────┼─────────────────────┼──────────┼──────────┼──────────────────┤
│ 1000     │ Bicycle             │          │ 25 PCS   │ 3                │
│ 1001     │ Touring Bike Red    │ RED      │ 10 PCS   │ 2                │
└──────────┴─────────────────────┴──────────┴──────────┴──────────────────┘
```

**Column Specifications:**

1. **Item No.** (itemNo)
   - Width: 120px
   - Alignment: Left
   - Sortable: Yes
   - Click action: None (future: could link to item detail)

2. **Description** (description)
   - Width: Flex (takes remaining space)
   - Alignment: Left
   - Sortable: Yes
   - Click action: None

3. **Variant** (variantCode)
   - Width: 100px
   - Alignment: Center
   - Sortable: Yes
   - Display: Only show if not blank, otherwise show "—"

4. **Quantity** (quantity + unitOfMeasureCode)
   - Width: 120px
   - Alignment: Right
   - Sortable: Yes (by numeric quantity)
   - Format: `{quantity} {unitOfMeasureCode}` (e.g., "25 PCS")
   - Number format: 2 decimal places

5. **# Orders** (noOfOrders)
   - Width: 100px
   - Alignment: Right
   - Sortable: Yes
   - Format: Integer (no decimals)

### Header Section
Above the table, display:
- Customer number and name
- Date range filter controls (from/to date pickers)
- "Refresh" button to reload with new dates
- Item count summary

### Empty State
When no sales history exists:
```
📊
No sales history found
This customer has no invoiced items in the selected period.
```

### Loading State
While loading:
```
[spinner animation]
Loading sales history...
```

## Sorting & Filtering

### Default Sort
- **Column**: Quantity
- **Direction**: Descending (highest quantity first)
- **Secondary Sort**: Item No. (ascending)

### Sortable Columns
All columns are sortable by clicking column headers:
- Item No. (alphanumeric)
- Description (alphanumeric)
- Variant (alphanumeric)
- Quantity (numeric)
- # Orders (numeric)

### Date Range Filter
**UI Controls:**
- **From Date** input (date picker)
  - Default: 12 months ago from today
  - Label: "From" (translatable)
- **To Date** input (date picker)
  - Default: Today
  - Label: "To" (translatable)
- **Refresh Button**
  - Reloads data with selected date range
  - Label: "Refresh" (translatable)

**Date Validation:**
- From date cannot be after to date
- To date cannot be in the future
- If validation fails, show error toast

## Pagination

**Approach**: No pagination initially

**Rationale**: 
- Sales history is aggregated by item (not by document)
- Typical customer sales history contains manageable number of unique items
- API returns complete dataset in single call
- If performance issues arise, can add client-side filtering/virtual scrolling

**Future Enhancement**: 
- Add search/filter box to filter items client-side
- Implement virtual scrolling if item count exceeds 1000

## User Interactions

### Current Phase (No interactions)
- Display data only
- Sort by clicking column headers
- Change date range and refresh

### Future Enhancements (Not in this phase)
- Click item number to view item details
- Click orders count to view list of invoices for that item
- Export to Excel
- Print functionality

## Translation Support

### UI Strings to Add to UI_STRINGS Array

Add to index.html `UI_STRINGS` array:
```javascript
'Sales History',              // Tab label
'Loading sales history...',   // Loading message
'No sales history',           // Empty state title  
'This customer has no invoiced items in the selected period.', // Empty state message
'Item No.', 'Description', 'Variant', 'Quantity', '# Orders',  // Column headers
'From', 'To', 'Refresh',      // Date filter labels
'Period',                     // Header label
'items',                      // Summary (e.g., "25 items")
'Invalid date range',         // Validation error
'From date cannot be after to date', // Validation error
'Sales History:',            // Header prefix
```

### Field Captions
- Item No., Description, Variant, Quantity, etc. are displayed in English
- These come directly from API response and don't need translation
- If localization needed in future, can add `Help.Fields.Get` for Item table

## Validation Rules

### Date Range Validation
1. **From Date Required**
   - Must be provided
   - Format: YYYY-MM-DD
   - Error: "From date is required"

2. **To Date Optional**
   - Defaults to today if not provided
   - Format: YYYY-MM-DD

3. **Date Logic**
   - From date ≤ To date
   - Error: "From date cannot be after to date"
   - To date ≤ Today
   - Error: "To date cannot be in the future"

### API Response Validation
1. **Status Check**
   - Verify `status === "Success"`
   - If `status === "Error"`, display error message from response

2. **Data Validation**
   - Verify `salesHistory` array exists
   - Handle empty array gracefully (show empty state)

## Event Handlers

### Primary Function
```javascript
async function loadSalesHistory(fromDate = null, toDate = null)
```

**Parameters:**
- `fromDate` - Start date (YYYY-MM-DD), defaults to 12 months ago
- `toDate` - End date (YYYY-MM-DD), defaults to today

**Behavior:**
1. Calculate default dates if not provided
2. Validate date range
3. Show loading spinner
4. Call `Customer.SalesHistory.Get` API
5. Handle response:
   - Success: Render table with data
   - Empty: Show empty state
   - Error: Show error message
6. Mark content as loaded (`dataset.loaded = 'true'`)

### Helper Functions

**`renderSalesHistoryTable(historyData)`**
- Accepts sales history response object
- Generates HTML table
- Applies sorting
- Updates DOM

**`validateDateRange(fromDate, toDate)`**
- Returns { valid: boolean, error: string }
- Checks date logic

**`formatQuantity(qty, uom)`**
- Formats: `{qty} {uom}` with 2 decimals
- Example: "25.00 PCS"

**`sortSalesHistory(data, column, direction)`**
- Sorts array by column
- Returns sorted array

### Event Listeners

**Date Picker Changes:**
- Attached to from/to date inputs
- No auto-refresh (user must click Refresh button)

**Refresh Button Click:**
- Validates dates
- Calls `loadSalesHistory()` with new dates

**Column Header Click:**
- Toggles sort direction
- Re-renders table with sorted data

**Tab Switch (already implemented):**
- Calls `loadSalesHistory()` on first access
- Handled in `switchTab()` function

## Error Handling

### API Errors
**Scenario**: Cloud Events API returns error

**Handling:**
```javascript
if (result.status === 'Error') {
  const errorMsg = result.error || 'Unknown error';
  el.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠</div><p>Error loading sales history</p></div>';
  toast('Failed to load sales history:\n' + errorMsg, 'error');
  return;
}
```

### Network Errors
**Scenario**: Fetch fails, network timeout, etc.

**Handling:**
```javascript
catch (error) {
  console.error('Error loading sales history:', error);
  const errorDetails = error.stack || error.message;
  el.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠</div><p>Error loading sales history</p></div>';
  toast('Failed to load sales history:\n' + errorDetails, 'error');
}
```

### Date Validation Errors
**Scenario**: Invalid date range selected

**Handling:**
- Don't call API
- Show toast with specific error
- Keep existing data displayed (if any)

## CSS Styling Requirements

### Date Filter Controls
```css
.sales-history-filters {
  display: flex;
  gap: 16px;
  padding: 16px;
  background: var(--card-bg);
  border-radius: 6px;
  margin-bottom: 16px;
  align-items: center;
}

.date-filter-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.date-filter-label {
  font-size: 0.75rem;
  color: var(--text-dim);
  font-weight: 500;
}

.date-filter-input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-family: inherit;
  font-size: 0.875rem;
}

.btn-refresh {
  padding: 8px 16px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  align-self: flex-end;
}

.btn-refresh:hover {
  background: var(--accent-hover);
}
```

### Sales History Table
Reuse existing table styles from ledger entries with minor adjustments:
- Add column-specific widths
- Ensure quantity column is right-aligned
- Add hover effect on sortable column headers

### Header Summary
```css
.sales-history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.sales-history-title {
  font-size: 0.875rem;
  color: var(--text-dim);
}

.sales-history-summary {
  font-size: 0.75rem;
  color: var(--text-dim);
}
```

## Implementation Steps

### Phase 1: Core Functionality (Required)
1. ✅ Add tab UI structure (DONE)
2. ✅ Add translation strings (DONE)
3. ✅ Implement tab switching logic (DONE)
4. Implement `loadSalesHistory()` function
5. Implement date range filter UI
6. Implement API call to `Customer.SalesHistory.Get`
7. Implement table rendering
8. Implement column sorting
9. Add loading/empty/error states
10. Add date validation
11. Test with various customers and date ranges

### Phase 2: Enhancements (Future)
- Client-side search/filter
- Export to Excel
- Click item to view details
- Click order count to view invoices
- Virtual scrolling for large datasets
- Date range presets (Last 30 days, Last 6 months, etc.)

## Testing Checklist

### UI Structure
- [ ] Tab appears in correct position (between Ledger and Documents)
- [ ] Tab label displays correctly ("Sales History")
- [ ] Tab switches correctly when clicked
- [ ] Tab content area initializes properly

### Data Loading
- [ ] Data loads on first tab access (lazy loading)
- [ ] Loading spinner shows during API call
- [ ] Data does not reload on subsequent tab switches (unless refresh clicked)
- [ ] API call includes correct customer number
- [ ] API call includes correct date range

### Date Range Filter
- [ ] From date picker displays and works
- [ ] To date picker displays and works
- [ ] Default dates set correctly (12 months ago to today)
- [ ] Refresh button appears and is clickable
- [ ] Dates update correctly when changed
- [ ] Validation prevents invalid date ranges
- [ ] Error messages display for invalid dates

### Data Display
- [ ] Table renders with correct columns
- [ ] Column headers display correctly
- [ ] Item numbers display correctly
- [ ] Descriptions display correctly
- [ ] Variant codes display correctly (or "—" if blank)
- [ ] Quantities format correctly with 2 decimals and UOM
- [ ] Order counts display as integers
- [ ] Customer header shows customer number and name
- [ ] Period displays from/to dates
- [ ] Record count summary displays correctly

### Sorting
- [ ] Clicking "Item No." header sorts alphanumerically
- [ ] Clicking "Description" header sorts alphanumerically
- [ ] Clicking "Variant" header sorts alphanumerically
- [ ] Clicking "Quantity" header sorts numerically
- [ ] Clicking "# Orders" header sorts numerically
- [ ] Sort direction toggles on repeated clicks
- [ ] Visual indicator shows current sort column and direction
- [ ] Default sort is by quantity descending

### Empty State
- [ ] Empty state displays when no data
- [ ] Empty state icon and message correct
- [ ] Empty state appears when date range has no sales

### Error Handling
- [ ] API errors display error state
- [ ] Error message shows in toast
- [ ] Network errors handled gracefully
- [ ] Date validation errors show toast
- [ ] Invalid date ranges prevented from calling API

### Localization
- [ ] All UI strings translate correctly (when language changed)
- [ ] Column headers use translated strings
- [ ] Date filter labels translate
- [ ] Error messages translate
- [ ] Empty state message translates
- [ ] LCID passed correctly in API call

### Responsive Design
- [ ] Layout works on desktop (1920px)
- [ ] Layout works on laptop (1366px)
- [ ] Layout works on tablet (768px)
- [ ] Layout works on mobile (375px)
- [ ] Table scrolls horizontally if needed on small screens
- [ ] Date filters stack vertically on mobile

### Performance
- [ ] Typical dataset (50 items) loads quickly
- [ ] Large dataset (500+ items) renders without lag
- [ ] Sorting is responsive
- [ ] Date filter updates don't cause flicker

### Integration
- [ ] Works with all customers (test multiple)
- [ ] Works with different date ranges
- [ ] Works with customers that have no sales
- [ ] Works with customers that have extensive sales history
- [ ] Does not break existing tabs (Ledger, Documents, Create Order)

## Implementation Notes

### API Call Example
```javascript
const result = await cePost(selectedCompany.id, {
  specversion: '1.0',
  type: 'Customer.SalesHistory.Get',
  source: 'BC Portal',
  subject: activeCustomer.no,
  data: JSON.stringify({
    fromDate: fromDate,  // YYYY-MM-DD
    toDate: toDate        // YYYY-MM-DD
  })
});
```

### Response Handling
```javascript
if (result.status === 'Success') {
  const { salesHistory, customerNo, customerName, fromDate, toDate, noOfRecords } = result;
  renderSalesHistoryTable(result);
} else {
  showError(result.error);
}
```

### Date Calculation
```javascript
// Default: 12 months ago
const getDefaultFromDate = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().split('T')[0];
};

// Default: Today
const getDefaultToDate = () => {
  return new Date().toISOString().split('T')[0];
};
```

### Table Rendering Pattern
Follow existing pattern from ledger entries:
1. Build header row with customer info and summary
2. Build date filter controls
3. Build table HTML with column headers
4. Loop through salesHistory array
5. Generate row HTML for each item
6. Handle empty array specially
7. Attach sort event listeners to column headers

## Notes
- Sales history is based on **posted sales invoices only** (not quotes, orders, or shipments)
- Data is **aggregated by item** (quantity is sum, orders is count)
- API response includes **variant info** - display if not blank
- **Unit of measure** comes from invoice line (may differ from base UOM)
- Date range is **inclusive** (from ≤ posting date ≤ to)
- Customer number passed in **subject field** (not in data)
- Response includes **customer name** for display in header
- Empty variant code should display as "—" not blank
- Decimal quantities formatted to **2 places** (e.g., 25.00)
- Order count is **integer** (no decimals needed)
