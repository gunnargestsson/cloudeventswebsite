# Requirement 7: Global Connection Settings

## Overview

Centralise BC connection parameters in `localStorage` so that entering credentials once is enough for all pages. Currently every page (`bc-metadata-explorer.html`, `bc-cloud-events-explorer.html`, `sales-assistant.html`) has its own independent config form with no persistence. This requirement introduces:

1. **`settings.js`** — reusable module that reads/writes `localStorage` and exposes helper functions used by every page.
2. **`/api/companies`** — new Azure Function that accepts client-provided credentials via `x-bc-*` headers and returns the list of BC companies, enabling a company-name dropdown instead of a raw GUID input.
3. **Updated developer-tool pages** — replace each page's isolated config form with a shared settings panel driven by `settings.js`.
4. **Global UI translation** — every page uses the same `t()` / `applyUiTranslations()` pattern, backed by the `Cloud Event Translation` BC table, so all UI constants and field captions can be translated from Business Central in one place.
5. **Partial update to `index.html`** — sync the active LCID and selected company with localStorage so the language selection is consistent when the user navigates between the main portal and the developer tools.

---

## localStorage Key Schema

All keys are prefixed `bc_portal_` to avoid collisions.

| Key | Type | Source | Notes |
|-----|------|--------|-------|
| `bc_portal_tenant` | string | User input / `/api/config` | Tenant hostname e.g. `dynamics.is` |
| `bc_portal_env` | string | User input / `/api/config` | BC environment e.g. `Production` |
| `bc_portal_client_id` | string | User input / `/api/config` | Azure App Registration client ID (GUID) |
| `bc_portal_client_secret` | string | User input only | Never pre-filled from server; stored only after explicit user action |
| `bc_portal_company_id` | string | Company dropdown | Selected company GUID |
| `bc_portal_company_name` | string | Company dropdown | Selected company display name (for UI) |
| `bc_portal_lcid` | string | Language dropdown | Windows Language ID e.g. `"1033"` |

---

## `settings.js` — Shared Module

New static file served alongside the HTML pages. Include on every developer-tool page:

```html
<script src="settings.js"></script>
```

### Public API

```js
/**
 * Read all bc_portal_* keys from localStorage.
 * Returns an object with camelCase field names.
 */
function bcSettingsLoad()
// → { tenant, env, clientId, clientSecret, companyId, companyName, lcid }

/**
 * Write a partial or full settings object to localStorage.
 * Only keys present in the argument are written; others are untouched.
 */
function bcSettingsSave({ tenant, env, clientId, clientSecret, companyId, companyName, lcid })

/**
 * Remove all bc_portal_* keys from localStorage.
 */
function bcSettingsClear()

/**
 * Returns true when the five fields required to make BC API calls are all present:
 * tenant, env, clientId, clientSecret, companyId.
 */
function bcSettingsReady()
// → boolean

/**
 * Build the x-bc-* header object for fetch() calls to /api/explorer or /api/companies.
 * Returns null and logs a warning when bcSettingsReady() is false.
 */
function bcSettingsHeaders()
// → { 'x-bc-tenant', 'x-bc-client-id', 'x-bc-client-secret', 'x-bc-environment', 'x-bc-company' } | null

/**
 * Translate a UI string. Falls back to the English source text when no translation
 * is loaded. The same `t()` semantics used in index.html.
 */
function t(s)
// → string

/**
 * Batch-fetch translations for the current LCID from the Cloud Event Translation
 * table. Creates placeholder records for any UI_STRINGS not yet in the table so
 * translators can fill them in directly from Business Central.
 * Must be called after company and LCID are fully resolved.
 *
 * @param {string}   companyId  - BC company GUID
 * @param {number}   lcid       - Windows Language ID (1033 = English, skip fetch)
 * @param {string[]} uiStrings  - page-specific array of English source strings
 * @param {object}   headers    - x-bc-* headers object (from bcSettingsHeaders())
 */
async function bcLoadTranslations(companyId, lcid, uiStrings, headers)
// → void  (populates internal cache; call applyUiTranslations() afterwards)

/**
 * Walk all [data-t] and [data-tp] DOM elements and replace their
 * textContent / placeholder with the current translation.
 */
function applyUiTranslations()
// → void
```

### Implementation

```js
const _PFX = 'bc_portal_';
const _MAP = {
  tenant:       'tenant',
  env:          'env',
  clientId:     'client_id',
  clientSecret: 'client_secret',
  companyId:    'company_id',
  companyName:  'company_name',
  lcid:         'lcid'
};

function bcSettingsLoad() {
  const out = {};
  for (const [prop, key] of Object.entries(_MAP))
    out[prop] = localStorage.getItem(_PFX + key) || '';
  return out;
}

function bcSettingsSave(obj) {
  for (const [prop, key] of Object.entries(_MAP))
    if (obj[prop] !== undefined) localStorage.setItem(_PFX + key, obj[prop]);
}

function bcSettingsClear() {
  for (const key of Object.values(_MAP))
    localStorage.removeItem(_PFX + key);
}

function bcSettingsReady() {
  const s = bcSettingsLoad();
  return !!(s.tenant && s.env && s.clientId && s.clientSecret && s.companyId);
}

function bcSettingsHeaders() {
  const s = bcSettingsLoad();
  if (!s.tenant || !s.env || !s.clientId || !s.clientSecret || !s.companyId) return null;
  return {
    'x-bc-tenant':        s.tenant,
    'x-bc-client-id':     s.clientId,
    'x-bc-client-secret': s.clientSecret,
    'x-bc-environment':   s.env,
    'x-bc-company':       s.companyId
  };
}

// ---- Translation ----
let _uiTranslations = {};

function t(s) { return _uiTranslations[s] || s; }

function applyUiTranslations() {
  document.querySelectorAll('[data-t]').forEach(el  => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-tp]').forEach(el => { el.placeholder = t(el.dataset.tp); });
}

async function bcLoadTranslations(companyId, lcid, uiStrings, headers) {
  _uiTranslations = {};
  if (lcid === 1033) return;  // English — no fetch needed
  try {
    // Fetch existing translations for this page's source strings
    const res = await fetch('/api/explorer', {
      method: 'POST',
      headers: { ...headers, 'x-bc-endpoint': 'tasks', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specversion: '1.0', type: 'Data.Records.Get', source: 'BC Portal',
        subject: 'Cloud Event Translation',
        data: JSON.stringify({
          tableView: `WHERE(Windows Language ID=CONST(${lcid}),Source=CONST(BC Portal))`,
          take: uiStrings.length + 50
        })
      })
    }).then(r => r.json());

    const rows = res.result || [];
    for (const rec of rows) {
      const src = (rec.primaryKey || {}).SourceText;
      const tgt = (rec.fields    || {}).TargetText;
      if (src && tgt) _uiTranslations[src] = tgt;
    }

    // Auto-create placeholder records for strings not yet in the table
    const existing = new Set(rows.map(r => (r.primaryKey || {}).SourceText));
    const missing  = uiStrings.filter(s => !existing.has(s));
    if (missing.length) {
      await fetch('/api/explorer', {
        method: 'POST',
        headers: { ...headers, 'x-bc-endpoint': 'tasks', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specversion: '1.0', type: 'Data.Records.Set', source: 'BC Portal',
          subject: 'Cloud Event Translation',
          data: JSON.stringify({
            data: missing.map(s => ({
              primaryKey: { Source: 'BC Portal', WindowsLanguageID: String(lcid), SourceText: s },
              fields:     { TargetText: '' }
            }))
          })
        })
      });
    }
  } catch (_) { /* silently fall back to English */ }
}
```

---

## New API Endpoint: `GET /api/companies`

### Purpose

Fetches the list of BC companies using client-supplied credentials (does NOT use server env vars). This enables the company-name dropdown on developer-tool pages.

### Files

- `api/companies/function.json`
- `api/companies/index.js`

### `function.json`

```json
{
  "bindings": [
    {
      "authLevel": "anonymous",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["get", "options"]
    },
    {
      "type": "http",
      "direction": "out",
      "name": "res"
    }
  ]
}
```

### `index.js`

```js
const https = require('https');

async function getToken(tenantId, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://api.businesscentral.dynamics.com/.default'
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'login.microsoftonline.com', path: `/${tenantId}/oauth2/v2.0/token`, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(`Token error: ${j.error_description || j.error}`));
          else resolve(j.access_token);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function (context, req) {
  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: { 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'x-bc-tenant,x-bc-client-id,x-bc-client-secret,x-bc-environment' } };
    return;
  }

  const tenant   = req.headers['x-bc-tenant'];
  const clientId = req.headers['x-bc-client-id'];
  const secret   = req.headers['x-bc-client-secret'];
  const env      = req.headers['x-bc-environment'];

  if (!tenant || !clientId || !secret || !env) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required headers: x-bc-tenant, x-bc-client-id, x-bc-client-secret, x-bc-environment' }) };
    return;
  }

  try {
    const token = await getToken(tenant, clientId, secret);
    const data  = await new Promise((resolve, reject) => {
      https.get(
        { hostname: 'api.businesscentral.dynamics.com',
          path: `/v2.0/${encodeURIComponent(tenant)}/${encodeURIComponent(env)}/api/v2.0/companies`,
          headers: { Authorization: `Bearer ${token}` } },
        res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve(JSON.parse(body)));
        }
      ).on('error', reject);
    });

    const companies = (data.value || []).map(c => ({ id: c.id, name: c.displayName || c.name }));
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies }) };
  } catch (e) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }) };
  }
};
```

---

## Settings Panel UI Component

All three developer-tool pages get a collapsible settings panel at the top of the page, replacing the current inline config inputs. The panel must look consistent across pages (reuse the `.ci`/`.lbl` CSS classes already present) and auto-collapse once connection is valid.

### HTML Structure

```html
<details id="settings-panel" class="settings-panel">
  <summary class="settings-summary">
    <span id="settings-summary-text">⚙ Connection Settings</span>
  </summary>
  <div class="settings-body">
    <div class="settings-row">
      <div><div class="lbl">Tenant</div>
        <input class="ci" id="cfgTenant" placeholder="dynamics.is" oninput="onSettingInput()"></div>
      <div><div class="lbl">Environment</div>
        <input class="ci" id="cfgEnv" placeholder="Production" oninput="onSettingInput()"></div>
      <div><div class="lbl">Client ID</div>
        <input class="ci" id="cfgClientId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" oninput="onSettingInput()"></div>
      <div><div class="lbl">Client Secret</div>
        <input class="ci" id="cfgClientSecret" type="password" placeholder="your-client-secret" oninput="onSettingInput()"></div>
    </div>
    <div class="settings-row">
      <div style="flex:2"><div class="lbl">Company</div>
        <select class="ci" id="cfgCompany" onchange="onCompanySelect()">
          <option value="">— enter credentials, then Load —</option>
        </select></div>
      <div style="flex:1"><div class="lbl">Language</div>
        <select class="ci" id="cfgLcid" onchange="onLcidSelect()">
          <option value="1033">English</option>
        </select></div>
      <div style="align-self:flex-end">
        <button class="ci-btn" id="load-companies-btn" onclick="loadCompanies()" disabled>Load</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="ci-btn secondary" onclick="bcSettingsClear();location.reload()">Clear Saved</button>
    </div>
    <div id="settings-status" style="font-size:0.72rem;color:var(--text-dim);margin-top:6px"></div>
  </div>
</details>
```

> **Note:** The `<select id="cfgCompany">` replaces the current `<input id="cfgCompany">` GUID text input. All downstream code that reads `g('cfgCompany')` will still work because `<select>.value` is the GUID.

### Settings Panel CSS (add to each page's `<style>`)

```css
.settings-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius, 8px); margin-bottom: 16px; }
.settings-summary { cursor: pointer; padding: 10px 16px; font-size: 0.8rem; font-family: 'DM Mono', monospace; color: var(--text-mid); list-style: none; display: flex; align-items: center; gap: 8px; user-select: none; }
.settings-summary::-webkit-details-marker { display: none; }
.settings-body { padding: 12px 16px 14px; border-top: 1px solid var(--border); }
.settings-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.settings-row > div { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 160px; }
.ci-btn { padding: 7px 16px; background: var(--accent, #4f7fff); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 0.82rem; font-family: inherit; }
.ci-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ci-btn.secondary { background: var(--surface2, #2a2a3a); border: 1px solid var(--border, #333); color: var(--text-mid, #aaa); }
```

---

## Page Boot Sequence (all three developer-tool pages)

On `DOMContentLoaded`, run the following:

```js
async function initSettings() {
  // 1. Load from localStorage
  const s = bcSettingsLoad();

  // 2. If any credential field is empty, try to pre-fill from /api/config
  if (!s.tenant || !s.clientId || !s.env) {
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      if (!s.tenant    && cfg.BC_TENANT_ID)    s.tenant    = cfg.BC_TENANT_ID;
      if (!s.clientId  && cfg.BC_CLIENT_ID)    s.clientId  = cfg.BC_CLIENT_ID;
      if (!s.env       && cfg.BC_ENVIRONMENT)  s.env       = cfg.BC_ENVIRONMENT;
      // BC_CLIENT_SECRET is never exposed by /api/config — user must enter it
      // Save the pre-filled values (without secret) so the next page load is faster
      bcSettingsSave({ tenant: s.tenant, env: s.env, clientId: s.clientId });
    } catch (_) {}
  }

  // 3. Populate input elements
  const g = id => document.getElementById(id);
  if (s.tenant)       g('cfgTenant').value       = s.tenant;
  if (s.env)          g('cfgEnv').value           = s.env;
  if (s.clientId)     g('cfgClientId').value      = s.clientId;
  if (s.clientSecret) g('cfgClientSecret').value  = s.clientSecret;

  // 4. If all four credentials are present, load company list
  if (s.tenant && s.env && s.clientId && s.clientSecret) {
    await loadCompanies(s.companyId, s.lcid);   // auto-selects saved company + language
  } else {
    updateLoadBtn();
  }

  // 5. Collapse panel if connection is fully ready
  if (bcSettingsReady()) {
    document.getElementById('settings-panel').open = false;
    updateSettingsSummary();
  } else {
    document.getElementById('settings-panel').open = true;
  }
}
```

### `loadCompanies()` function

```js
async function loadCompanies(preselectId = null, preselectLcid = null) {
  const s = bcSettingsLoad();
  const btn = document.getElementById('load-companies-btn');
  const status = document.getElementById('settings-status');
  btn.disabled = true;
  status.textContent = 'Loading companies…';
  try {
    const res = await fetch('/api/companies', {
      headers: {
        'x-bc-tenant':        s.tenant,
        'x-bc-client-id':     s.clientId,
        'x-bc-client-secret': s.clientSecret,
        'x-bc-environment':   s.env
      }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load companies');

    const select = document.getElementById('cfgCompany');
    select.innerHTML = '<option value="">— select a company —</option>' +
      data.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

    // Auto-select saved company
    const toSelect = preselectId || s.companyId;
    if (toSelect && data.companies.find(c => c.id === toSelect)) {
      select.value = toSelect;
    } else if (data.companies.length === 1) {
      select.value = data.companies[0].id;   // auto-select when only one company
    }

    if (select.value) {
      const chosen = data.companies.find(c => c.id === select.value);
      bcSettingsSave({ companyId: select.value, companyName: chosen?.name || '' });
      await loadLanguages(select.value, preselectLcid || s.lcid);
    }

    status.textContent = `${data.companies.length} ${data.companies.length === 1 ? 'company' : 'companies'} loaded`;
    updateSettingsSummary();
  } catch (e) {
    status.textContent = '⚠ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}
```

### `onSettingInput()` — react to credential field changes

```js
function onSettingInput() {
  const s = {
    tenant:       document.getElementById('cfgTenant').value.trim(),
    env:          document.getElementById('cfgEnv').value.trim(),
    clientId:     document.getElementById('cfgClientId').value.trim(),
    clientSecret: document.getElementById('cfgClientSecret').value.trim()
  };
  // Save immediately (including secret — user is actively editing)
  bcSettingsSave(s);
  // Enable Load button only when all four fields are non-empty
  document.getElementById('load-companies-btn').disabled =
    !(s.tenant && s.env && s.clientId && s.clientSecret);
}
```

### `onCompanySelect()` — company dropdown changed

```js
async function onCompanySelect() {
  const select = document.getElementById('cfgCompany');
  const id = select.value;
  const name = select.options[select.selectedIndex]?.text || '';
  bcSettingsSave({ companyId: id, companyName: name });
  if (id) await loadLanguages(id);
  updateSettingsSummary();
}
```

### `onLcidSelect()` and `loadLanguages()`

On the metadata-explorer and cloud-events-explorer pages a language (`cfgLcid`) select already exists. Generalise it:

```js
function onLcidSelect() {
  const lcid = document.getElementById('cfgLcid').value;
  bcSettingsSave({ lcid });
  // Page-specific refresh (each page calls its own reload logic here)
}

async function loadLanguages(companyId, preselectLcid) {
  const s = bcSettingsLoad();
  if (!s.tenant || !s.env || !s.clientId || !s.clientSecret || !companyId) return;

  const headers = {
    'x-bc-tenant':        s.tenant,
    'x-bc-client-id':     s.clientId,
    'x-bc-client-secret': s.clientSecret,
    'x-bc-environment':   s.env,
    'x-bc-company':       companyId,
    'Content-Type':       'application/json'
  };

  try {
    // Step 1: get allowed LCIDs
    const allowedRes = await fetch('/api/explorer', {
      method: 'POST',
      headers: { ...headers, 'x-bc-endpoint': 'tasks' },
      body: JSON.stringify({ specversion: '1.0', type: 'Data.Records.Get',
        source: 'Settings', subject: 'Allowed Language' })
    }).then(r => r.json());
    const lcids = (allowedRes.result || []).map(r => parseInt(r.primaryKey?.LanguageId, 10)).filter(Boolean);
    const ids = lcids.length ? lcids : [1033];

    // Step 2: fetch Language names
    const tableView = `WHERE(Windows Language ID=FILTER(${ids.join('|')}))`;
    const langRes = await fetch('/api/explorer', {
      method: 'POST',
      headers: { ...headers, 'x-bc-endpoint': 'tasks' },
      body: JSON.stringify({ specversion: '1.0', type: 'Data.Records.Get',
        source: 'Settings',
        data: JSON.stringify({ tableName: 'Language', tableView }) })
    }).then(r => r.json());

    const lcidToName = {};
    for (const rec of (langRes.result || [])) {
      const lcid = parseInt(rec.fields?.WindowsLanguageID, 10);
      if (lcid && rec.fields?.Name)
        lcidToName[lcid] = rec.fields.Name.charAt(0).toUpperCase() + rec.fields.Name.slice(1).toLowerCase();
    }

    const select = document.getElementById('cfgLcid');
    select.innerHTML = ids.map(id =>
      `<option value="${id}">${lcidToName[id] || 'Language ' + id}</option>`
    ).join('');

    const toSelect = preselectLcid || s.lcid || '1033';
    if (ids.map(String).includes(String(toSelect))) select.value = String(toSelect);
    bcSettingsSave({ lcid: select.value });
  } catch (_) { /* keep current language select unchanged */ }
}
```

### `updateSettingsSummary()` — panel header status

```js
function updateSettingsSummary() {
  const s = bcSettingsLoad();
  const el = document.getElementById('settings-summary-text');
  if (bcSettingsReady()) {
    el.textContent = `⚙ ${s.companyName || s.companyId} · ${s.env} · LCID ${s.lcid || 1033}`;
  } else {
    el.textContent = '⚙ Connection Settings (not configured)';
  }
}
```

---

## Global UI Translation

### Design

Every page on the site has UI constants (button labels, headings, status messages, placeholder text) that should be translatable from Business Central. The `index.html` already implements this pattern via `t()`, `applyUiTranslations()`, and `loadUiTranslations()`. This requirement standardises the same mechanism across **all** pages by moving the translation helpers into `settings.js` (`bcLoadTranslations`, `t`, `applyUiTranslations`) so no page needs to re-implement them.

The source of truth is the **`Cloud Event Translation`** table in Business Central:

| Primary Key field | Value |
|---|---|
| `Source` | `BC Portal` (constant — identifies strings from this website) |
| `Windows Language ID` | LCID of the target language |
| `SourceText` | English string (the key) |

| Field | Value |
|---|---|
| `TargetText` | Translated string (filled in by translators in BC) |

When a string is missing from the table, `bcLoadTranslations` automatically creates a blank placeholder record — translators will see it appear in BC ready to fill in, with no developer work required.

### `UI_STRINGS` per page

Each page declares its own `const UI_STRINGS = [ ... ]` array of **all English strings** that appear in that page's static HTML or are rendered dynamically. This array is passed to `bcLoadTranslations()` so that placeholder records are created for every string in one call.

```js
// Example for bc-cloud-events-explorer.html
const UI_STRINGS = [
  'Connection Settings (not configured)',
  'Load', 'Clear Saved',
  'Send', 'Clear', 'Copy', 'Queue', 'History', 'Replay',
  'Loading history...', 'No history yet', 'Raw', 'Result', 'Request JSON',
  'Source', 'Subject', 'Data', 'Namespace', 'Message Type',
  // ... all strings used by this page
];
```

### When to call translations

Translations must be (re-)loaded whenever the **company or LCID changes**, since both are part of the lookup key. The standard call sequence is:

```js
// After company + LCID are resolved (typically at the end of onCompanySelect / onLcidSelect)
await bcLoadTranslations(
  bcSettingsLoad().companyId,
  parseInt(bcSettingsLoad().lcid || '1033', 10),
  UI_STRINGS,
  bcSettingsHeaders()
);
applyUiTranslations();
```

Because `applyUiTranslations()` only updates **static** DOM elements (those bearing `data-t` / `data-tp` attributes), any strings rendered dynamically via `innerHTML` must use the `t()` function inline:

```js
// Good — t() is called at render time, so it reflects the current language
el.innerHTML = `<span>${t('No history yet')}</span>`;

// Bad — string is baked in at definition time, won't react to language changes
const msg = 'No history yet';  // do NOT do this for translatable strings
```

### HTML attribute conventions

| Purpose | Attribute | Behaviour |
|---|---|---|
| Translatable `textContent` | `data-t="English text"` | `applyUiTranslations()` sets `el.textContent = t(...)` |
| Translatable `placeholder` | `data-tp="English text"` | `applyUiTranslations()` sets `el.placeholder = t(...)` |

Keep the English default text as both the attribute value **and** the element's displayed content so the page is readable before translations load:

```html
<button data-t="Send">Send</button>
<input data-tp="Type a message..." placeholder="Type a message...">
```

### Pages — translation scope

| Page | Current state | Action |
|---|---|---|
| `index.html` | ✅ Full translation via `loadUiTranslations()` + `UI_STRINGS` (160+ strings) | No change to translation logic — already complete |
| `bc-metadata-explorer.html` | ❌ No translation | Add `UI_STRINGS`, call `bcLoadTranslations` + `applyUiTranslations` after language resolves |
| `bc-cloud-events-explorer.html` | ❌ No translation | Same as above |
| `sales-assistant.html` | ❌ No translation | Same as above; pass `bcSettingsHeaders()` with `x-bc-endpoint: 'tasks'` |

### `index.html` alignment

`index.html` uses its own inline `loadUiTranslations()` which calls `cePost()` (the portal's two-step Cloud Events proxy) rather than `/api/explorer`. This is fine — **do not change `index.html`'s translation logic**. The `settings.js` implementation uses `/api/explorer` because the developer-tool pages send credentials in headers rather than relying on server env vars.

Both paths write to the same `Cloud Event Translation` BC table with the same `Source = 'BC Portal'` primary key, so all strings share a single translation table in Business Central regardless of which page created the placeholder.

---

## Page-by-Page Changes

### `bc-metadata-explorer.html`

1. Add `<script src="settings.js"></script>` in `<head>`.
2. Replace the current config `<div>` (lines with `cfgTenant`, `cfgEnv`, `cfgCompany`, `cfgClientId`, `cfgClientSecret` inputs) with the **Settings Panel HTML** from above.
3. Change `<input class="ci" id="cfgCompany">` to `<select class="ci" id="cfgCompany">` (already in the panel template).
4. Remove the existing `cfgLcid` standalone input/select that appears separately — it is now part of the settings panel.
5. Call `initSettings()` from `DOMContentLoaded` (replace the current manual config reading).
6. The existing `g()` helper and all calls to `g('cfgTenant')` etc. remain unchanged — they read from the same input IDs.
7. After `onCompanySelect()` saves the company, trigger the page's existing table-load function.
8. After `onLcidSelect()` saves the LCID, trigger the page's existing language-change handler.
9. Declare a page-level `UI_STRINGS` array covering all static labels, button captions, status messages and placeholder texts used by this page.
10. Add `data-t` / `data-tp` attributes to all static HTML elements that carry translatable text.
11. At the end of `onCompanySelect()` and `onLcidSelect()`, call `bcLoadTranslations(...)` then `applyUiTranslations()`.

### `bc-cloud-events-explorer.html`

Same steps 1–8 as above (metadata-explorer). Additionally:
- The language dropdown in the settings panel replaces the hardcoded LCID `1033` used in Cloud Events requests; use `parseInt(bcSettingsLoad().lcid || '1033', 10)` when constructing each request body.
- Declare `UI_STRINGS` and wire translation (steps 9–11 from metadata-explorer).

### `sales-assistant.html`

1. Add `<script src="settings.js"></script>` in `<head>`.
2. Replace the current config panel HTML with the Settings Panel.  
   - Remove the "Stored in sessionStorage only — cleared when tab closes" note.
3. Remove the `saveConfig()` and `loadConfig()` functions that read/write `sessionStorage`.
4. Remove all `sessionStorage.setItem` / `sessionStorage.getItem` calls for `sa_bc_*` keys.
5. Replace any `sessionStorage` reads with `bcSettingsLoad()` at the point of use.
6. Call `initSettings()` from `DOMContentLoaded`.
7. When the user clicks **Start Chat**, read credentials via `bcSettingsLoad()` instead of reading individual input values.
8. Declare `UI_STRINGS` covering all chat UI labels and status messages. Wire `bcLoadTranslations` + `applyUiTranslations` after company / language resolves.

### `index.html` (partial sync only)

The main portal uses server-side credentials and has its own company-selection UI — no changes to credentials or company loading.

**Changes limited to LCID sync:**
1. On page load, after `selectedLcid` is initialised: read `bc_portal_lcid` from localStorage and use it if present.
   ```js
   const savedLcid = parseInt(localStorage.getItem('bc_portal_lcid') || '1033', 10);
   if (savedLcid) selectedLcid = savedLcid;
   ```
2. In `onLangChange()`, after updating `selectedLcid`: write it to localStorage.
   ```js
   localStorage.setItem('bc_portal_lcid', String(selectedLcid));
   ```
3. In `selectCompany()`, write the chosen company ID and name to localStorage:
   ```js
   localStorage.setItem('bc_portal_company_id',   selectedCompany.id);
   localStorage.setItem('bc_portal_company_name',  selectedCompany.displayName || selectedCompany.name);
   ```

---

## Readiness Assessment

| Item | Ready? | Notes |
|------|--------|-------|
| `/api/config` endpoint | ✅ | Returns `BC_TENANT_ID`, `BC_CLIENT_ID`, `BC_ENVIRONMENT`; secret always `false` |
| `x-bc-*` header pattern in explorer pages | ✅ | Identical across both explorer pages; reuse as-is |
| Language load pattern | ✅ | Full two-step `Allowed Language` → `Language` pattern exists in `bc-metadata-explorer.html` |
| All pages share same input IDs | ✅ | `cfgTenant`, `cfgEnv`, `cfgCompany`, `cfgClientId`, `cfgClientSecret` used identically |
| `/api/explorer` function for language load | ✅ | Accepts `x-bc-*` headers; reuse for `initSettings` language fetch |
| `/api/companies` endpoint | ⚠️ New | ~50 LOC; reuses same OAuth pattern as `api/explorer/index.js` |
| `settings.js` module | ⚠️ New | ~50 LOC; pure localStorage helpers, no dependencies |
| `Cloud Event Translation` table pattern | ✅ | Fully implemented in `index.html`; `bcLoadTranslations` in `settings.js` is a straight port using `/api/explorer` instead of `cePost` |
| `staticwebapp.config.json` route | ✅ | Azure Functions are auto-routed under `/api/*`; no config change needed |

**Verdict:** Everything needed to implement this requirement is already in place. The only new files are `api/companies/index.js`, `api/companies/function.json`, and `settings.js` — all small and self-contained.

---

## Testing Checklist

### settings.js
- [ ] `bcSettingsLoad()` returns empty strings for keys not yet set
- [ ] `bcSettingsSave({ tenant: 'x' })` does not overwrite other keys
- [ ] `bcSettingsClear()` removes all 7 keys and no others
- [ ] `bcSettingsReady()` returns false when any of the 5 required fields is empty
- [ ] `bcSettingsHeaders()` returns null when `bcSettingsReady()` is false
- [ ] `bcSettingsHeaders()` returns correct headers when all fields set

### /api/companies
- [ ] Returns 400 when any required header is missing
- [ ] Returns 500 with error message on invalid credentials (token error)
- [ ] Returns `{ companies: [{id, name}] }` on success
- [ ] OPTIONS pre-flight returns 204 with correct CORS headers
- [ ] Company names are non-empty strings

### Settings Panel — bc-metadata-explorer.html
- [ ] On first load (no localStorage), `/api/config` pre-fills Tenant / Client ID / Environment
- [ ] Client secret field is empty after pre-fill (never populated from server)
- [ ] Typing all four credential fields enables the Load button
- [ ] Clicking Load populates the company dropdown
- [ ] Company dropdown auto-selects the previously saved company
- [ ] Selecting a company triggers language dropdown load
- [ ] Language dropdown auto-selects saved LCID
- [ ] All settings persist across page reload
- [ ] Panel collapses when connection is fully configured
- [ ] Panel header shows company name + environment when configured
- [ ] "Clear Saved" button clears localStorage and reloads to default state
- [ ] Changing company → language dropdown refreshes for new company

### Settings Panel — bc-cloud-events-explorer.html
- [ ] Same checklist as above
- [ ] Language LCID is sent with Cloud Events requests (not hardcoded 1033)

### Settings Panel — sales-assistant.html
- [ ] No `sa_bc_*` keys written to sessionStorage
- [ ] Credentials loaded from localStorage when starting a chat
- [ ] Session survives page reload (localStorage persists)
- [ ] Clearing settings empties all credential fields

### index.html LCID sync
- [ ] Selecting a language in the main portal writes `bc_portal_lcid` to localStorage
- [ ] Opening bc-metadata-explorer.html after language change pre-selects the matching language
- [ ] Selecting a company writes `bc_portal_company_id` and `bc_portal_company_name`

### Global UI Translation
- [ ] `t('unknown string')` returns the input string unchanged (English fallback)
- [ ] `bcLoadTranslations` is skipped entirely when LCID is 1033
- [ ] After selecting a non-English language, `applyUiTranslations()` updates all `[data-t]` elements
- [ ] After selecting a non-English language, `applyUiTranslations()` updates all `[data-tp]` placeholders
- [ ] Strings not yet in the BC table are created as blank records; subsequent load finds them
- [ ] Dynamically rendered strings use `t()` at render time; switching language re-renders correctly
- [ ] Switching back to English (LCID 1033) restores original English text via `data-t` attribute values
- [ ] All pages share the same `Source = 'BC Portal'` records in the Cloud Event Translation table
- [ ] bc-metadata-explorer: table headers, button labels, export menu items are all translated
- [ ] bc-cloud-events-explorer: panel labels, tab names, status messages are all translated
- [ ] sales-assistant: chat UI labels, connection panel labels are all translated
