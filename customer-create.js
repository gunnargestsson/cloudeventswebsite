// Customer Creation Module
// Implementation follows specification in implementations/requirement-1-customer-creation/SPECIFICATION.md

// =============================
// CONFIGURATION & CONSTANTS
// =============================

// Map HTML element IDs to BC field names for Customer table (18)
const CUSTOMER_FIELD_MAPPING = {
  'customer-registration-no': 'RegistrationNumber',
  'customer-no': 'No_',
  'customer-name': 'Name',
  'customer-name2': 'Name2',
  'customer-address': 'Address',
  'customer-address2': 'Address2',
  'customer-post-code': 'PostCode',
  'customer-city': 'City',
  'customer-country-code': 'Country_RegionCode',
  'customer-county': 'County',
  'customer-phone': 'MobilePhoneNo',
  'customer-email': 'EMail',
  'customer-contact': 'Contact',
  'customer-posting-group': 'CustomerPostingGroup',
  'customer-gen-bus-posting-group': 'GenBusPostingGroup',
  'customer-vat-bus-posting-group': 'VATBusPostingGroup',
  'customer-payment-terms': 'PaymentTermsCode',
  'customer-currency': 'CurrencyCode',
  'customer-payment-method': 'PaymentMethodCode',
  'customer-salesperson': 'SalespersonCode',
  'customer-location': 'LocationCode',
  'customer-language': 'LanguageCode',
  'customer-credit-limit': 'CreditLimit_LCY_',
  'customer-image': 'Image'
};

// Storage for Gen. Bus. Posting Group to VAT mapping
let genBusToVATMapping = {};

// Storage for Post Code records (for auto-populating City, County, Country/Region)
let postCodeRecords = [];

// Field metadata cache for dropdown tables
const fieldMetadataCache = {};

// Table ID mappings for dropdown data
const DROPDOWN_TABLE_IDS = {
  'Payment Terms': 3,
  'Currency': 4,
  'Language': 8,
  'Salesperson/Purchaser': 13,
  'Location': 14,
  'Customer Posting Group': 92,
  'Post Code': 225,
  'Gen. Business Posting Group': 250,
  'Payment Method': 289,
  'VAT Business Posting Group': 323
};

// =============================
// TRANSLATION HELPER
// =============================

// Use global t() function from index.html for translations
// Translations are loaded from Cloud Events Translation table
function tCustomer(key, ...args) {
  // Use the global t() function for translation lookup
  const translation = (typeof t === 'function') ? t(key) : key;
  
  // Replace placeholders {0}, {1}, etc. with arguments
  return translation.replace(/\{(\d+)\}/g, (match, index) => {
    return args[index] !== undefined ? args[index] : match;
  });
}

// =============================
// VALIDATION FUNCTIONS
// =============================

function validateIcelandicKennitala(kennitala) {
  // Must be exactly 10 digits
  if (!/^\d{10}$/.test(kennitala)) {
    return { valid: false, error: tCustomer('Must be 10 digits') };
  }
  
  // Extract first 8 digits and 9th digit (check digit)
  const digits = kennitala.substring(0, 8).split('').map(Number);
  const checkDigit = parseInt(kennitala[8], 10);
  
  // Weights for first 8 digits
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  
  // Calculate sum
  const sum = digits.reduce((acc, digit, index) => acc + (digit * weights[index]), 0);
  
  // Calculate expected check digit: 11 - (sum mod 11)
  // If result is 11, check digit should be 0
  let expectedCheckDigit = 11 - (sum % 11);
  if (expectedCheckDigit === 11) {
    expectedCheckDigit = 0;
  }
  
  // Validate
  if (checkDigit !== expectedCheckDigit) {
    return { valid: false, error: tCustomer('Invalid Registration No. check digit') };
  }
  
  return { valid: true };
}

function validateEmail(email) {
  if (!email) return { valid: true }; // Optional field
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) 
    ? { valid: true } 
    : { valid: false, error: tCustomer('Invalid email format') };
}

function validateCreditLimit(value) {
  if (!value) return { valid: true }; // Optional field
  const num = parseFloat(value);
  if (isNaN(num) || num < 0) {
    return { valid: false, error: tCustomer('Must be a non-negative number') };
  }
  return { valid: true };
}

function validateCustomerForm() {
  const errors = [];
  
  // Get field captions for error messages
  const getFieldCaption = (elementId) => {
    const label = document.querySelector(`label[for="${elementId}"]`);
    return label ? label.textContent.replace(' *', '').trim() : elementId;
  };
  
  // Registration Number
  const regNo = document.getElementById('customer-registration-no').value;
  if (!regNo) {
    errors.push(tCustomer('{0} is required', getFieldCaption('customer-registration-no')));
  } else {
    const validation = validateIcelandicKennitala(regNo);
    if (!validation.valid) {
      errors.push(getFieldCaption('customer-registration-no') + ': ' + validation.error);
    }
  }
  
  // Customer Name
  if (!document.getElementById('customer-name').value) {
    errors.push(tCustomer('{0} is required', getFieldCaption('customer-name')));
  }
  
  // Post Code
  if (!document.getElementById('customer-post-code').value) {
    errors.push(tCustomer('{0} is required', getFieldCaption('customer-post-code')));
  }
  
  // Email validation
  const email = document.getElementById('customer-email').value;
  if (email) {
    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      errors.push(getFieldCaption('customer-email') + ': ' + emailValidation.error);
    }
  }
  
  // Posting Groups
  if (!document.getElementById('customer-posting-group').value) {
    errors.push(tCustomer('{0} is required', getFieldCaption('customer-posting-group')));
  }
  if (!document.getElementById('customer-gen-bus-posting-group').value) {
    errors.push(tCustomer('{0} is required', getFieldCaption('customer-gen-bus-posting-group')));
  }
  if (!document.getElementById('customer-vat-bus-posting-group').value) {
    errors.push(tCustomer('{0} is required', getFieldCaption('customer-vat-bus-posting-group')));
  }
  
  // Payment Terms
  if (!document.getElementById('customer-payment-terms').value) {
    errors.push(tCustomer('{0} is required', getFieldCaption('customer-payment-terms')));
  }
  
  // Credit Limit
  const creditLimit = document.getElementById('customer-credit-limit').value;
  if (creditLimit) {
    const creditValidation = validateCreditLimit(creditLimit);
    if (!creditValidation.valid) {
      errors.push(getFieldCaption('customer-credit-limit') + ': ' + creditValidation.error);
    }
  }
  
  // Display errors if any
  if (errors.length > 0) {
    toast(tCustomer('Please fix the following errors:') + '\n\n' + errors.join('\n'), 'error');
    return false;
  }
  
  return true;
}

// =============================
// HELPER FUNCTIONS
// =============================

function generateGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

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

// Get field numbers for dropdown tables using Help.Fields.Get
async function getDropdownFieldNumbers(tableName, ...fieldNames) {
  // Check cache first
  if (fieldMetadataCache[tableName]) {
    const fields = fieldMetadataCache[tableName];
    return fieldNames.map(name => {
      const field = fields.find(f => f.fieldName.toLowerCase() === name.toLowerCase());
      return field ? field.id : null;
    }).filter(id => id !== null);
  }
  
  // Fetch field metadata from BC
  try {
    const result = await cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Help.Fields.Get',
      source: 'BC Portal',
      data: JSON.stringify({ tableName })
    });
    
    if (result.result) {
      // Cache the metadata
      fieldMetadataCache[tableName] = result.result;
      
      // Find field numbers for requested field names
      return fieldNames.map(name => {
        const field = result.result.find(f => f.fieldName.toLowerCase() === name.toLowerCase());
        return field ? field.id : null;
      }).filter(id => id !== null);
    }
  } catch (error) {
    console.error(`Error fetching field metadata for ${tableName}:`, error);
  }
  
  return [];
}

function populateCustomerDropdown(dropdownId, records, valueField, textField) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown || !dropdown.options) return;
  
  const currentValue = dropdown.value;
  
  // Clear existing options except the first one (placeholder)
  while (dropdown.options.length > 1) {
    dropdown.remove(1);
  }
  
  // Capitalize first letter to match BC field naming convention (e.g., 'code' -> 'Code')
  const capitalizeFirst = str => str.charAt(0).toUpperCase() + str.slice(1);
  const valueFieldCap = capitalizeFirst(valueField);
  const textFieldCap = capitalizeFirst(textField);
  
  // Add new options
  records.forEach(record => {
    const option = document.createElement('option');
    
    // Try to get value from primaryKey first (for primary key fields), then from fields
    const value = (record.primaryKey && record.primaryKey[valueFieldCap]) || 
                  (record.fields && record.fields[valueFieldCap]);
    
    // Try to get text from fields first (most common), then from primaryKey
    const text = (record.fields && record.fields[textFieldCap]) || 
                 (record.primaryKey && record.primaryKey[textFieldCap]);
    
    option.value = value || '';
    
    // Handle undefined fields gracefully
    if (value && text) {
      option.textContent = `${value} - ${text}`;
    } else if (value) {
      option.textContent = value;
    } else {
      option.textContent = '(No value)';
    }
    
    dropdown.appendChild(option);
  });
  
  // Restore previous value if it still exists
  if (currentValue) {
    dropdown.value = currentValue;
  }
}

function updateDropdownPlaceholder(dropdownId, translationKey) {
  const dropdown = document.getElementById(dropdownId);
  if (dropdown && dropdown.options && dropdown.options.length > 0) {
    dropdown.options[0].text = tCustomer(translationKey);
  }
}

// =============================
// DATA LOADING FUNCTIONS
// =============================

async function loadCustomerFieldCaptions() {
  try {
    // Note: lcid is automatically added by cePost() function from selectedLcid global
    const result = await cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Help.Fields.Get',
      source: 'BC Portal',
      data: JSON.stringify({ tableName: 'Customer' })
    });
    
    if (result.result) {
      // Store captions for each field
      const fieldCaptions = {};
      result.result.forEach(field => {
        fieldCaptions[field.fieldName] = field.fieldCaption || field.fieldName;
      });
      
      // Apply captions to form labels
      Object.keys(CUSTOMER_FIELD_MAPPING).forEach(elementId => {
        const fieldName = CUSTOMER_FIELD_MAPPING[elementId];
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
    }
  } catch (error) {
    console.error('Error loading field captions:', error);
    // Fallback to English labels if caption loading fails
  }
}

// Reload customer form when language changes
async function reloadCustomerFormForLanguage() {
  const createView = document.getElementById('view-create-customer');
  if (!createView || createView.style.display === 'none') {
    return; // Form not visible, no need to reload
  }
  
  try {
    // Clear field metadata cache for Customer table to force reload with new lcid
    const cacheKey = `${selectedCompany.id}:${selectedLcid}:Customer`;
    delete fieldMetaCache[cacheKey];
    
    // Reload field captions with new language
    await loadCustomerFieldCaptions();
    
    // Re-apply UI translations for section headers, buttons, etc.
    applyCustomerUITranslations();
  } catch (error) {
    console.error('Error reloading customer form for new language:', error);
  }
}

async function loadCustomerPostingGroups() {
  // Customer Posting Group: Field 1 = Code, Field 20 = Description
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Customer Posting Group',
      fieldNumbers: [1, 20]
    })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-posting-group', result.result, 'code', 'description');
  }
}

async function loadGenBusPostingGroups() {
  // Gen. Business Posting Group: Field 1 = Code, Field 2 = Description, Field 3 = Def. VAT Bus. Posting Group
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Gen. Business Posting Group',
      fieldNumbers: [1, 2, 3]
    })
  });
  
  if (result.result && result.result.length > 0) {
    // Store mapping for auto-population
    genBusToVATMapping = {};
    result.result.forEach(record => {
      const defVAT = (record.fields && record.fields.Def_VATBusPostingGroup) ||
                     (record.fields && record.fields.DefVATBusPostingGroup);
      if (defVAT) {
        const code = (record.primaryKey && record.primaryKey.Code) || 
                     (record.fields && record.fields.Code);
        if (code) {
          genBusToVATMapping[code] = defVAT;
        }
      }
    });
    populateCustomerDropdown('customer-gen-bus-posting-group', result.result, 'code', 'description');
  }
}

async function loadVATBusPostingGroups() {
  // VAT Business Posting Group: Field 1 = Code, Field 2 = Description
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'VAT Business Posting Group',
      fieldNumbers: [1, 2]
    })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-vat-bus-posting-group', result.result, 'code', 'description');
  }
}

async function loadPaymentTerms() {
  // Payment Terms: Field 1 = Code, Field 5 = Description
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Payment Terms',
      fieldNumbers: [1, 5]
    })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-payment-terms', result.result, 'code', 'description');
  }
}

async function loadCurrencies() {
  // Currency: Field 1 = Code, Field 15 = Description
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Currency',
      fieldNumbers: [1, 15]
    })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-currency', result.result, 'code', 'description');
  }
}

async function loadPaymentMethods() {
  // Payment Method: Field 1 = Code, Field 2 = Description
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Payment Method',
      fieldNumbers: [1, 2]
    })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-payment-method', result.result, 'code', 'description');
  }
}

async function loadSalespersons() {
  // Salesperson/Purchaser: Field 1 = Code, Field 2 = Name
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Salesperson/Purchaser',
      fieldNumbers: [1, 2]
    })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-salesperson', result.result, 'code', 'name');
  }
}

async function loadLocations() {
  // Location: Field 1 = Code, Field 2 = Name
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Location',
      fieldNumbers: [1, 2]
    })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-location', result.result, 'code', 'name');
  }
}

async function loadPostCodes() {
  // Post Code: Field 1 = Code, Field 2 = City, Field 4 = Country/Region Code, Field 5 = County
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ 
      tableName: 'Post Code',
      fieldNumbers: [1, 2, 4, 5]
    })
  });
  
  if (result.result && result.result.length > 0) {
    // Store post code records for auto-population
    postCodeRecords = result.result;
    console.log('Post Code records loaded:', postCodeRecords.length);
    if (postCodeRecords.length > 0) {
      console.log('Sample post code record:', postCodeRecords[0]);
    }
    populateCustomerDropdown('customer-post-code', result.result, 'code', 'city');
  }
}

// =============================
// UI TRANSLATION APPLICATION
// =============================

function applyCustomerUITranslations() {
  // Section legends
  const sections = [
    { selector: '#customer-create-form fieldset:nth-of-type(1) legend', key: 'Identification', prefix: '1. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(2) legend', key: 'Address', prefix: '2. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(3) legend', key: 'Contact', prefix: '3. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(4) legend', key: 'Posting', prefix: '4. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(5) legend', key: 'Payment', prefix: '5. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(6) legend', key: 'Sales', prefix: '6. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(7) legend', key: 'Credit Management', prefix: '7. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(8) legend', key: 'Media', prefix: '8. ' }
  ];
  
  sections.forEach(section => {
    const element = document.querySelector(section.selector);
    if (element) {
      element.textContent = section.prefix + tCustomer(section.key);
    }
  });
  
  // Form heading
  const heading = document.querySelector('#view-create-customer .section-title span');
  if (heading) {
    heading.textContent = tCustomer('Create New Customer');
  }
  
  // Dropdown placeholders
  updateDropdownPlaceholder('customer-posting-group', '-- Select --');
  updateDropdownPlaceholder('customer-gen-bus-posting-group', '-- Select --');
  updateDropdownPlaceholder('customer-vat-bus-posting-group', '-- Select --');
  updateDropdownPlaceholder('customer-payment-terms', '-- Select --');
  updateDropdownPlaceholder('customer-currency', '-- LCY --');
  updateDropdownPlaceholder('customer-payment-method', '-- Select --');
  updateDropdownPlaceholder('customer-salesperson', '-- Select --');
  updateDropdownPlaceholder('customer-location', '-- Select --');
  updateDropdownPlaceholder('customer-language', '-- Select --');
}

// =============================
// EVENT HANDLERS
// =============================

function setupCustomerEventListeners() {
  // Registration Number validation and auto-population
  const regNoInput = document.getElementById('customer-registration-no');
  if (regNoInput) {
    regNoInput.addEventListener('input', function() {
      const regNo = this.value;
      const indicator = document.getElementById('kennitala-indicator');
      
      if (regNo.length === 10) {
        const validation = validateIcelandicKennitala(regNo);
        if (validation.valid) {
          indicator.className = 'validation-indicator valid';
          indicator.title = '';
          document.getElementById('customer-no').value = regNo;
        } else {
          indicator.className = 'validation-indicator invalid';
          indicator.title = validation.error;
        }
      } else {
        indicator.className = 'validation-indicator';
        indicator.title = '';
      }
    });
  }
  
  // Post Code auto-population
  const postCodeSelect = document.getElementById('customer-post-code');
  if (postCodeSelect) {
    postCodeSelect.addEventListener('change', function() {
      const selectedCode = this.value;
      
      console.log('Post Code changed to:', selectedCode);
      console.log('postCodeRecords array:', postCodeRecords);
      
      if (!selectedCode) {
        // Clear fields if no post code selected
        document.getElementById('customer-city').value = '';
        document.getElementById('customer-country-code').value = '';
        document.getElementById('customer-county').value = '';
        return;
      }
      
      // Find the selected post code record from cached data
      const postCodeRecord = postCodeRecords.find(record => {
        const code = (record.primaryKey && record.primaryKey.Code) || 
                     (record.fields && record.fields.Code);
        return code === selectedCode;
      });
      
      console.log('Found post code record:', postCodeRecord);
      
      if (postCodeRecord) {
        console.log('Record structure - primaryKey:', postCodeRecord.primaryKey);
        console.log('Record structure - fields:', postCodeRecord.fields);
        
        // Auto-populate City (field 2)
        const city = (postCodeRecord.fields && postCodeRecord.fields.City) || '';
        console.log('City value:', city);
        document.getElementById('customer-city').value = city;
        
        // Auto-populate Country/Region Code (field 4)
        const countryCode = (postCodeRecord.fields && postCodeRecord.fields.Country_RegionCode) || 
                            (postCodeRecord.fields && postCodeRecord.fields.CountryRegionCode) || '';
        console.log('Country code value:', countryCode);
        document.getElementById('customer-country-code').value = countryCode;
        
        // Auto-populate County (field 5)
        const county = (postCodeRecord.fields && postCodeRecord.fields.County) || '';
        console.log('County value:', county);
        document.getElementById('customer-county').value = county;
      } else {
        console.log('Post code record not found in cache');
      }
    });
  }
  
  // Gen. Bus. Posting Group auto-population of VAT
  const genBusSelect = document.getElementById('customer-gen-bus-posting-group');
  if (genBusSelect) {
    genBusSelect.addEventListener('change', function() {
      const selectedCode = this.value;
      const defaultVAT = genBusToVATMapping[selectedCode];
      
      if (defaultVAT) {
        const vatInput = document.getElementById('customer-vat-bus-posting-group');
        if (vatInput) {
          vatInput.value = defaultVAT;
        }
      }
    });
  }
  
  // Image preview
  const imageInput = document.getElementById('customer-image');
  if (imageInput) {
    imageInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = function(e) {
          document.getElementById('imagePreview').innerHTML = 
            `<img src="${e.target.result}" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-top: 10px;">`;
        };
        reader.readAsDataURL(file);
      }
    });
  }
  
  // Form submit handler
  const form = document.getElementById('customer-create-form');
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      handleCreateCustomer();
    });
  }
}

// =============================
// FORM SUBMISSION
// =============================

async function handleCreateCustomer() {
  try {
    // Validate required fields
    if (!validateCustomerForm()) {
      return;
    }
    
    // Show loading
    toast(tCustomer('Creating customer...'), 'info');
    
    // Gather form data - separate primary key from other fields
    const primaryKey = {
      No_: document.getElementById('customer-no').value
    };
    
    const fields = {
      RegistrationNumber: document.getElementById('customer-registration-no').value,
      Name: document.getElementById('customer-name').value,
      Name2: document.getElementById('customer-name2').value || '',
      Address: document.getElementById('customer-address').value || '',
      Address2: document.getElementById('customer-address2').value || '',
      PostCode: document.getElementById('customer-post-code').value,
      City: document.getElementById('customer-city').value,
      Country_RegionCode: document.getElementById('customer-country-code').value,
      County: document.getElementById('customer-county').value || '',
      MobilePhoneNo: document.getElementById('customer-phone').value || '',
      EMail: document.getElementById('customer-email').value || '',
      Contact: document.getElementById('customer-contact').value || '',
      CustomerPostingGroup: document.getElementById('customer-posting-group').value,
      GenBusPostingGroup: document.getElementById('customer-gen-bus-posting-group').value,
      VATBusPostingGroup: document.getElementById('customer-vat-bus-posting-group').value,
      PaymentTermsCode: document.getElementById('customer-payment-terms').value,
      CurrencyCode: document.getElementById('customer-currency').value || '',
      PaymentMethodCode: document.getElementById('customer-payment-method').value || '',
      SalespersonCode: document.getElementById('customer-salesperson').value || '',
      LocationCode: document.getElementById('customer-location').value || '',
      LanguageCode: document.getElementById('customer-language').value || '',
      CreditLimit_LCY_: String(parseFloat(document.getElementById('customer-credit-limit').value) || 0)
    };
    
    // Handle image upload if present
    const imageFile = document.getElementById('customer-image').files[0];
    if (imageFile) {
      const imageData = await convertImageToBase64(imageFile);
      fields.Image = {
        id: generateGuid(),
        value: imageData
      };
    }
    
    // Create customer via Cloud Events API
    const result = await cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Data.Records.Set',
      source: 'BC Portal',
      subject: 'Customer',
      data: JSON.stringify({
        data: [{
          primaryKey: primaryKey,
          fields: fields
        }]
      })
    });
    
    if (result.status !== 'Error') {
      toast(tCustomer('Customer {0} created successfully!', primaryKey.No_), 'success');
      
      // Reset form
      resetCustomerForm();
      
      // Navigate back to customer list and reload
      showCustomers();
      if (typeof loadCustomers === 'function') {
        loadCustomers();
      }
    } else {
      toast(tCustomer('Failed to create customer: {0}', result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('Error creating customer:', error);
    const errorDetails = error.stack || error.message;
    toast(tCustomer('An error occurred while creating the customer.') + '\n\n' + errorDetails, 'error');
  }
}

function resetCustomerForm() {
  const form = document.getElementById('customer-create-form');
  if (form) {
    form.reset();
  }
  document.getElementById('imagePreview').innerHTML = '';
  const indicator = document.getElementById('kennitala-indicator');
  if (indicator) {
    indicator.className = 'validation-indicator';
    indicator.title = '';
  }
}

// =============================
// INITIALIZATION
// =============================

async function initCustomerCreateForm() {
  try {
    if (!selectedCompany) {
      toast('Please select a company first', 'error');
      showCompanies();
      return;
    }
    
    // Show loading
    toast(tCustomer('Loading form data...'), 'info');
    
    // Apply UI translations
    applyCustomerUITranslations();
    
    // Populate language dropdown from global allLanguages
    if (allLanguages && allLanguages.length > 0) {
      populateCustomerDropdown('customer-language', allLanguages, 'code', 'name');
    }
    
    // Load field captions and lookup tables in parallel
    await Promise.all([
      loadCustomerFieldCaptions(),
      loadCustomerPostingGroups(),
      loadGenBusPostingGroups(),
      loadVATBusPostingGroups(),
      loadPaymentTerms(),
      loadCurrencies(),
      loadPaymentMethods(),
      loadSalespersons(),
      loadLocations(),
      loadPostCodes()
    ]);
    
    // Setup event listeners
    setupCustomerEventListeners();
    
    toast('Form ready', 'success');
  } catch (error) {
    console.error('Error initializing form:', error);
    const errorDetails = error.stack || error.message;
    toast(tCustomer('Failed to load form data. Please refresh the page.') + ':\n\n' + errorDetails, 'error');
  }
}

// Navigation function
function showCreateCustomer() {
  show('view-create-customer');
  initCustomerCreateForm();
}
