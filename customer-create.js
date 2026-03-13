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
  'customer-tax-liable': 'TaxLiable',
  'customer-image': 'Image'
};

// Translation constants for UI elements
const CUSTOMER_CREATE_TRANSLATIONS = {
  'en-US': {
    sectionIdentification: 'Customer Identification',
    sectionAddress: 'Address Information',
    sectionContact: 'Contact Information',
    sectionPosting: 'Posting Configuration',
    sectionPayment: 'Payment Information',
    sectionSales: 'Sales Configuration',
    sectionCredit: 'Credit Management',
    sectionTax: 'Tax Information',
    sectionMedia: 'Customer Image',
    formTitle: 'Create New Customer',
    btnCreate: 'Create Customer',
    btnCancel: 'Cancel',
    dropdownSelect: '-- Select --',
    dropdownNotBlocked: '-- Not Blocked --',
    dropdownLCY: '-- LCY --',
    msgLoading: 'Loading form data...',
    msgCreating: 'Creating customer...',
    msgSuccess: 'Customer {0} created successfully!',
    msgErrorGeneric: 'An error occurred while creating the customer.',
    msgErrorFailed: 'Failed to create customer: {0}',
    msgErrorLoadFailed: 'Failed to load form data. Please refresh the page.',
    msgCancelConfirm: 'Are you sure you want to cancel? All entered data will be lost.',
    valRequired: '{0} is required',
    valInvalidEmail: 'Invalid email format',
    valInvalidKennitala: 'Invalid Kennitala check digit',
    valMust10Digits: 'Must be 10 digits',
    valNonNegative: 'Must be a non-negative number',
    valFixErrors: 'Please fix the following errors:',
    blockedShip: 'Ship',
    blockedInvoice: 'Invoice',
    blockedAll: 'All',
    uploadImage: 'Upload Image'
  },
  'is-IS': {
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
};

// Storage for Gen. Bus. Posting Group to VAT mapping
let genBusToVATMapping = {};

// =============================
// TRANSLATION HELPER
// =============================

function tCustomer(key, ...args) {
  const lang = selectedLcid || 'en-US';
  const translation = CUSTOMER_CREATE_TRANSLATIONS[lang]?.[key] || 
                     CUSTOMER_CREATE_TRANSLATIONS['en-US']?.[key] || 
                     key;
  
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
    return { valid: false, error: tCustomer('valMust10Digits') };
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
    return { valid: false, error: tCustomer('valInvalidKennitala') };
  }
  
  return { valid: true };
}

function validateEmail(email) {
  if (!email) return { valid: true }; // Optional field
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) 
    ? { valid: true } 
    : { valid: false, error: tCustomer('valInvalidEmail') };
}

function validateCreditLimit(value) {
  if (!value) return { valid: true }; // Optional field
  const num = parseFloat(value);
  if (isNaN(num) || num < 0) {
    return { valid: false, error: tCustomer('valNonNegative') };
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
    errors.push(tCustomer('valRequired', getFieldCaption('customer-registration-no')));
  } else {
    const validation = validateIcelandicKennitala(regNo);
    if (!validation.valid) {
      errors.push(getFieldCaption('customer-registration-no') + ': ' + validation.error);
    }
  }
  
  // Customer Name
  if (!document.getElementById('customer-name').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('customer-name')));
  }
  
  // Post Code
  if (!document.getElementById('customer-post-code').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('customer-post-code')));
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
    errors.push(tCustomer('valRequired', getFieldCaption('customer-posting-group')));
  }
  if (!document.getElementById('customer-gen-bus-posting-group').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('customer-gen-bus-posting-group')));
  }
  if (!document.getElementById('customer-vat-bus-posting-group').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('customer-vat-bus-posting-group')));
  }
  
  // Payment Terms
  if (!document.getElementById('customer-payment-terms').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('customer-payment-terms')));
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
    toast(tCustomer('valFixErrors') + '\n\n' + errors.join('\n'), 'error');
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

function populateCustomerDropdown(dropdownId, records, valueField, textField) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  
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

function updateDropdownPlaceholder(dropdownId, translationKey) {
  const dropdown = document.getElementById(dropdownId);
  if (dropdown && dropdown.options.length > 0) {
    dropdown.options[0].text = tCustomer(translationKey);
  }
}

// =============================
// DATA LOADING FUNCTIONS
// =============================

async function loadCustomerFieldCaptions() {
  try {
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

async function loadCustomerPostingGroups() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Customer Posting Group' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-posting-group', result.result, 'code', 'description');
  }
}

async function loadGenBusPostingGroups() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Gen. Business Posting Group' })
  });
  
  if (result.result && result.result.length > 0) {
    // Store mapping for auto-population
    genBusToVATMapping = {};
    result.result.forEach(record => {
      if (record.def_VATBusPostingGroup) {
        genBusToVATMapping[record.code] = record.def_VATBusPostingGroup;
      }
    });
    populateCustomerDropdown('customer-gen-bus-posting-group', result.result, 'code', 'description');
  }
}

async function loadVATBusPostingGroups() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'VAT Business Posting Group' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-vat-bus-posting-group', result.result, 'code', 'description');
  }
}

async function loadPaymentTerms() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Payment Terms' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-payment-terms', result.result, 'code', 'description');
  }
}

async function loadCurrencies() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Currency' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-currency', result.result, 'code', 'description');
  }
}

async function loadPaymentMethods() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Payment Method' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-payment-method', result.result, 'code', 'description');
  }
}

async function loadSalespersons() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Salesperson/Purchaser' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-salesperson', result.result, 'code', 'name');
  }
}

async function loadLocations() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Location' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-location', result.result, 'code', 'name');
  }
}

async function loadLanguages() {
  const result = await cePost(selectedCompany.id, {
    specversion: '1.0',
    type: 'Data.Records.Get',
    source: 'BC Portal',
    data: JSON.stringify({ tableName: 'Language' })
  });
  
  if (result.result && result.result.length > 0) {
    populateCustomerDropdown('customer-language', result.result, 'code', 'name');
  }
}

// =============================
// UI TRANSLATION APPLICATION
// =============================

function applyCustomerUITranslations() {
  // Section legends
  const sections = [
    { selector: '#customer-create-form fieldset:nth-of-type(1) legend', key: 'sectionIdentification', prefix: '1. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(2) legend', key: 'sectionAddress', prefix: '2. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(3) legend', key: 'sectionContact', prefix: '3. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(4) legend', key: 'sectionPosting', prefix: '4. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(5) legend', key: 'sectionPayment', prefix: '5. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(6) legend', key: 'sectionSales', prefix: '6. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(7) legend', key: 'sectionCredit', prefix: '7. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(8) legend', key: 'sectionTax', prefix: '8. ' },
    { selector: '#customer-create-form fieldset:nth-of-type(9) legend', key: 'sectionMedia', prefix: '9. ' }
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
    heading.textContent = tCustomer('formTitle');
  }
  
  // Dropdown placeholders
  updateDropdownPlaceholder('customer-posting-group', 'dropdownSelect');
  updateDropdownPlaceholder('customer-gen-bus-posting-group', 'dropdownSelect');
  updateDropdownPlaceholder('customer-vat-bus-posting-group', 'dropdownSelect');
  updateDropdownPlaceholder('customer-payment-terms', 'dropdownSelect');
  updateDropdownPlaceholder('customer-currency', 'dropdownLCY');
  updateDropdownPlaceholder('customer-payment-method', 'dropdownSelect');
  updateDropdownPlaceholder('customer-salesperson', 'dropdownSelect');
  updateDropdownPlaceholder('customer-location', 'dropdownSelect');
  updateDropdownPlaceholder('customer-language', 'dropdownSelect');
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
  
  // Post Code lookup
  const postCodeInput = document.getElementById('customer-post-code');
  if (postCodeInput) {
    postCodeInput.addEventListener('blur', async function() {
      const postCode = this.value;
      if (!postCode) return;
      
      try {
        const result = await cePost(selectedCompany.id, {
          specversion: '1.0',
          type: 'Data.Records.Get',
          source: 'BC Portal',
          data: JSON.stringify({
            tableName: 'Post Code',
            filters: [{ fieldName: 'Code', value: postCode }]
          })
        });
        
        if (result.result && result.result.length > 0) {
          const record = result.result[0];
          document.getElementById('customer-city').value = record.city || '';
          document.getElementById('customer-country-code').value = record.country_RegionCode || '';
        }
      } catch (error) {
        console.error('Error looking up post code:', error);
        const errorDetails = error.stack || error.message;
        toast('Error looking up post code:\n' + errorDetails, 'error');
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
    toast(tCustomer('msgCreating'), 'info');
    
    // Gather form data
    const customerData = {
      registrationNumber: document.getElementById('customer-registration-no').value,
      no_: document.getElementById('customer-no').value,
      name: document.getElementById('customer-name').value,
      name2: document.getElementById('customer-name2').value || '',
      address: document.getElementById('customer-address').value || '',
      address2: document.getElementById('customer-address2').value || '',
      postCode: document.getElementById('customer-post-code').value,
      city: document.getElementById('customer-city').value,
      country_RegionCode: document.getElementById('customer-country-code').value,
      mobilePhoneNo: document.getElementById('customer-phone').value || '',
      eMail: document.getElementById('customer-email').value || '',
      contact: document.getElementById('customer-contact').value || '',
      customerPostingGroup: document.getElementById('customer-posting-group').value,
      genBusPostingGroup: document.getElementById('customer-gen-bus-posting-group').value,
      vATBusPostingGroup: document.getElementById('customer-vat-bus-posting-group').value,
      paymentTermsCode: document.getElementById('customer-payment-terms').value,
      currencyCode: document.getElementById('customer-currency').value || '',
      paymentMethodCode: document.getElementById('customer-payment-method').value || '',
      salespersonCode: document.getElementById('customer-salesperson').value || '',
      locationCode: document.getElementById('customer-location').value || '',
      languageCode: document.getElementById('customer-language').value || '',
      creditLimit_LCY_: parseFloat(document.getElementById('customer-credit-limit').value) || 0,
      taxLiable: document.getElementById('customer-tax-liable').value === 'true'
    };
    
    // Handle image upload if present
    const imageFile = document.getElementById('customer-image').files[0];
    if (imageFile) {
      const imageData = await convertImageToBase64(imageFile);
      customerData.image = {
        id: generateGuid(),
        value: imageData
      };
    }
    
    // Create customer via Cloud Events API
    const result = await cePost(selectedCompany.id, {
      specversion: '1.0',
      type: 'Data.Records.Set',
      source: 'BC Portal',
      data: JSON.stringify({
        tableName: 'Customer',
        records: [customerData]
      })
    });
    
    if (result.status !== 'Error') {
      toast(tCustomer('msgSuccess', customerData.no_), 'success');
      
      // Reset form
      resetCustomerForm();
      
      // Navigate back to customer list and reload
      showCustomers();
      if (typeof loadCustomers === 'function') {
        loadCustomers();
      }
    } else {
      toast(tCustomer('msgErrorFailed', result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('Error creating customer:', error);
    const errorDetails = error.stack || error.message;
    toast(tCustomer('msgErrorGeneric') + '\n\n' + errorDetails, 'error');
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
    toast(tCustomer('msgLoading'), 'info');
    
    // Apply UI translations
    applyCustomerUITranslations();
    
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
      loadLanguages()
    ]);
    
    // Setup event listeners
    setupCustomerEventListeners();
    
    toast('Form ready', 'success');
  } catch (error) {
    console.error('Error initializing form:', error);
    const errorDetails = error.stack || error.message;
    toast(tCustomer('msgErrorLoadFailed') + ':\n\n' + errorDetails, 'error');
  }
}

// Navigation function
function showCreateCustomer() {
  show('view-create-customer');
  initCustomerCreateForm();
}
