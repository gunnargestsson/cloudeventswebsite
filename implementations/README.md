# Implementation Requirements

This folder contains detailed implementation specifications for web portal features.

## Structure
Each requirement is stored in its own subfolder with complete implementation details:
- Field specifications
- Validation rules
- UI structure
- JavaScript implementation
- Testing checklist

## Requirements

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

## Usage
Developers should read the SPECIFICATION.md file in each requirement folder for complete implementation details including:
- Data structures
- API endpoints
- Validation logic
- UI components
- Event handlers
- Testing requirements
