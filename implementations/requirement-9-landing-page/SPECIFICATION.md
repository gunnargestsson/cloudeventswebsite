# Requirement 9: Dedicated Connection Landing Page

## Overview

Restructure the site so that `index.html` becomes a **configuration / landing page** shown on every visit. The existing BC Portal content that currently lives in `index.html` (companies grid, customer list, customer detail, customer create) moves to `bc-portal.html`.

The landing page:
- Lets the user choose between **Server configuration** (Azure Functions env vars) and **Custom configuration** (manually entered credentials).
- Loads the company dropdown automatically on page load using whichever mode is active.
- The user is "connected" once a company is selected — no separate "verify" step.
- Presents four navigation cards (BC Portal, Cloud Events Explorer, Metadata Explorer, AI Sales Assistant) once a company is chosen.
- Replaces the three-pill header toolbar on all pages with a single "← Home" link.

---

## Design Decisions

| # | Question | Answer |
|---|----------|--------|
| Q1 | What defines "Connected"? | Company selected in the dropdown. Companies load on page open using the current mode (server or custom). |
| Q2 | Settings panels on sub-pages | **Remove** (`<details id="settingsPanel">` deleted). Sub-pages redirect to `index.html` if settings not ready. |
| Q3 | Scope of single menu | **Landing page only.** Sub-pages show a single "← Home" pill link. |
| Q4 | Credential mode | **Toggle between server config and custom config.** Server config uses `/api/config` for display + `/api/companies` without headers. Custom config uses client-supplied credentials. |
| Q5 | Auto-redirect when already configured | **Always show config page.** Config is re-shown on each visit; company is pre-selected, nav cards visible. |
| Q6 | Back navigation on sub-pages | **← Home → `index.html`** on all sub-pages. |

---

## Connection Mode

The landing page has a **mode selector** — a radio pair:

```
  ◉ Server configuration
  ○ Custom configuration
```

The selected mode is persisted in `localStorage` as `bc_portal_mode` (`"server"` or `"custom"`).

### Server mode
- Credential fields (tenant, env, client ID, client secret) are **hidden**.
- `/api/companies` is called **without** `x-bc-*` headers. The function falls back to its env vars.
- `/api/config` is called to display the active env-var values in a read-only info panel (tenant, client ID, environment, secret status).
- Sub-pages call API endpoints without credential headers; Azure Functions fall back to env vars.

### Custom mode
- Credential fields are **shown and editable**.
- `/api/companies` is called with `x-bc-*` headers built from the form values.
- Sub-pages call API endpoints with `bcSettingsHeaders()` credential headers.
- `bcSettingsSave()` persists all fields including credentials to `localStorage`.

---

## `localStorage` Key Schema Changes

Extends the schema from Requirement 7 with one new key:

| Key | Type | Notes |
|-----|------|-------|
| `bc_portal_mode` | `"server"` \| `"custom"` | Active connection mode. Defaults to `"server"`. |
| `bc_portal_tenant` | string | Only populated in custom mode |
| `bc_portal_env` | string | Only populated in custom mode |
| `bc_portal_client_id` | string | Only populated in custom mode |
| `bc_portal_client_secret` | string | Only populated in custom mode |
| `bc_portal_company_id` | string | Set in both modes |
| `bc_portal_company_name` | string | Set in both modes |
| `bc_portal_lcid` | string | Set in both modes |

---

## `settings.js` Changes

### `bcSettingsReady()` — updated logic

In server mode only `companyId` is required (no credentials stored client-side):

```js
function bcSettingsReady() {
  const mode = localStorage.getItem('bc_portal_mode') || 'server';
  if (mode === 'server') {
    return !!localStorage.getItem('bc_portal_company_id');
  }
  // custom mode: all 5 credential fields + company required
  return ['bc_portal_tenant','bc_portal_env','bc_portal_client_id',
          'bc_portal_client_secret','bc_portal_company_id']
    .every(k => !!localStorage.getItem(k));
}
```

### `bcSettingsHeaders()` — updated logic

Returns `null` in server mode so API calls carry no credential headers and functions fall back to env vars:

```js
function bcSettingsHeaders() {
  const mode = localStorage.getItem('bc_portal_mode') || 'server';
  if (mode === 'server') return null;
  const s = bcSettingsLoad();
  if (!s.tenant || !s.env || !s.clientId || !s.clientSecret) return null;
  return {
    'x-bc-tenant':        s.tenant,
    'x-bc-env':           s.env,
    'x-bc-client-id':     s.clientId,
    'x-bc-client-secret': s.clientSecret
  };
}
```

---

## `/api/companies` Change

The existing endpoint must support a **no-header fallback** so the landing page can load companies in server mode without exposing credentials to the client.

**Current behaviour**: requires `x-bc-*` headers; returns 400 if missing.

**New behaviour** — at the top of the handler, fall back to env vars:

```js
// api/companies/index.js
const tenant   = req.headers['x-bc-tenant']        || process.env.BC_TENANT_ID;
const env      = req.headers['x-bc-env']           || process.env.BC_ENVIRONMENT;
const clientId = req.headers['x-bc-client-id']     || process.env.BC_CLIENT_ID;
const secret   = req.headers['x-bc-client-secret'] || process.env.BC_CLIENT_SECRET;
if (!tenant || !env || !clientId || !secret) {
  return context.res = { status: 400, body: { error: 'Missing credentials' } };
}
```

Client-supplied headers take priority; env vars are the silent fallback.

---

## New `index.html` — Landing / Configuration Page

### Layout

```
┌──────────────────────────────────────────────────────┐
│  [Origo logo]  BC Portal / Business Central          │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Connection                                          │
│  ┌────────────────────────────────────────────────┐  │
│  │  ◉ Server configuration  ○ Custom              │  │
│  │                                                │  │
│  │  [server mode: read-only info panel]           │  │
│  │    Tenant   dynamics.is                        │  │
│  │    Env      Production                         │  │
│  │    Client   xxxxxxxx-…                         │  │
│  │    Secret   ● set                              │  │
│  │                                                │  │
│  │  — or in custom mode: —                        │  │
│  │    Tenant host   [________________]            │  │
│  │    Environment   [________________]            │  │
│  │    Client ID     [________________]            │  │
│  │    Client Secret [________________]            │  │
│  │                                                │  │
│  │  Company  [  dropdown ▾  ]                     │  │
│  │  Language [  dropdown ▾  ]                     │  │
│  │                         [ Connect ]            │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ✓  Connected to {companyName}  [{env}]              │
│                                                      │
│  Navigate to                                         │
│  ┌──────────────┐ ┌──────────────┐                   │
│  │  BC Portal   │ │Cloud Events  │                   │
│  │              │ │  Explorer    │                   │
│  └──────────────┘ └──────────────┘                   │
│  ┌──────────────┐ ┌──────────────┐                   │
│  │  Metadata    │ │AI Sales      │                   │
│  │  Explorer    │ │  Assistant   │                   │
│  └──────────────┘ └──────────────┘                   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Behaviour

1. **On load**:
   - Read `bc_portal_mode` from `localStorage` (default `"server"`).
   - Apply mode to form (show/hide credential fields, show/hide server info panel).
   - Call `loadCompanies()` immediately — company dropdown populates without a button press.
     - Server mode: `fetch('/api/companies')` with no extra headers.
     - Custom mode: `fetch('/api/companies', { headers: credHeaders() })` — only if all 4 credential fields are populated.
   - Pre-select `bc_portal_company_id` in the dropdown if present.
   - Pre-select `bc_portal_lcid` in the language dropdown if present.
   - If `bcSettingsReady()` is true → show nav cards and status pill ("Connected as…").

2. **Mode toggle** (`<input type="radio">`):
   - Switching mode saves `bc_portal_mode` and re-runs `loadCompanies()`.
   - Custom → server: credential inputs hidden; server info panel shown.
   - Server → custom: server info panel hidden; credential inputs shown.

3. **Company dropdown `onchange`**:
   - Saves `bc_portal_company_id` and `bc_portal_company_name` via `bcSettingsSave()`.
   - Triggers loading the language dropdown for the chosen company.
   - Shows nav cards and status message.

4. **Language dropdown `onchange`**:
   - Saves `bc_portal_lcid` via `bcSettingsSave()`.

5. **Connect button**:
   - In custom mode: validates all 4 credential fields are filled, saves them, then calls `loadCompanies()`.
   - In server mode: triggers `onCompanyChange()` for the currently selected company (if any).

6. **Navigation cards** — shown as soon as `bcSettingsReady()` is true.

### HTML Skeleton

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>BC Portal – Connection</title>
  <script src="settings.js"></script>
  <!-- theme CSS (same variables as other pages) -->
</head>
<body>
<div id="app">
  <header>
    <a class="logo" href="index.html" style="text-decoration:none;color:inherit">
      <div class="logo-icon"><img src="origo.jpeg" alt="Origo"></div>
      BC Portal <span>/ Business Central</span>
    </a>
  </header>

  <main>
    <div class="page-card">
      <div class="section-title">Connection</div>

      <!-- Mode selector -->
      <div class="mode-row">
        <label><input type="radio" name="mode" value="server" onchange="setMode('server')"> Server configuration</label>
        <label><input type="radio" name="mode" value="custom" onchange="setMode('custom')"> Custom configuration</label>
      </div>

      <!-- Server info panel (server mode only) -->
      <div id="server-info" class="config-panel" style="display:none">
        <div class="config-row"><span class="config-key">Tenant</span><span class="config-val" id="cfg-tenant">—</span></div>
        <div class="config-divider"></div>
        <div class="config-row"><span class="config-key">Environment</span><span class="config-val" id="cfg-env">—</span></div>
        <div class="config-divider"></div>
        <div class="config-row"><span class="config-key">Client ID</span><span class="config-val" id="cfg-client-id">—</span></div>
        <div class="config-divider"></div>
        <div class="config-row"><span class="config-key">Secret</span><span id="cfg-secret">—</span></div>
      </div>

      <!-- Custom credential fields (custom mode only) -->
      <div id="custom-fields" style="display:none">
        <div class="field-row"><label>Tenant host</label><input id="s-tenant" type="text" placeholder="dynamics.is"></div>
        <div class="field-row"><label>Environment</label><input id="s-env" type="text" placeholder="Production"></div>
        <div class="field-row"><label>Client ID</label><input id="s-client-id" type="text" placeholder="xxxxxxxx-xxxx-…"></div>
        <div class="field-row"><label>Client Secret</label><input id="s-client-secret" type="password"></div>
      </div>

      <!-- Company + Language (both modes) -->
      <div class="field-row">
        <label>Company</label>
        <select id="s-company" onchange="onCompanyChange()">
          <option value="">— loading… —</option>
        </select>
      </div>
      <div class="field-row">
        <label>Language</label>
        <select id="s-lang" onchange="onLangChange()"></select>
      </div>

      <div class="form-actions">
        <button id="connect-btn" onclick="connect()">Connect</button>
      </div>
      <div id="connect-status"></div>
    </div>

    <!-- Navigation cards — hidden until connected -->
    <div id="nav-section" style="display:none">
      <div class="section-title">Navigate to</div>
      <div class="nav-cards">
        <a href="bc-portal.html" class="nav-card">
          <div class="nav-card-icon">🏢</div>
          <div class="nav-card-title">BC Portal</div>
          <div class="nav-card-desc">Companies, customers, orders</div>
        </a>
        <a href="bc-cloud-events-explorer.html" class="nav-card">
          <div class="nav-card-icon">☁️</div>
          <div class="nav-card-title">Cloud Events Explorer</div>
          <div class="nav-card-desc">Browse and inspect BC cloud events</div>
        </a>
        <a href="bc-metadata-explorer.html" class="nav-card">
          <div class="nav-card-icon">🔍</div>
          <div class="nav-card-title">Metadata Explorer</div>
          <div class="nav-card-desc">Fields and captions per entity</div>
        </a>
        <a href="sales-assistant.html" class="nav-card">
          <div class="nav-card-icon">🤖</div>
          <div class="nav-card-title">AI Sales Assistant</div>
          <div class="nav-card-desc">AI-powered sales order entry</div>
        </a>
      </div>
    </div>
  </main>
</div>
<script>/* see JavaScript Logic section */</script>
</body>
</html>
```

### JavaScript Logic

```js
// ---- MODE ----
function setMode(mode) {
  localStorage.setItem('bc_portal_mode', mode);
  document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  document.getElementById('server-info').style.display   = mode === 'server' ? '' : 'none';
  document.getElementById('custom-fields').style.display = mode === 'custom' ? '' : 'none';
  loadCompanies();
}

// ---- COMPANIES ----
async function loadCompanies() {
  const mode = localStorage.getItem('bc_portal_mode') || 'server';
  const h = mode === 'custom' ? credHeaders() : null;
  if (mode === 'custom' && !h) return; // creds not filled yet

  const sel = document.getElementById('s-company');
  sel.innerHTML = '<option value="">— loading… —</option>';
  try {
    const r = await fetch('/api/companies', h ? { headers: h } : {});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    sel.innerHTML = '<option value="">— select company —</option>' +
      j.companies.map(c =>
        `<option value="${c.id}">${c.displayName || c.name}</option>`).join('');
    const saved = localStorage.getItem('bc_portal_company_id');
    if (saved) {
      const opt = [...sel.options].find(o => o.value === saved);
      if (opt) { opt.selected = true; onCompanyChange(false); }
    }
  } catch(e) {
    sel.innerHTML = '<option value="">— failed to load —</option>';
    showStatus('Could not load companies: ' + e.message, 'error');
  }
}

// ---- COMPANY CHANGE ----
async function onCompanyChange(saveNow = true) {
  const sel  = document.getElementById('s-company');
  const id   = sel.value;
  const name = sel.options[sel.selectedIndex]?.text || '';
  if (!id) return;
  if (saveNow) bcSettingsSave({ companyId: id, companyName: name });
  await loadLanguages(id);
  if (bcSettingsReady()) {
    showStatus('Connected as ' + (name || id), 'ok');
    document.getElementById('nav-section').style.display = '';
  }
}

// ---- LANGUAGE ----
async function loadLanguages(companyId) {
  const h = bcSettingsHeaders(); // null in server mode → function uses env vars
  try {
    const r = await fetch(`/api/explorer?action=languages&companyId=${companyId}`,
      h ? { headers: h } : {});
    const j = await r.json();
    const sel = document.getElementById('s-lang');
    sel.innerHTML = (j.languages || []).map(l =>
      `<option value="${l.lcid}">${l.name}</option>`).join('');
    const saved = localStorage.getItem('bc_portal_lcid');
    if (saved) {
      const opt = [...sel.options].find(o => o.value === saved);
      if (opt) opt.selected = true;
    }
  } catch(e) { /* non-critical */ }
}

function onLangChange() {
  bcSettingsSave({ lcid: document.getElementById('s-lang').value });
}

// ---- CONNECT BUTTON ----
function connect() {
  const mode = localStorage.getItem('bc_portal_mode') || 'server';
  if (mode === 'custom') {
    const h = credHeaders();
    if (!h) { showStatus('Fill in all credential fields.', 'error'); return; }
    bcSettingsSave({
      tenant:       document.getElementById('s-tenant').value.trim(),
      env:          document.getElementById('s-env').value.trim(),
      clientId:     document.getElementById('s-client-id').value.trim(),
      clientSecret: document.getElementById('s-client-secret').value.trim()
    });
    loadCompanies();
  }
  const sel = document.getElementById('s-company');
  if (sel.value) onCompanyChange();
}

// ---- HELPERS ----
function credHeaders() {
  const t  = document.getElementById('s-tenant').value.trim();
  const e  = document.getElementById('s-env').value.trim();
  const ci = document.getElementById('s-client-id').value.trim();
  const cs = document.getElementById('s-client-secret').value.trim();
  if (!t || !e || !ci || !cs) return null;
  return { 'x-bc-tenant': t, 'x-bc-env': e, 'x-bc-client-id': ci, 'x-bc-client-secret': cs };
}

function showStatus(msg, type) {
  const el = document.getElementById('connect-status');
  el.textContent = msg;
  el.className = 'connect-status ' + (type || '');
}

// ---- SERVER INFO PANEL ----
async function loadServerInfo() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) return;
    const c = await r.json();
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = val || 'not set'; if (!val) el.className = 'config-val missing'; }
    };
    set('cfg-tenant', c.BC_TENANT_ID);
    set('cfg-env', c.BC_ENVIRONMENT);
    set('cfg-client-id', c.BC_CLIENT_ID);
    const sec = document.getElementById('cfg-secret');
    if (sec) sec.innerHTML = c.BC_CLIENT_SECRET
      ? '<span class="config-secret-set">● set</span>'
      : '<span class="config-secret-missing">✕ not set</span>';
    document.getElementById('server-info').style.display = '';
  } catch(e) { /* silently skip if /api/config not deployed */ }
}

// ---- BOOT ----
window.onload = async () => {
  const mode = localStorage.getItem('bc_portal_mode') || 'server';
  setMode(mode);
  if (mode === 'server') await loadServerInfo();
  if (mode === 'custom') {
    const s = bcSettingsLoad();
    document.getElementById('s-tenant').value        = s.tenant       || '';
    document.getElementById('s-env').value           = s.env          || '';
    document.getElementById('s-client-id').value     = s.clientId     || '';
    document.getElementById('s-client-secret').value = s.clientSecret || '';
  }
  if (bcSettingsReady()) {
    showStatus('Connected as ' + (bcSettingsLoad().companyName || '…'), 'ok');
    document.getElementById('nav-section').style.display = '';
  }
};
```

---

## `bc-portal.html` — Moved BC Portal

Copy `index.html` to `bc-portal.html` and apply the following changes:

1. **Remove** the three header pill nav links.
2. **Replace** with a single "← Home" pill link pointing to `index.html`.
3. **Keep** `loadConfig()` and `window.onload → loadConfig()` as-is — `bc-portal.html` continues using server-side credentials. No changes to `api/bc` calls.
4. **Add guard redirect** at the top of the inline `<script>` block:
   ```js
   (function() {
     if (!localStorage.getItem('bc_portal_company_id')) location.href = 'index.html';
   })();
   ```
5. `<title>` → `BC Portal`.

### Updated header

```html
<header>
  <a class="logo" href="index.html" style="text-decoration:none;color:inherit">
    <div class="logo-icon"><img src="origo.jpeg" alt="Origo"></div>
    BC Portal <span>/ Business Central</span>
  </a>
  <div class="header-right">
    <a href="index.html"
       style="display:flex;align-items:center;gap:6px;padding:5px 14px;background:var(--surface);border:1px solid var(--border);border-radius:99px;font-size:0.72rem;color:var(--text-mid);text-decoration:none;transition:border-color 0.2s,color 0.2s"
       onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--text)'"
       onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-mid)'">← Home</a>
    <!-- lang-wrap and status-pill stay as-is -->
  </div>
</header>
```

---

## Sub-pages (`bc-cloud-events-explorer.html`, `bc-metadata-explorer.html`, `sales-assistant.html`)

### Header change

Remove the three inline pill links and replace with a single "← Home" link:

```html
<a href="index.html"
   style="display:flex;align-items:center;gap:6px;padding:5px 14px;background:var(--surface);border:1px solid var(--border);border-radius:99px;font-size:0.72rem;color:var(--text-mid);text-decoration:none;transition:border-color 0.2s,color 0.2s"
   onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--text)'"
   onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-mid)'">← Home</a>
```

### Remove settings panels

Delete `<details id="settingsPanel">…</details>` from each page.

### Add guard redirect

Add at the very top of each page's inline `<script>` (before `settings.js` functions are called):

```js
(function() {
  if (!bcSettingsReady()) location.href = 'index.html';
})();
```

### API call pattern

`bcSettingsHeaders()` now returns `null` in server mode, which is safe to spread or pass directly — a `null`/omitted `headers` option means the browser sends no custom headers and the Azure Function falls back to env vars. No changes to existing `fetch` calls are required.

---

## CSS — Navigation Cards

Add to `index.html`:

```css
.nav-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.nav-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 20px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-decoration: none;
  color: var(--text);
  transition: border-color 0.2s, background 0.2s;
}

.nav-card:hover {
  border-color: var(--accent);
  background: var(--surface2);
}

.nav-card-icon  { font-size: 1.6rem; }
.nav-card-title { font-weight: 600; font-size: 0.9rem; }
.nav-card-desc  { font-size: 0.75rem; color: var(--text-mid); }

.mode-row { display: flex; gap: 20px; margin-bottom: 12px; }
.mode-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.85rem; }
```

---

## `staticwebapp.config.json`

Verify `navigationFallback` excludes all real `.html` files so direct navigation to `bc-portal.html` etc. is not caught by the SPA rewrite:

```json
{
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/*.html", "/api/*", "/*.js", "/*.css", "/*.jpeg", "/*.png"]
  }
}
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `index.html` | **Rewritten** as connection landing page |
| `bc-portal.html` | **New** — copy of current `index.html` with header + guard changes |
| `bc-cloud-events-explorer.html` | Remove settings panel; replace 3 nav pills with "← Home"; add guard redirect |
| `bc-metadata-explorer.html` | Same as above |
| `sales-assistant.html` | Same as above |
| `settings.js` | Update `bcSettingsReady()` and `bcSettingsHeaders()` for `bc_portal_mode` awareness |
| `api/companies/index.js` | Add env-var fallback when `x-bc-*` headers absent |
| `customer-create.js` / `customer-create.css` | Referenced by `bc-portal.html` — no changes |
| `staticwebapp.config.json` | Verify `navigationFallback` exclude list |

---

## Testing Checklist

- [ ] Opening `index.html` with empty `localStorage`: server mode selected, company dropdown populated from server env vars, nav cards hidden.
- [ ] Selecting a company in server mode: `bc_portal_company_id` saved, language dropdown loaded, nav cards appear, status shows "Connected as {name}".
- [ ] Refreshing `index.html` after prior connection: mode pre-selected, company pre-selected, nav cards immediately visible.
- [ ] Switching to custom mode: credential fields appear, company dropdown clears until credentials entered and Connect clicked.
- [ ] Entering custom credentials and clicking Connect: `/api/companies` called with headers, dropdown populated.
- [ ] Switching back to server mode: credential fields hidden, server info panel shown, companies reloaded from env vars.
- [ ] Navigating to `bc-portal.html` with `bc_portal_company_id` set: loads normally, "← Home" link visible.
- [ ] Navigating to `bc-portal.html` with empty `localStorage`: redirected to `index.html`.
- [ ] Opening `bc-metadata-explorer.html` directly with `bcSettingsReady()` false: redirected to `index.html`.
- [ ] Opening `bc-metadata-explorer.html` in custom mode with settings ready: page loads, no settings panel visible.
- [ ] Opening `bc-metadata-explorer.html` in server mode with company set: page loads, API calls use no credential headers.
- [ ] Language selected on `index.html` is picked up by sub-pages via `bc_portal_lcid`.
- [ ] "← Home" link on all sub-pages navigates back to `index.html`.

---

## Status

| Task | Status |
|------|--------|
| Update `settings.js` — mode-aware `bcSettingsReady()` / `bcSettingsHeaders()` | ❌ Not Implemented |
| Update `/api/companies` — env-var fallback | ❌ Not Implemented |
| Create `bc-portal.html` from `index.html` | ❌ Not Implemented |
| Rewrite `index.html` as landing page | ❌ Not Implemented |
| Update header + remove settings panel on sub-pages (×3) | ❌ Not Implemented |
| Guard redirect on `bc-portal.html` and sub-pages (×4) | ❌ Not Implemented |
| CSS — nav cards + mode row | ❌ Not Implemented |
| `staticwebapp.config.json` — verify exclude list | ❌ Not Implemented |

