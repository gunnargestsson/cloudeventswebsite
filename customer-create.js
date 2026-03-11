// Customer Creation Module
// Implementation follows specification in implementations/requirement-1-customer-creation/SPECIFICATION.md

// =============================
// CONFIGURATION & CONSTANTS
// =============================

// Map HTML element IDs to BC field names for Customer table (18)
const CUSTOMER_FIELD_MAPPING = {
  'registrationNumber': 'RegistrationNumber',
  'customerNo': 'No_',
  'name': 'Name',
  'searchName': 'SearchName',
  'address': 'Address',
  'address2': 'Address2',
  'postCode': 'PostCode',
  'city': 'City',
  'countryRegion': 'Country_RegionCode',
  'mobilePhone': 'MobilePhoneNo',
  'email': 'EMail',
  'homePage': 'HomePage',
  'customerPostingGroup': 'CustomerPostingGroup',
  'genBusPostingGroup': 'GenBusPostingGroup',
  'vatBusPostingGroup': 'VATBusPostingGroup',
  'paymentTerms': 'PaymentTermsCode',
  'currency': 'CurrencyCode',
  'paymentMethod': 'PaymentMethodCode',
  'salesperson': 'SalespersonCode',
  'location': 'LocationCode',
  'language': 'LanguageCode',
  'creditLimit': 'CreditLimit_LCY_',
  'blocked': 'Blocked',
  'vatRegistrationNo': 'VATRegistrationNo'
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
  const regNo = document.getElementById('registrationNumber').value;
  if (!regNo) {
    errors.push(tCustomer('valRequired', getFieldCaption('registrationNumber')));
  } else {
    const validation = validateIcelandicKennitala(regNo);
    if (!validation.valid) {
      errors.push(getFieldCaption('registrationNumber') + ': ' + validation.error);
    }
  }
  
  // Customer Name
  if (!document.getElementById('name').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('name')));
  }
  
  // Post Code
  if (!document.getElementById('postCode').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('postCode')));
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
    errors.push(tCustomer('valRequired', getFieldCaption('customerPostingGroup')));
  }
  if (!document.getElementById('genBusPostingGroup').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('genBusPostingGroup')));
  }
  if (!document.getElementById('vatBusPostingGroup').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('vatBusPostingGroup')));
  }
  
  // Payment Terms
  if (!document.getElementById('paymentTerms').value) {
    errors.push(tCustomer('valRequired', getFieldCaption('paymentTerms')));
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
    populateCustomerDropdown('customerPostingGroup', result.result, 'code', 'description');
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
    populateCustomerDropdown('genBusPostingGroup', result.result, 'code', 'description');
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
    populateCustomerDropdown('vatBusPostingGroup', result.result, 'code', 'description');
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
    populateCustomerDropdown('paymentTerms', result.result, 'code', 'description');
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
    populateCustomerDropdown('currency', result.result, 'code', 'description');
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
    populateCustomerDropdown('paymentMethod', result.result, 'code', 'description');
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
    populateCustomerDropdown('salesperson', result.result, 'code', 'name');
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
    populateCustomerDropdown('location', result.result, 'code', 'name');
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
    populateCustomerDropdown('language', result.result, 'code', 'name');
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
  
  // Buttons
  const btnCreate = document.getElementById('btnCreateCustomer');
  if (btnCreate) btnCreate.textContent = tCustomer('btnCreate');
  
  const btnCancel = document.getElementById('btnCancelCustomer');
  if (btnCancel) btnCancel.textContent = tCustomer('btnCancel');
  
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
    blockedDropdown.options[0].text = tCustomer('dropdownNotBlocked');
    if (blockedDropdown.options[1]) blockedDropdown.options[1].text = tCustomer('blockedShip');
    if (blockedDropdown.options[2]) blockedDropdown.options[2].text = tCustomer('blockedInvoice');
    if (blockedDropdown.options[3]) blockedDropdown.options[3].text = tCustomer('blockedAll');
  }
}

// =============================
// EVENT HANDLERS
// =============================

function setupCustomerEventListeners() {
  // Registration Number validation and auto-population
  document.getElementById('registrationNumber').addEventListener('input', function() {
    const regNo = this.value;
    const indicator = document.getElementById('regNoIndicator');
    
    if (regNo.length === 10) {
      const validation = validateIcelandicKennitala(regNo);
      if (validation.valid) {
        indicator.className = 'validation-indicator valid';
        indicator.title = '';
        document.getElementById('customerNo').value = regNo;
      } else {
        indicator.className = 'validation-indicator invalid';
        indicator.title = validation.error;
      }
    } else {
      indicator.className = 'validation-indicator';
      indicator.title = '';
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
          filters: [{ fieldName: 'Code', value: postCode }]
        })
      });
      
      if (result.result && result.result.length > 0) {
        const record = result.result[0];
        document.getElementById('city').value = record.city || '';
        document.getElementById('countryRegion').value = record.country_RegionCode || '';
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
  
  // Cancel button
  document.getElementById('btnCancelCustomer').addEventListener('click', function() {
    if (confirm(tCustomer('msgCancelConfirm'))) {
      resetCustomerForm();
      showCustomers();
    }
  });
  
  // Create button
  document.getElementById('btnCreateCustomer').addEventListener('click', handleCreateCustomer);
  
  // Image preview
  const imageInput = document.getElementById('customerImage');
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
      registrationNumber: document.getElementById('registrationNumber').value,
      no_: document.getElementById('customerNo').value,
      name: document.getElementById('name').value,
      searchName: document.getElementById('searchName').value || '',
      address: document.getElementById('address').value || '',
      address2: document.getElementById('address2').value || '',
      postCode: document.getElementById('postCode').value,
      city: document.getElementById('city').value,
      country_RegionCode: document.getElementById('countryRegion').value,
      mobilePhoneNo: document.getElementById('mobilePhone').value || '',
      eMail: document.getElementById('email').value || '',
      homePage: document.getElementById('homePage').value || '',
      customerPostingGroup: document.getElementById('customerPostingGroup').value,
      genBusPostingGroup: document.getElementById('genBusPostingGroup').value,
      vATBusPostingGroup: document.getElementById('vatBusPostingGroup').value,
      paymentTermsCode: document.getElementById('paymentTerms').value,
      currencyCode: document.getElementById('currency').value || '',
      paymentMethodCode: document.getElementById('paymentMethod').value || '',
      salespersonCode: document.getElementById('salesperson').value || '',
      locationCode: document.getElementById('location').value || '',
      languageCode: document.getElementById('language').value || '',
      creditLimit_LCY_: parseFloat(document.getElementById('creditLimit').value) || 0,
      blocked: document.getElementById('blocked').value || '',
      vATRegistrationNo: document.getElementById('vatRegistrationNo').value || ''
    };
    
    // Handle image upload if present
    const imageFile = document.getElementById('customerImage').files[0];
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
    toast(tCustomer('msgErrorGeneric') + '\n' + error.message, 'error');
  }
}

function resetCustomerForm() {
  const form = document.getElementById('customer-create-form');
  if (form) {
    form.reset();
  }
  document.getElementById('imagePreview').innerHTML = '';
  const indicator = document.getElementById('regNoIndicator');
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
    toast(tCustomer('msgErrorLoadFailed'), 'error');
  }
}

// Navigation function
function showCreateCustomer() {
  show('view-create-customer');
  initCustomerCreateForm();
}
