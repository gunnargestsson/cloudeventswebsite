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
| Post Code | PostCode | Code(20) | Yes | Text Input | No | Triggers City/Country lookup |
| City | City | Text(30) | Yes | Read-only | Yes | From Post Code table |
| Country/Region | Country_RegionCode | Code(10) | Yes | Read-only | Yes | From Post Code table |

### 3. Contact Information
| Field Name | BC Field | Type | Required | Control | Notes |
|------------|----------|------|----------|---------|-------|
| Mobile Phone | MobilePhoneNo | Text(30) | No | Text Input | |
| Email | EMail | Text(80) | No | Text Input | Email validation |
| Home Page | HomePage | Text(80) | No | Text Input | URL validation |

### 4. Posting Configuration
| Field Name | BC Field | Type | Required | Control | Lookup Info | Auto-Populate |
|------------|----------|------|----------|---------|-------------|---------------|
| Customer Posting Group | CustomerPostingGroup | Code(20) | Yes | Dropdown | Table 92, Key: Code | No |
| Gen. Bus. Posting Group | GenBusPostingGroup | Code(20) | Yes | Dropdown | Table 251, Key: Code, Include: Def. VAT Bus. Posting Group | Triggers VAT auto-fill |
| VAT Bus. Posting Group | VATBusPostingGroup | Code(20) | Yes | Dropdown | Table 323, Key: Code | Auto-filled from Gen. Bus. |

### 5. Payment Information
| Field Name | BC Field | Type | Required | Control | Lookup Info | Notes |
|------------|----------|------|----------|---------|-------------|-------|
| Payment Terms | PaymentTermsCode | Code(10) | Yes | Dropdown | Table 3, Key: Code | |
| Currency | CurrencyCode | Code(10) | No | Dropdown | Table 4, Key: Code | Blank = LCY |
| Payment Method | PaymentMethodCode | Code(10) | No | Dropdown | Table 289, Key: Code | |

### 6. Sales Configuration
| Field Name | BC Field | Type | Required | Control | Lookup Info | Notes |
|------------|----------|------|----------|---------|-------------|-------|
| Salesperson | SalespersonCode | Code(20) | No | Dropdown | Table 13, Key: Code | |
| Location | LocationCode | Code(10) | No | Dropdown | Table 14, Key: Code | |
| Language | LanguageCode | Code(10) | No | Dropdown | Table 8, Key: Code | |

### 7. Credit Management
| Field Name | BC Field | Type | Required | Control | Notes |
|------------|----------|------|----------|---------|-------|
| Credit Limit | CreditLimit_LCY_ | Decimal | No | Number Input | Non-negative |
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
    "value": "base64-encoded-image-data"
  }
}
```

## Lookup Tables Reference

### Complete Lookup Table List
```javascript
const LOOKUP_TABLES = {
  postCode: { table: 225, keyField: 'Code', displayFields: ['Code', 'City', 'Country_RegionCode'] },
  customerPostingGroup: { table: 92, keyField: 'Code', displayFields: ['Code', 'Description'] },
  genBusPostingGroup: { table: 251, keyField: 'Code', displayFields: ['Code', 'Description', 'Def_VATBusPostingGroup'] },
  vatBusPostingGroup: { table: 323, keyField: 'Code', displayFields: ['Code', 'Description'] },
  paymentTerms: { table: 3, keyField: 'Code', displayFields: ['Code', 'Description'] },
  currency: { table: 4, keyField: 'Code', displayFields: ['Code', 'Description'] },
  paymentMethod: { table: 289, keyField: 'Code', displayFields: ['Code', 'Description'] },
  salesperson: { table: 13, keyField: 'Code', displayFields: ['Code', 'Name'] },
  location: { table: 14, keyField: 'Code', displayFields: ['Code', 'Name'] },
  language: { table: 8, keyField: 'Code', displayFields: ['Code', 'Name'] }
};
```

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

## Auto-Population Logic

### 1. Registration Number → Customer Number
```javascript
// When Registration Number changes
document.getElementById('registrationNumber').addEventListener('blur', function() {
  const regNo = this.value;
  if (regNo && validateIcelandicKennitala(regNo).valid) {
    document.getElementById('customerNo').value = regNo;
  }
});
```

### 2. Post Code → City & Country/Region
```javascript
// When Post Code changes
document.getElementById('postCode').addEventListener('blur', async function() {
  const postCode = this.value;
  if (!postCode) return;
  
  try {
    const result = await cePost('Data.Records.Get', {
      TableNo: 225,
      Filters: [{ FieldNo: 1, Value: postCode }] // Assuming Field 1 is Code
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
```

### 3. Gen. Bus. Posting Group → VAT Bus. Posting Group
```javascript
// Store the mapping when Gen. Bus. Posting Group data is loaded
let genBusToVATMapping = {};

async function loadGenBusPostingGroups() {
  const result = await cePost('Data.Records.Get', {
    TableNo: 251
  });
  
  if (result.Records) {
    result.Records.forEach(record => {
      genBusToVATMapping[record.Code] = record.Def_VATBusPostingGroup;
    });
    
    // Populate dropdown
    populateDropdown('genBusPostingGroup', result.Records, 'Code', 'Description');
  }
}

// When Gen. Bus. Posting Group changes
document.getElementById('genBusPostingGroup').addEventListener('change', function() {
  const selectedCode = this.value;
  const defaultVAT = genBusToVATMapping[selectedCode];
  
  if (defaultVAT) {
    const vatDropdown = document.getElementById('vatBusPostingGroup');
    // Set the value if it exists in dropdown
    if (Array.from(vatDropdown.options).some(opt => opt.value === defaultVAT)) {
      vatDropdown.value = defaultVAT;
    }
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

## Localization & Field Captions

### Language Support
All field labels must be retrieved from Business Central in the user's selected language using the `Help.Fields.Get` API message type. All UI constants (buttons, section headers, messages, placeholders) must also be translatable to support multiple languages.

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
  'mobilePhone': 'Mobile Phone No.',
  'email': 'E-Mail',
  'homePage': 'Home Page',
  'customerPostingGroup': 'Customer Posting Group',
  'genBusPostingGroup': 'Gen. Bus. Posting Group',
  'vatBusPostingGroup': 'VAT Bus. Posting Group',
  'paymentTerms': 'Payment Terms Code',
  'currency': 'Currency Code',
  'paymentMethod': 'Payment Method Code',
  'salesperson': 'Salesperson Code',
  'location': 'Location Code',
  'language': 'Language Code',
  'creditLimit': 'Credit Limit (LCY)',
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

### UI Translations
All UI constants must be stored in a translations object that supports multiple languages. The active language should match the user's Business Central language setting.

```javascript
// Translation constants for UI elements
const TRANSLATIONS = {
  'en-US': {
    // Form sections
    sectionIdentification: 'Customer Identification',
    sectionAddress: 'Address Information',
    sectionContact: 'Contact Information',
    sectionPosting: 'Posting Configuration',
    sectionPayment: 'Payment Information',
    sectionSales: 'Sales Configuration',
    sectionCredit: 'Credit Management',
    sectionTax: 'Tax Information',
    sectionMedia: 'Customer Image',
    
    // Form heading
    formTitle: 'Create New Customer',
    
    // Buttons
    btnCreate: 'Create Customer',
    btnCancel: 'Cancel',
    
    // Dropdown placeholders
    dropdownSelect: '-- Select --',
    dropdownNotBlocked: '-- Not Blocked --',
    dropdownLCY: '-- LCY --',
    
    // Messages
    msgLoading: 'Loading form data...',
    msgCreating: 'Creating customer...',
    msgSuccess: 'Customer {0} created successfully!',
    msgErrorGeneric: 'An error occurred while creating the customer.',
    msgErrorFailed: 'Failed to create customer: {0}',
    msgErrorLoadFailed: 'Failed to load form data. Please refresh the page.',
    msgCancelConfirm: 'Are you sure you want to cancel? All entered data will be lost.',
    
    // Validation messages
    valRequired: '{0} is required',
    valInvalidEmail: 'Invalid email format',
    valInvalidKennitala: 'Invalid Kennitala check digit',
    valMust10Digits: 'Must be 10 digits',
    valNonNegative: 'Must be a non-negative number',
    valFixErrors: 'Please fix the following errors:',
    
    // Blocked options
    blockedShip: 'Ship',
    blockedInvoice: 'Invoice',
    blockedAll: 'All',
    
    // Upload
    uploadImage: 'Upload Image'
  },
  'is-IS': {
    // Icelandic translations
    sectionIdentification: 'Auðkenning viðskiptamanns',
    sectionAddress: 'Heimilisfangsupplýsingar',
    sectionContact: 'Tengiliðaupplýsingar',
    sectionPosting: 'Bókunarstillingar',
    sectionPayment: 'Greiðsluupplýsingar',
    sectionSales: 'Sölustillingar',
    sectionCredit: 'Lánsfjárstjórnun',
    sectionTax: 'Skattur',
    sectionMedia: 'Mynd viðskiptamanns',
    
    formTitle: 'Búa til nýjan viðskiptamann',
    
    btnCreate: 'Búa til viðskiptamann',
    btnCancel: 'Hætta við',
    
    dropdownSelect: '-- Velja --',
    dropdownNotBlocked: '-- Ekki læst --',
    dropdownLCY: '-- SGM --',
    
    msgLoading: 'Hleð inn gögnum...',
    msgCreating: 'Búa til viðskiptamann...',
    msgSuccess: 'Viðskiptamaður {0} búinn til!',
    msgErrorGeneric: 'Villa kom upp við að búa til viðskiptamann.',
    msgErrorFailed: 'Mistókst að búa til viðskiptamann: {0}',
    msgErrorLoadFailed: 'Mistókst að hlaða inn gögnum. Vinsamlegast endurnýjaðu síðuna.',
    msgCancelConfirm: 'Ertu viss um að þú viljir hætta við? Öll gögn tapast.',
    
    valRequired: '{0} er nauðsynlegt',
    valInvalidEmail: 'Ógilt tölvupóstfang',
    valInvalidKennitala: 'Ógild kennitala',
    valMust10Digits: 'Verður að vera 10 tölustafir',
    valNonNegative: 'Verður að vera jákvæð tala',
    valFixErrors: 'Vinsamlegast lagaðu eftirfarandi villur:',
    
    blockedShip: 'Afhending',
    blockedInvoice: 'Reikningur',
    blockedAll: 'Allt',
    
    uploadImage: 'Hlaða upp mynd'
  }
  // Add more languages as needed
};

// Current language (should match BC user's language)
let currentLanguage = 'en-US';

// Get translated text
function t(key, ...args) {
  const translation = TRANSLATIONS[currentLanguage]?.[key] || TRANSLATIONS['en-US']?.[key] || key;
  
  // Replace placeholders {0}, {1}, etc. with arguments
  return translation.replace(/\{(\d+)\}/g, (match, index) => {
    return args[index] !== undefined ? args[index] : match;
  });
}

// Apply UI translations to the form
function applyUITranslations() {
  // Section legends
  const sections = [
    { selector: '#customerCreateForm fieldset:nth-of-type(1) legend', key: 'sectionIdentification', prefix: '1. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(2) legend', key: 'sectionAddress', prefix: '2. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(3) legend', key: 'sectionContact', prefix: '3. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(4) legend', key: 'sectionPosting', prefix: '4. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(5) legend', key: 'sectionPayment', prefix: '5. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(6) legend', key: 'sectionSales', prefix: '6. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(7) legend', key: 'sectionCredit', prefix: '7. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(8) legend', key: 'sectionTax', prefix: '8. ' },
    { selector: '#customerCreateForm fieldset:nth-of-type(9) legend', key: 'sectionMedia', prefix: '9. ' }
  ];
  
  sections.forEach(section => {
    const element = document.querySelector(section.selector);
    if (element) {
      element.textContent = section.prefix + t(section.key);
    }
  });
  
  // Form heading
  const heading = document.querySelector('#customerCreateForm h2');
  if (heading) {
    heading.textContent = t('formTitle');
  }
  
  // Buttons
  const btnCreate = document.getElementById('btnCreateCustomer');
  if (btnCreate) btnCreate.textContent = t('btnCreate');
  
  const btnCancel = document.getElementById('btnCancel');
  if (btnCancel) btnCancel.textContent = t('btnCancel');
  
  // Dropdown placeholders
  updateDropdownPlaceholder('customerPostingGroup', 'dropdownSelect');
  updateDropdownPlaceholder('genBusPostingGroup', 'dropdownSelect');
  updateDropdownPlaceholder('vatBusPostingGroup', 'dropdownSelect');
  updateDropdownPlaceholder('paymentTerms', 'dropdownSelect');
  updateDropdownPlaceholder('currency', 'dropdownLCY');
  updateDropdownPlaceholder('paymentMethod', 'dropdownSelect');
  updateDropdownPlaceholder('salesperson', 'dropdownSelect');
  updateDropdownPlaceholder('location', 'dropdownSelect');
  updateDropdownPlaceholder('language', 'dropdownSelect');
  
  // Blocked dropdown options
  const blockedDropdown = document.getElementById('blocked');
  if (blockedDropdown && blockedDropdown.options.length > 0) {
    blockedDropdown.options[0].text = t('dropdownNotBlocked');
    blockedDropdown.options[1].text = t('blockedShip');
    blockedDropdown.options[2].text = t('blockedInvoice');
    blockedDropdown.options[3].text = t('blockedAll');
  }
  
  // Image upload label
  const imageLabel = document.querySelector('label[for="customerImage"]');
  if (imageLabel) {
    imageLabel.textContent = t('uploadImage');
  }
}

function updateDropdownPlaceholder(dropdownId, translationKey) {
  const dropdown = document.getElementById(dropdownId);
  if (dropdown && dropdown.options.length > 0) {
    dropdown.options[0].text = t(translationKey);
  }
}

// Detect language from BC or browser
function detectLanguage() {
  // Try to get language from BC session or user preferences
  // For now, use browser language as fallback
  const browserLang = navigator.language || navigator.userLanguage;
  
  // Map browser language to supported languages
  if (browserLang.startsWith('is')) {
    currentLanguage = 'is-IS';
  } else {
    currentLanguage = 'en-US';
  }
  
  // TODO: Override with BC user's language setting if available
}
```

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
      const result = await cePost('Data.Records.Get', {
        TableNo: 225,
        Filters: [{ FieldNo: 1, Value: postCode }]
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

### Functional Testing
- [ ] Form loads with all dropdowns populated
- [ ] Registration Number validation shows ✓/✗ indicator
- [ ] Invalid Kennitala rejected with clear error message
- [ ] Valid Kennitala auto-populates Customer Number
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
- [ ] Large image files handled appropriately
- [ ] Network errors handled with user-friendly messages
- [ ] Duplicate customer number handled by BC (should show error)

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
