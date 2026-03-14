# Requirement 1: Customer Creation Feature - Implementation Specification

## Overview
Implement a customer creation form in the Business Central Cloud Events web portal that allows users to create new customer records with validation, auto-population, and lookup field support.

**Key Features:**
- ✅ **Full Localization**: All field labels retrieved from BC in user's language
- ✅ **Translatable UI**: All UI constants (buttons, messages, section headers) support multiple languages
- ✅ **Icelandic Kennitala Validation**: Matches BC AL validation exactly
- ✅ **Smart Auto-Population**: Registration Number → No., Post Code → City/Country, Gen. Bus. → VAT Bus.
- ✅ **10 Lookup Tables**: Dropdown controls populated from BC reference tables
- ✅ **Image Upload**: Customer images with base64 encoding and GUID generation
- ✅ **Comprehensive Validation**: Required fields, email format, credit limits, and Kennitala check digit

## API Reference
This implementation follows the **Business Central Cloud Events API** specification documented in [CLOUD_EVENTS_API.md](../../CLOUD_EVENTS_API.md).

**Key API Message Types Used:**
- `Data.Records.Get` - Retrieve records from BC tables (for lookup data)
- `Data.Records.Set` - Create/update customer records
- `Help.Fields.Get` - Retrieve field metadata and captions in user's language

All API calls must be made using the `cePost()` function with proper authentication and company context.

## Target Table
- **Table Number**: 18 (Customer)
- **Primary Key**: No.
- **API Method**: Data.Records.Set

## Field Specifications

### 1. Customer Identification
| Field Name | BC Field | Type | Required | Control | Validation | Notes |
|------------|----------|------|----------|---------|------------|-------|
| Registration Number | RegistrationNumber | Text(20) | Yes | Text Input | Icelandic Kennitala | 10-digit numeric, auto-populates No. |
| Customer Number | No_ | Code(20) | Yes | Read-only | None | Auto-populated from Registration Number |
| Customer Name | Name | Text(100) | Yes | Text Input | None | |
| Search Name | SearchName | Code(100) | No | Text Input | None | |

### 2. Address Information
| Field Name | BC Field | Type | Required | Control | Auto-Populate | Notes |
|------------|----------|------|----------|---------|---------------|-------|
| Address | Address | Text(100) | No | Text Input | No | |
| Address 2 | Address2 | Text(50) | No | Text Input | No | |
| Post Code | PostCode | Code(20) | Yes | Dropdown | No | Triggers City/County/Country auto-fill |
| City | City | Text(30) | Yes | Read-only | Yes | From Post Code table (field 2) |
| Country/Region | Country_RegionCode | Code(10) | Yes | Read-only | Yes | From Post Code table (field 4) |
| County | County | Text(30) | No | Read-only | Yes | From Post Code table (field 5) |

### 3. Contact Information
| Field Name | BC Field | Type | Required | Control | Notes |
|------------|----------|------|----------|---------|-------|
| Mobile Phone | MobilePhoneNo_ | Text(30) | No | Text Input | |
| Email | EMail | Text(80) | No | Text Input | Email validation |
| Home Page | HomePage | Text(80) | No | Text Input | URL validation |

### 4. Posting Configuration
| Field Name | BC Field | Type | Required | Control | Lookup Info | Auto-Populate |
|------------|----------|------|----------|---------|-------------|---------------|
| Customer Posting Group | CustomerPostingGroup | Code(20) | Yes | Dropdown | Table 92, Fields: 1 (Code), 20 (Description) | No |
| Gen. Bus. Posting Group | Gen_Bus_PostingGroup | Code(20) | Yes | Dropdown | Table 250, Fields: 1 (Code), 2 (Description), 3 (Def. VAT Bus. Posting Group) | Triggers VAT auto-fill |
| VAT Bus. Posting Group | VATBus_PostingGroup | Code(20) | Yes | Dropdown | Table 323, Fields: 1 (Code), 2 (Description) | Auto-filled from Gen. Bus. (field 3) |

### 5. Payment Information
| Field Name | BC Field | Type | Required | Control | Lookup Info | Notes |
|------------|----------|------|----------|---------|-------------|-------|
| Payment Terms | PaymentTermsCode | Code(10) | Yes | Dropdown | Table 3, Fields: 1 (Code), 5 (Description) | |
| Currency | CurrencyCode | Code(10) | No | Dropdown | Table 4, Fields: 1 (Code), 15 (Description) | Blank = LCY |
| Payment Method | PaymentMethodCode | Code(10) | No | Dropdown | Table 289, Fields: 1 (Code), 2 (Description) | |

### 6. Sales Configuration
| Field Name | BC Field | Type | Required | Control | Lookup Info | Notes |
|------------|----------|------|----------|---------|-------------|-------|
| Salesperson | SalespersonCode | Code(20) | No | Dropdown | Table 13, Fields: 1 (Code), 2 (Name) | |
| Location | LocationCode | Code(10) | No | Dropdown | Table 14, Fields: 1 (Code), 2 (Name) | |
| Language | LanguageCode | Code(10) | No | Dropdown | Table 8 (all languages loaded at company selection) | |

### 7. Credit Management
| Field Name | BC Field | Type | Required | Control | Notes |
|------------|----------|------|----------|---------|-------|
| Credit Limit | CreditLimitLCY | Decimal | No | Number Input | Non-negative |
| Blocked Status | Blocked | Option | No | Dropdown | Values: " " (blank), "Ship", "Invoice", "All" |

### 8. Tax Information
| Field Name | BC Field | Type | Required | Control | Validation | Notes |
|------------|----------|------|----------|---------|------------|-------|
| VAT Registration No. | VATRegistrationNo | Text(20) | No | Text Input | None | |

### 9. Media
| Field Name | BC Field | Type | Required | Control | Notes |
|------------|----------|------|----------|---------|-------|
| Customer Image | Image | MediaSet | No | File Upload | Accept image files only, base64 encoded |

**Image Field Structure:**
```json
{
  "Image": {
    "Id": "generated-guid",
    "Value": "base64-encoded-image-data"
  }
}
```

## Lookup Tables Reference

### Complete Lookup Table List with Field Numbers
```javascript
const LOOKUP_TABLES = {
  postCode: { table: 225, fields: [1, 2, 4, 5], mapping: { 1: 'Code', 2: 'city', 4: 'CountryRegionCode', 5: 'County' } },
  customerPostingGroup: { table: 92, fields: [1, 20], mapping: { 1: 'Code', 20: 'Description' } },
  genBusPostingGroup: { table: 250, fields: [1, 2, 3], mapping: { 1: 'Code', 2: 'Description', 3: 'Def_VATBusPostingGroup' } },
  vatBusPostingGroup: { table: 323, fields: [1, 2], mapping: { 1: 'Code', 2: 'Description' } },
  paymentTerms: { table: 3, fields: [1, 5], mapping: { 1: 'Code', 5: 'Description' } },
  currency: { table: 4, fields: [1, 15], mapping: { 1: 'Code', 15: 'Description' } },
  paymentMethod: { table: 289, fields: [1, 2], mapping: { 1: 'Code', 2: 'Description' } },
  salesperson: { table: 13, fields: [1, 2], mapping: { 1: 'Code', 2: 'Name' } },
  location: { table: 14, fields: [1, 2], mapping: { 1: 'Code', 2: 'Name' } },
  language: { table: 8, fields: [], note: 'All fields loaded at company selection' }
};
```

**Important**: Field access in responses uses `record.primaryKey.FieldName` for primary key fields and `record.fields.FieldName` for all other fields.

## Validation Rules

> **Note**: All validation error messages use the `t()` translation function to support multiple languages. Error messages are defined in the `TRANSLATIONS` object.

### 1. Icelandic Kennitala (Registration Number)
**Algorithm** (matches BC AL implementation exactly):
```javascript
function validateIcelandicKennitala(kennitala) {
  // Must be exactly 10 digits
  if (!/^\d{10}$/.test(kennitala)) {
    return { valid: false, error: t('valMust10Digits') };
  }
  
  // Extract first 8 digits and 9th digit (check digit)
  const digits = kennitala.substring(0, 8).split('').map(Number);
  const checkDigit = parseInt(kennitala[8], 10);
  
  // Weights for first 8 digits
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  
  // Calculate sum
  const sum = digits.reduce((acc, digit, index) => acc + (digit * weights[index]), 0);
  
  // Calculate expected check digit
  const expectedCheckDigit = sum % 11;
  
  // Validate
  if (checkDigit !== expectedCheckDigit) {
    return { valid: false, error: t('valInvalidKennitala') };
  }
  
  return { valid: true };
}
```

### 2. Email Validation
```javascript
function validateEmail(email) {
  if (!email) return { valid: true }; // Optional field
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) 
    ? { valid: true } 
    : { valid: false, error: t('valInvalidEmail') };
}
}
```

### 3. Credit Limit Validation
```javascript
function validateCreditLimit(value) {
  if (!value) return { valid: true }; // Optional field
  const num = parseFloat(value);
  if (isNaN(num) || num < 0) {
    return { valid: false, error: t('valNonNegative') };
  }
  return { valid: true };
}
```

### 4. Duplicate Customer Check
Before creating a new customer, the system must verify that no customer with the same Registration Number already exists in Business Central.

**When to Check**: After field validation passes, before calling `Data.Records.Set`

**API Call**:
```javascript
async function checkCustomerExists(registrationNumber) {
  try {
    const result = await cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Data.Records.Get',
      source: 'BC Portal',
      subject: 'Customer',
      data: JSON.stringify({
        tableName: 'Customer',
        tableView: `WHERE(Registration Number=CONST(${registrationNumber}))`
      })
    });
    
    // Check if any records were returned
    if (result.result && result.result.length > 0) {
      return {
        exists: true,
        customerNo: result.result[0].primaryKey?.No_ || result.result[0].fields?.No_,
        customerName: result.result[0].fields?.Name || 'Unknown'
      };
    }
    
    return { exists: false };
  } catch (error) {
    console.error('Error checking for existing customer:', error);
    // If check fails, allow creation to proceed (BC will handle constraint)
    return { exists: false };
  }
}
```

**Usage in Form Submission**:
```javascript
async function handleCreateCustomer() {
  // 1. Validate fields
  if (!validateCustomerForm()) {
    return;
  }
  
  // 2. Check for duplicate
  const registrationNo = document.getElementById('customer-registration-no').value;
  const duplicateCheck = await checkCustomerExists(registrationNo);
  
  if (duplicateCheck.exists) {
    toast(
      tCustomer('A customer with Registration No. {0} already exists (Customer No. {1}: {2}).', 
        registrationNo, 
        duplicateCheck.customerNo, 
        duplicateCheck.customerName
      ), 
      'error'
    );
    return;
  }
  
  // 3. Proceed with creation
  // ... rest of creation logic
}
```

**Error Message**: The error message uses placeholder substitution to show the conflicting Registration Number, Customer Number, and Customer Name.

### Auto-Population Logic

### 1. Registration Number → Customer Number
```javascript
// When Registration Number changes
document.getElementById('customer-registration-no').addEventListener('input', function() {
  const regNo = this.value;
  if (regNo.length === 10 && validateIcelandicKennitala(regNo).valid) {
    document.getElementById('customer-no').value = regNo;
  }
});
```

### 2. Post Code → City & Country/Region
```javascript
// When Post Code changes
document.getElementById('customer-post-code').addEventListener('blur', async function() {
  const postCode = this.value;
  if (!postCode) return;
  
  try {
    const result = await cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Data.Records.Get',
      source: 'BC Portal',
      data: JSON.stringify({
        tableName: 'Post Code',
        tableView: `WHERE(Code=CONST(${postCode}))`
      })
    });
    
    if (result.result && result.result.length > 0) {
      const record = result.result[0];
      // Note: Field names are case-sensitive. Post Code table uses lowercase 'city' and 'CountryRegionCode' (no underscore)
      document.getElementById('customer-city').value = record.city || '';
      document.getElementById('customer-country-code').value = record.CountryRegionCode || '';
    }
  } catch (error) {
    console.error('Error looking up post code:', error);
  }
});
```

### 3. Gen. Bus. Posting Group → VAT Bus. Posting Group
```javascript
// Store the mapping when Gen. Bus. Posting Group data is loaded (field 3)
let genBusToVATMapping = {};

async function loadGenBusPostingGroups() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Gen. Business Posting Group',
      fieldNumbers: [1, 2, 3]  // Code, Description, Def. VAT Bus. Posting Group
    })
  });
  
  if (result.result && result.result.length > 0) {
    result.result.forEach(record => {
      const code = record.primaryKey?.Code || record.fields?.Code;
      // Note: BC may return this field as either Def_VATBusPostingGroup or DefVATBusPostingGroup
      const defVAT = record.fields?.Def_VATBusPostingGroup || record.fields?.DefVATBusPostingGroup;
      if (code && defVAT) {
        genBusToVATMapping[code] = defVAT;
      }
    });
    
    // Populate dropdown
    populateCustomerDropdown('customer-gen-bus-posting-group', result.result, 'code', 'description');
  }
}

// When Gen. Bus. Posting Group dropdown changes, auto-select VAT Bus. Posting Group
document.getElementById('customer-gen-bus-posting-group').addEventListener('change', function() {
  const selectedCode = this.value;
  const defaultVAT = genBusToVATMapping[selectedCode];
  const vatDropdown = document.getElementById('customer-vat-bus-posting-group');
  
  if (defaultVAT && vatDropdown) {
    vatDropdown.value = defaultVAT;  // Sets dropdown to default value
  }
});
```

## UI Implementation Guide

### Form Structure
> **Note**: The field labels shown below are English defaults. During initialization, `loadFieldCaptions()` will dynamically replace these labels with localized captions from Business Central based on the user's selected language. Section legends (e.g., "Customer Identification", "Address Information") should also be localized if needed.

```html
<div id="customerCreateForm">
  <h2>Create New Customer</h2>
  
  <!-- Section 1: Customer Identification -->
  <fieldset>
    <legend>1. Customer Identification</legend>
    
    <div class="form-group">
      <label for="registrationNumber">Registration Number *</label>
      <input type="text" id="registrationNumber" maxlength="10" required>
      <span class="validation-indicator" id="regNoIndicator"></span>
    </div>
    
    <div class="form-group">
      <label for="customerNo">Customer Number *</label>
      <input type="text" id="customerNo" readonly class="readonly-field">
    </div>
    
    <div class="form-group">
      <label for="name">Customer Name *</label>
      <input type="text" id="name" maxlength="100" required>
    </div>
    
    <div class="form-group">
      <label for="searchName">Search Name</label>
      <input type="text" id="searchName" maxlength="100">
    </div>
  </fieldset>
  
  <!-- Section 2: Address Information -->
  <fieldset>
    <legend>2. Address Information</legend>
    
    <div class="form-group">
      <label for="address">Address</label>
      <input type="text" id="address" maxlength="100">
    </div>
    
    <div class="form-group">
      <label for="address2">Address 2</label>
      <input type="text" id="address2" maxlength="50">
    </div>
    
    <div class="form-group">
      <label for="postCode">Post Code *</label>
      <input type="text" id="postCode" maxlength="20" required>
    </div>
    
    <div class="form-group">
      <label for="city">City *</label>
      <input type="text" id="city" readonly class="readonly-field">
    </div>
    
    <div class="form-group">
      <label for="countryRegion">Country/Region *</label>
      <input type="text" id="countryRegion" readonly class="readonly-field">
    </div>
  </fieldset>
  
  <!-- Section 3: Contact Information -->
  <fieldset>
    <legend>3. Contact Information</legend>
    
    <div class="form-group">
      <label for="mobilePhone">Mobile Phone</label>
      <input type="tel" id="mobilePhone" maxlength="30">
    </div>
    
    <div class="form-group">
      <label for="email">Email</label>
      <input type="email" id="email" maxlength="80">
    </div>
    
    <div class="form-group">
      <label for="homePage">Home Page</label>
      <input type="url" id="homePage" maxlength="80">
    </div>
  </fieldset>
  
  <!-- Section 4: Posting Configuration -->
  <fieldset>
    <legend>4. Posting Configuration</legend>
    
    <div class="form-group">
      <label for="customerPostingGroup">Customer Posting Group *</label>
      <select id="customerPostingGroup" required>
        <option value="">-- Select --</option>
      </select>
    </div>
    
    <div class="form-group">
      <label for="genBusPostingGroup">Gen. Bus. Posting Group *</label>
      <select id="genBusPostingGroup" required>
        <option value="">-- Select --</option>
      </select>
    </div>
    
    <div class="form-group">
      <label for="vatBusPostingGroup">VAT Bus. Posting Group *</label>
      <select id="vatBusPostingGroup" required>
        <option value="">-- Select --</option>
      </select>
    </div>
  </fieldset>
  
  <!-- Section 5: Payment Information -->
  <fieldset>
    <legend>5. Payment Information</legend>
    
    <div class="form-group">
      <label for="paymentTerms">Payment Terms *</label>
      <select id="paymentTerms" required>
        <option value="">-- Select --</option>
      </select>
    </div>
    
    <div class="form-group">
      <label for="currency">Currency</label>
      <select id="currency">
        <option value="">-- LCY --</option>
      </select>
    </div>
    
    <div class="form-group">
      <label for="paymentMethod">Payment Method</label>
      <select id="paymentMethod">
        <option value="">-- Select --</option>
      </select>
    </div>
  </fieldset>
  
  <!-- Section 6: Sales Configuration -->
  <fieldset>
    <legend>6. Sales Configuration</legend>
    
    <div class="form-group">
      <label for="salesperson">Salesperson</label>
      <select id="salesperson">
        <option value="">-- Select --</option>
      </select>
    </div>
    
    <div class="form-group">
      <label for="location">Location</label>
      <select id="location">
        <option value="">-- Select --</option>
      </select>
    </div>
    
    <div class="form-group">
      <label for="language">Language</label>
      <select id="language">
        <option value="">-- Select --</option>
      </select>
    </div>
  </fieldset>
  
  <!-- Section 7: Credit Management -->
  <fieldset>
    <legend>7. Credit Management</legend>
    
    <div class="form-group">
      <label for="creditLimit">Credit Limit (LCY)</label>
      <input type="number" id="creditLimit" min="0" step="0.01">
    </div>
    
    <div class="form-group">
      <label for="blocked">Blocked Status</label>
      <select id="blocked">
        <option value="">-- Not Blocked --</option>
        <option value="Ship">Ship</option>
        <option value="Invoice">Invoice</option>
        <option value="All">All</option>
      </select>
    </div>
  </fieldset>
  
  <!-- Section 8: Tax Information -->
  <fieldset>
    <legend>8. Tax Information</legend>
    
    <div class="form-group">
      <label for="vatRegistrationNo">VAT Registration No.</label>
      <input type="text" id="vatRegistrationNo" maxlength="20">
    </div>
  </fieldset>
  
  <!-- Section 9: Media -->
  <fieldset>
    <legend>9. Customer Image</legend>
    
    <div class="form-group">
      <label for="customerImage">Upload Image</label>
      <input type="file" id="customerImage" accept="image/*">
      <div id="imagePreview"></div>
    </div>
  </fieldset>
  
  <!-- Form Actions -->
  <div class="form-actions">
    <button type="button" id="btnCreateCustomer" class="btn-primary">Create Customer</button>
    <button type="button" id="btnCancel" class="btn-secondary">Cancel</button>
  </div>
</div>
```

### CSS Styling
```css
.readonly-field {
  background-color: #f0f0f0;
  cursor: not-allowed;
  border: 1px solid #ccc;
}

.validation-indicator {
  display: inline-block;
  margin-left: 10px;
  font-weight: bold;
}

.validation-indicator.valid::after {
  content: '✓';
  color: green;
}

.validation-indicator.invalid::after {
  content: '✗';
  color: red;
}

fieldset {
  margin-bottom: 20px;
  padding: 15px;
  border: 1px solid #ddd;
  border-radius: 5px;
}

.form-group {
  margin-bottom: 15px;
}

.form-group label {
  display: block;
  margin-bottom: 5px;
  font-weight: 500;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
}

.form-actions {
  margin-top: 20px;
  text-align: right;
}

.btn-primary {
  background-color: #0078d4;
  color: white;
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.btn-secondary {
  background-color: #8a8a8a;
  color: white;
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 10px;
}
```

## Localization & Translation

### Translation Architecture
The customer creation form uses the same translation system as the rest of the BC Portal:
- **Field Captions**: Retrieved from Business Central via `Help.Fields.Get` API in the user's selected language (LCID)
- **UI Constants**: Translated via the Cloud Event Translation table with automatic placeholder creation
- **Language Selection**: Changes to the language dropdown immediately update all UI text and field captions

### Two-Level Translation System

#### Level 1: BC Field Captions (Dynamic)
Field labels are populated from Business Central's field metadata using the selected LCID (Windows Language ID):
- **API**: `Help.Fields.Get` with `lcid` parameter
- **Cache Key**: `companyId:lcid:tableName`
- **Updates**: When language changes, cache is invalidated and field captions reload

#### Level 2: UI Constants (Cloud Event Translation Table)
All UI text (buttons, messages, section headers, placeholders) is translated via the portal's translation system:
- **Table**: Cloud Event Translation (custom BC table)
- **Primary Key**: Source (fixed: "BC Portal"), Windows Language ID, Source Text
- **Fields**: Target Text (the translation)
- **Auto-Creation**: Missing translations are automatically created as blank records for users to fill in BC

### Field Caption Mapping
```javascript
// Map HTML element IDs to BC field numbers for Customer table (18)
const FIELD_MAPPING = {
  'registrationNumber': 'RegistrationNumber',
  'customerNo': 'No.',
  'name': 'Name',
  'searchName': 'Search Name',
  'address': 'Address',
  'address2': 'Address 2',
  'postCode': 'Post Code',
  'city': 'City',
  'countryRegion': 'Country/Region Code',
  'mobilePhone': 'Mobile Phone No.',  // BC field: MobilePhoneNo_
  'email': 'E-Mail',
  'homePage': 'Home Page',
  'customerPostingGroup': 'Customer Posting Group',
  'genBusPostingGroup': 'Gen. Bus. Posting Group',  // BC field: Gen_Bus_PostingGroup
  'vatBusPostingGroup': 'VAT Bus. Posting Group',  // BC field: VATBus_PostingGroup
  'paymentTerms': 'Payment Terms Code',
  'currency': 'Currency Code',
  'paymentMethod': 'Payment Method Code',
  'salesperson': 'Salesperson Code',
  'location': 'Location Code',
  'language': 'Language Code',
  'creditLimit': 'Credit Limit (LCY)',  // BC field: CreditLimitLCY
  'blocked': 'Blocked',
  'vatRegistrationNo': 'VAT Registration No.'
};
```

### Load Field Captions
```javascript
async function loadFieldCaptions() {
  try {
    const result = await cePost('Help.Fields.Get', {
      TableNo: 18
    });
    
    if (result.Fields) {
      // Store captions for each field
      const fieldCaptions = {};
      result.Fields.forEach(field => {
        fieldCaptions[field.FieldName] = field.FieldCaption || field.FieldName;
      });
      
      // Apply captions to form labels
      Object.keys(FIELD_MAPPING).forEach(elementId => {
        const fieldName = FIELD_MAPPING[elementId];
        const caption = fieldCaptions[fieldName];
        if (caption) {
          const label = document.querySelector(`label[for="${elementId}"]`);
          if (label) {
            // Preserve required indicator (*)
            const isRequired = label.textContent.includes('*');
            label.textContent = caption + (isRequired ? ' *' : '');
          }
        }
      });
      
      // Update form heading if "Customer" caption is available
      const customerCaption = fieldCaptions['Name'] || 'Customer';
      const heading = document.querySelector('#customerCreateForm h2');
      if (heading) {
        heading.textContent = `Create New ${customerCaption.replace(' Name', '')}`;
      }
    }
  } catch (error) {
    console.error('Error loading field captions:', error);
    // Fallback to English labels if caption loading fails
  }
}
```

### UI Strings Registry
All UI text that needs translation must be added to the `UI_STRINGS` array in index.html:

```javascript
const UI_STRINGS = [
  // ... existing strings ...
  
  // Customer creation UI
  '+ Create Customer', 'Create Customer', 'Create New Customer', 'Back to Customers',
  'Identification', 'Address', 'Contact', 'Posting', 'Payment', 'Sales', 
  'Credit Management', 'Media', 'Reset Form',
  'Upload a customer logo or image (optional)',
  
  // Customer creation messages and validation
  '-- Select --', '-- LCY --', 'Loading form data...', 'Creating customer...',
  'Customer {0} created successfully!', 
  'An error occurred while creating the customer.',
  'Failed to create customer: {0}',
  'Failed to load form data. Please refresh the page.',
  'A customer with Registration No. {0} already exists (Customer No. {1}: {2}).',
  '{0} is required', 'Invalid email format', 
  'Invalid Registration No. check digit', 'Must be 10 digits',
  'Must be a non-negative number', 'Please fix the following errors:',
  'Error looking up post code',
  
  // Field caption fallbacks (will be replaced by BC captions)
  'Registration No.', 'No.', 'Name', 'Name 2',
  'Post Code', 'City', 'Country/Region Code', 'County',
  'Phone No.', 'E-Mail',
  'Customer Posting Group', 'Gen. Bus. Posting Group', 'VAT Bus. Posting Group',
  'Payment Terms Code', 'Payment Method Code',
  'Currency Code', 'Language Code', 'Salesperson Code', 'Location Code',
  'Credit Limit (LCY)', 'Image'
];
```

### HTML Translation Attributes
All static UI elements use `data-t` or `data-tp` attributes:

**`data-t` - Text Content Translation**
```html
<span data-t="Create New Customer">Create New Customer</span>
<button data-t="Create Customer">Create Customer</button>
<legend data-t="Identification">Identification</legend>
```

**`data-tp` - Placeholder Translation**
```html
<input data-tp="Search customers..." placeholder="Search customers..." />
```

### Translation Functions

#### Global Translation Function
```javascript
// t(): translate a UI constant; falls back to the English text when no translation is available
function t(s) { 
  return uiTranslations[s] || s; 
}

// Support for placeholders: {0}, {1}, etc.
function tCustomer(key, ...args) {
  const translation = (typeof t === 'function') ? t(key) : key;
  return translation.replace(/\{(\d+)\}/g, (match, index) => {
    return args[index] !== undefined ? args[index] : match;
  });
}
```

#### Apply Translations
```javascript
// Global translation application (called automatically when language changes)
function applyUiTranslations() {
  document.querySelectorAll('[data-t]').forEach(el => { 
    el.textContent = t(el.dataset.t); 
  });
  document.querySelectorAll('[data-tp]').forEach(el => { 
    el.placeholder = t(el.dataset.tp); 
  });
}

// Customer-specific translations (section numbering and dropdown placeholders)
function applyCustomerUITranslations() {
  // Add section numbering to legends
  const sections = [
    { selector: '#customer-create-form fieldset:nth-of-type(1) legend', key: 'Identification', prefix: '1. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(2) legend', key: 'Address', prefix: '2. ' },
    // ... etc
  ];
  
  sections.forEach(section => {
    const element = document.querySelector(section.selector);
    if (element) {
      element.textContent = section.prefix + tCustomer(section.key);
    }
  });
  
  // Update dropdown placeholders (options aren't covered by data-t)
  updateDropdownPlaceholder('customer-posting-group', '-- Select --');
  // ... etc
}

function updateDropdownPlaceholder(dropdownId, translationKey) {
  const dropdown = document.getElementById(dropdownId);
  if (dropdown && dropdown.options.length > 0) {
    dropdown.options[0].text = tCustomer(translationKey);
  }
}
```

### Language Change Workflow
When a user selects a different language:

1. **Update Global State**
   ```javascript
   selectedLcid = newLcid;  // e.g., 1033 = English, 1039 = Icelandic
   ```

2. **Clear Field Metadata Cache**
   ```javascript
   fieldMetaCache = {};  // Force reload of field captions in new language
   ```

3. **Reload UI Translations**
   ```javascript
   await loadUiTranslations();  // Fetch from Cloud Event Translation table
   ```

4. **Apply Translations**
   ```javascript
   applyUiTranslations();           // Global UI elements with data-t/data-tp
   applyCustomerUITranslations();   // Customer form specific elements
   ```

5. **Reload Field Captions**
   ```javascript
   await loadCustomerFieldCaptions();  // Refresh BC field labels
   ```

6. **Reload Lookup Data** (if needed)
   ```javascript
   // Reload dropdowns to get localized descriptions
   await loadCustomerPostingGroups();
   // ... etc
   ```

### Managing Translations in Business Central

**For Administrators:**

1. Open **Cloud Event Translation** table in Business Central
2. Filter by:
   - **Source**: "BC Portal"
   - **Windows Language ID**: Your language LCID (e.g., 1039 for Icelandic)
3. Find records where **Target Text** is blank
4. Fill in the translations
5. Portal will immediately use the new translations when users change language

**Auto-Creation of Placeholders:**
- When users select a language without translations, the portal automatically creates blank translation records
- This makes it easy for admins to see which strings need translation
- No code changes needed to add new languages

## JavaScript Implementation

### Initialization
```javascript
// Load all lookup data on page load
async function initCustomerCreateForm() {
  try {
    // Detect user's language
    detectLanguage();
    
    // Apply UI translations
    applyUITranslations();
    
    // Show loading indicator
    showLoading(t('msgLoading'));
    
    // Load field captions and lookup tables in parallel
    await Promise.all([
      loadFieldCaptions(),
      loadCustomerPostingGroups(),
      loadGenBusPostingGroups(),
      loadVATBusPostingGroups(),
      loadPaymentTerms(),
      loadCurrencies(),
      loadPaymentMethods(),
      loadSalespersons(),
      loadLocations(),
      loadLanguages()
    ]);
    
    // Setup event listeners
    setupEventListeners();
    
    hideLoading();
  } catch (error) {
    console.error('Error initializing form:', error);
    showError(t('msgErrorLoadFailed'));
  }
}

// Generic dropdown population
function populateDropdown(dropdownId, records, valueField, textField) {
  const dropdown = document.getElementById(dropdownId);
  const currentValue = dropdown.value;
  
  // Clear existing options except the first one (placeholder)
  while (dropdown.options.length > 1) {
    dropdown.remove(1);
  }
  
  // Add new options
  records.forEach(record => {
    const option = document.createElement('option');
    option.value = record[valueField];
    option.textContent = textField ? `${record[valueField]} - ${record[textField]}` : record[valueField];
    dropdown.appendChild(option);
  });
  
  // Restore previous value if it still exists
  if (currentValue) {
    dropdown.value = currentValue;
  }
}

// Load individual lookup tables
async function loadCustomerPostingGroups() {
  const result = await cePost('Data.Records.Get', { TableNo: 92 });
  if (result.Records) {
    populateDropdown('customerPostingGroup', result.Records, 'Code', 'Description');
  }
}

async function loadGenBusPostingGroups() {
  const result = await cePost('Data.Records.Get', { TableNo: 251 });
  if (result.Records) {
    // Store mapping for auto-population
    genBusToVATMapping = {};
    result.Records.forEach(record => {
      genBusToVATMapping[record.Code] = record.Def_VATBusPostingGroup;
    });
    populateDropdown('genBusPostingGroup', result.Records, 'Code', 'Description');
  }
}

async function loadVATBusPostingGroups() {
  const result = await cePost('Data.Records.Get', { TableNo: 323 });
  if (result.Records) {
    populateDropdown('vatBusPostingGroup', result.Records, 'Code', 'Description');
  }
}

async function loadPaymentTerms() {
  const result = await cePost('Data.Records.Get', { TableNo: 3 });
  if (result.Records) {
    populateDropdown('paymentTerms', result.Records, 'Code', 'Description');
  }
}

async function loadCurrencies() {
  const result = await cePost('Data.Records.Get', { TableNo: 4 });
  if (result.Records) {
    populateDropdown('currency', result.Records, 'Code', 'Description');
  }
}

async function loadPaymentMethods() {
  const result = await cePost('Data.Records.Get', { TableNo: 289 });
  if (result.Records) {
    populateDropdown('paymentMethod', result.Records, 'Code', 'Description');
  }
}

async function loadSalespersons() {
  const result = await cePost('Data.Records.Get', { TableNo: 13 });
  if (result.Records) {
    populateDropdown('salesperson', result.Records, 'Code', 'Name');
  }
}

async function loadLocations() {
  const result = await cePost('Data.Records.Get', { TableNo: 14 });
  if (result.Records) {
    populateDropdown('location', result.Records, 'Code', 'Name');
  }
}

async function loadLanguages() {
  const result = await cePost('Data.Records.Get', { TableNo: 8 });
  if (result.Records) {
    populateDropdown('language', result.Records, 'Code', 'Name');
  }
}
```

### Event Listeners
```javascript
function setupEventListeners() {
  // Registration Number validation and auto-population
  document.getElementById('registrationNumber').addEventListener('input', function() {
    const regNo = this.value;
    const indicator = document.getElementById('regNoIndicator');
    
    if (regNo.length === 10) {
      const validation = validateIcelandicKennitala(regNo);
      if (validation.valid) {
        indicator.className = 'validation-indicator valid';
        document.getElementById('customerNo').value = regNo;
      } else {
        indicator.className = 'validation-indicator invalid';
        indicator.title = validation.error;
      }
    } else {
      indicator.className = 'validation-indicator';
    }
  });
  
  // Post Code lookup
  document.getElementById('postCode').addEventListener('blur', async function() {
    const postCode = this.value;
    if (!postCode) return;
    
    try {
      const result = await cePost(selectedCompany.id, {
        specversion: '1.0',
        type: 'Data.Records.Get',
        source: 'BC Portal',
        data: JSON.stringify({
          tableName: 'Post Code',
          tableView: `WHERE(Code=CONST(${postCode}))`
        })
      });
      
      if (result.Records && result.Records.length > 0) {
        const record = result.Records[0];
        document.getElementById('city').value = record.City || '';
        document.getElementById('countryRegion').value = record.Country_RegionCode || '';
      }
    } catch (error) {
      console.error('Error looking up post code:', error);
    }
  });
  
  // Gen. Bus. Posting Group auto-population of VAT
  document.getElementById('genBusPostingGroup').addEventListener('change', function() {
    const selectedCode = this.value;
    const defaultVAT = genBusToVATMapping[selectedCode];
    
    if (defaultVAT) {
      const vatDropdown = document.getElementById('vatBusPostingGroup');
      if (Array.from(vatDropdown.options).some(opt => opt.value === defaultVAT)) {
        vatDropdown.value = defaultVAT;
      }
    }
  });
  
  // Create Customer button
  document.getElementById('btnCreateCustomer').addEventListener('click', handleCreateCustomer);
  
  // Cancel button
  document.getElementById('btnCancel').addEventListener('click', function() {
    if (confirm(t('msgCancelConfirm'))) {
      document.getElementById('customerCreateForm').reset();
    }
  });
  
  // Image preview
  document.getElementById('customerImage').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = function(e) {
        document.getElementById('imagePreview').innerHTML = 
          `<img src="${e.target.result}" style="max-width: 200px; max-height: 200px;">`;
      };
      reader.readAsDataURL(file);
    }
  });
}
```

### Form Submission
```javascript
async function handleCreateCustomer() {
  try {
    // Validate required fields
    if (!validateForm()) {
      return;
    }
    
    // Show loading
    showLoading(t('msgCreating'));
    
    // Gather form data
    const customerData = {
      RegistrationNumber: document.getElementById('registrationNumber').value,
      No_: document.getElementById('customerNo').value,
      Name: document.getElementById('name').value,
      SearchName: document.getElementById('searchName').value || '',
      Address: document.getElementById('address').value || '',
      Address2: document.getElementById('address2').value || '',
      PostCode: document.getElementById('postCode').value,
      City: document.getElementById('city').value,
      Country_RegionCode: document.getElementById('countryRegion').value,
      MobilePhoneNo: document.getElementById('mobilePhone').value || '',
      EMail: document.getElementById('email').value || '',
      HomePage: document.getElementById('homePage').value || '',
      CustomerPostingGroup: document.getElementById('customerPostingGroup').value,
      GenBusPostingGroup: document.getElementById('genBusPostingGroup').value,
      VATBusPostingGroup: document.getElementById('vatBusPostingGroup').value,
      PaymentTermsCode: document.getElementById('paymentTerms').value,
      CurrencyCode: document.getElementById('currency').value || '',
      PaymentMethodCode: document.getElementById('paymentMethod').value || '',
      SalespersonCode: document.getElementById('salesperson').value || '',
      LocationCode: document.getElementById('location').value || '',
      LanguageCode: document.getElementById('language').value || '',
      CreditLimit_LCY_: parseFloat(document.getElementById('creditLimit').value) || 0,
      Blocked: document.getElementById('blocked').value || '',
      VATRegistrationNo: document.getElementById('vatRegistrationNo').value || ''
    };
    
    // Handle image upload if present
    const imageFile = document.getElementById('customerImage').files[0];
    if (imageFile) {
      const imageData = await convertImageToBase64(imageFile);
      customerData.Image = {
        Id: generateGuid(),
        value: imageData
      };
    }
    
    // Create customer via Cloud Events API
    const result = await cePost('Data.Records.Set', {
      TableNo: 18,
      Records: [customerData]
    });
    
    if (result.Success) {
      showSuccess(t('msgSuccess', customerData.No_));
      
      // Reset form
      document.getElementById('customerCreateForm').reset();
      document.getElementById('imagePreview').innerHTML = '';
    } else {
      showError(t('msgErrorFailed', result.Error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error creating customer:', error);
    showError(t('msgErrorGeneric'));
  } finally {
    hideLoading();
  }
}

function validateForm() {
  const errors = [];
  
  // Get field captions for error messages
  const getFieldCaption = (elementId) => {
    const label = document.querySelector(`label[for="${elementId}"]`);
    return label ? label.textContent.replace(' *', '') : elementId;
  };
  
  // Registration Number
  const regNo = document.getElementById('registrationNumber').value;
  if (!regNo) {
    errors.push(t('valRequired', getFieldCaption('registrationNumber')));
  } else {
    const validation = validateIcelandicKennitala(regNo);
    if (!validation.valid) {
      errors.push(getFieldCaption('registrationNumber') + ': ' + validation.error);
    }
  }
  
  // Customer Name
  if (!document.getElementById('name').value) {
    errors.push(t('valRequired', getFieldCaption('name')));
  }
  
  // Post Code
  if (!document.getElementById('postCode').value) {
    errors.push(t('valRequired', getFieldCaption('postCode')));
  }
  
  // Email validation
  const email = document.getElementById('email').value;
  if (email) {
    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      errors.push(getFieldCaption('email') + ': ' + emailValidation.error);
    }
  }
  
  // Posting Groups
  if (!document.getElementById('customerPostingGroup').value) {
    errors.push(t('valRequired', getFieldCaption('customerPostingGroup')));
  }
  if (!document.getElementById('genBusPostingGroup').value) {
    errors.push(t('valRequired', getFieldCaption('genBusPostingGroup')));
  }
  if (!document.getElementById('vatBusPostingGroup').value) {
    errors.push(t('valRequired', getFieldCaption('vatBusPostingGroup')));
  }
  
  // Payment Terms
  if (!document.getElementById('paymentTerms').value) {
    errors.push(t('valRequired', getFieldCaption('paymentTerms')));
  }
  
  // Credit Limit
  const creditLimit = document.getElementById('creditLimit').value;
  if (creditLimit) {
    const creditValidation = validateCreditLimit(creditLimit);
    if (!creditValidation.valid) {
      errors.push(getFieldCaption('creditLimit') + ': ' + creditValidation.error);
    }
  }
  
  // Display errors if any
  if (errors.length > 0) {
    showError(t('valFixErrors') + '\n\n' + errors.join('\n'));
    return false;
  }
  
  return true;
}

// Generate a GUID for Media field
function generateGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Convert image file to base64
function convertImageToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      // Remove the data:image/...;base64, prefix
      const base64 = e.target.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = function(error) {
      reject(error);
    };
    reader.readAsDataURL(file);
  });
}
```

## Testing Checklist

### Translation Testing
- [ ] Language dropdown changes update all UI text immediately
- [ ] Create Customer button text translates correctly
- [ ] All section headers (Identification, Address, etc.) translate
- [ ] All validation messages appear in selected language
- [ ] Dropdown placeholders ("-- Select --", "-- LCY --") translate
- [ ] Field labels update from BC field captions in selected language
- [ ] Missing translations auto-create blank records in Cloud Event Translation table
- [ ] Error messages use translated text
- [ ] Success messages use translated text with parameter substitution (e.g., "Customer {0} created successfully!")

### Functional Testing
- [ ] Form loads with all dropdowns populated
- [ ] Registration Number validation shows ✓/✗ indicator
- [ ] Invalid Kennitala rejected with clear error message
- [ ] Valid Kennitala auto-populates Customer Number
- [ ] Duplicate Registration Number check prevents creating duplicate customers
- [ ] Duplicate error message shows existing customer number and name
- [ ] Post Code lookup populates City and Country/Region
- [ ] Gen. Bus. Posting Group selection auto-fills VAT Bus. Posting Group
- [ ] All required fields validated before submission
- [ ] Optional fields can be left blank
- [ ] Email validation works correctly
- [ ] Credit Limit accepts only non-negative numbers
- [ ] Image preview displays selected image
- [ ] Form submits successfully to BC
- [ ] Success message displays after creation
- [ ] Form resets after successful creation
- [ ] Cancel button clears form with confirmation

### Edge Cases
- [ ] Empty dropdown selections handled gracefully
- [ ] Invalid Post Code shows appropriate message
- [ ] Gen. Bus. Posting Group without default VAT doesn't break VAT dropdown
- [ ] Duplicate customer check API failure allows creation to proceed
- [ ] Large image files handled appropriately
- [ ] Network errors handled with user-friendly messages

### Browser Compatibility
- [ ] Chrome
- [ ] Firefox
- [ ] Edge
- [ ] Safari

### Localization Testing
- [ ] Field captions loaded from BC in user's selected language
- [ ] All UI constants (buttons, section headers, messages) translated correctly
- [ ] Form displays correctly with non-English captions
- [ ] Required field indicators (*) preserved in all languages
- [ ] Dropdown placeholders translated (Select, LCY, Not Blocked, etc.)
- [ ] Validation error messages appear in correct language
- [ ] Success/error messages appear in correct language
- [ ] Fallback to English labels if caption loading fails
- [ ] Test with multiple BC language settings (e.g., English, Icelandic, Danish)

## Dependencies
- **Cloud Events API** - All implementation must follow the specification in [CLOUD_EVENTS_API.md](../../CLOUD_EVENTS_API.md)
- Existing `cePost()` function for Cloud Events API communication
- Company selection context (must be set before form is accessible)
- Valid OAuth token for BC API authentication

## Future Enhancements
1. Customer duplication detection before submission
2. Export/import customer data via Excel
3. Bulk customer creation
4. Customer templates for common configurations
5. Address validation via postal service API
6. Mobile-responsive design improvements
7. Additional language translations (Danish, Swedish, Norwegian, etc.)
8. Load UI translations from external resource file or API
9. User preference for UI language override
