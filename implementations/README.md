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
**Status**: Ready for Implementation  
**Description**: Create new customer records in Business Central with validation, auto-population, and lookup support.

**Key Features**:
- Icelandic Kennitala validation
- Auto-population (Registration Number → Customer No., Post Code → City/Country, Gen. Bus. → VAT Bus.)
- 10 lookup tables for dropdowns
- Image upload support
- Required field validation

**Files**:
- `SPECIFICATION.md` - Complete implementation guide

## Usage
Developers should read the SPECIFICATION.md file in each requirement folder for complete implementation details including:
- Data structures
- API endpoints
- Validation logic
- UI components
- Event handlers
- Testing requirements
