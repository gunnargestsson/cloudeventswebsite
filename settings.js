// settings.js — Shared BC Portal connection settings
// Persists credentials in localStorage under bc_portal_* keys.
// Loaded by: bc-metadata-explorer.html, bc-cloud-events-explorer.html, sales-assistant.html
"use strict";

const _PFX  = 'bc_portal_';
const _KEYS = {
  tenant:       'tenant',
  env:          'env',
  clientId:     'client_id',
  clientSecret: 'client_secret',
  companyId:    'company_id',
  companyName:  'company_name',
  lcid:         'lcid',
  claudeApiKey: 'claude_api_key',
  iobwsApiKey:  'iobws_api_key',
};

function bcSettingsLoad() {
  const out = {};
  for (const [prop, key] of Object.entries(_KEYS))
    out[prop] = localStorage.getItem(_PFX + key) || '';
  return out;
}

function bcSettingsSave(obj) {
  for (const [prop, key] of Object.entries(_KEYS))
    if (obj[prop] !== undefined) localStorage.setItem(_PFX + key, String(obj[prop]));
}

function bcSettingsClear() {
  for (const key of Object.values(_KEYS))
    localStorage.removeItem(_PFX + key);
}

function bcClaudeApiKeyLoad() {
  // Backward compatibility for older page-specific keys.
  return (
    localStorage.getItem(_PFX + _KEYS.claudeApiKey) ||
    localStorage.getItem('sa_claude_key') ||
    localStorage.getItem('claude_mcp_api_key') ||
    ''
  );
}

function bcClaudeApiKeySave(value) {
  const key = String(value || '').trim();
  if (key) {
    localStorage.setItem(_PFX + _KEYS.claudeApiKey, key);
    // Keep legacy keys in sync during migration.
    localStorage.setItem('sa_claude_key', key);
    localStorage.setItem('claude_mcp_api_key', key);
    return;
  }
  localStorage.removeItem(_PFX + _KEYS.claudeApiKey);
  localStorage.removeItem('sa_claude_key');
  localStorage.removeItem('claude_mcp_api_key');
}

function bcIobwsApiKeyLoad() {
  // Backward compatibility — legacy key was stored without the bc_portal_ prefix.
  return (
    localStorage.getItem(_PFX + _KEYS.iobwsApiKey) ||
    localStorage.getItem('iobws_api_key') ||
    ''
  );
}

function bcIobwsApiKeySave(value) {
  const key = String(value || '').trim();
  if (key) {
    localStorage.setItem(_PFX + _KEYS.iobwsApiKey, key);
    // Keep legacy key in sync during migration.
    localStorage.setItem('iobws_api_key', key);
    return;
  }
  localStorage.removeItem(_PFX + _KEYS.iobwsApiKey);
  localStorage.removeItem('iobws_api_key');
}

function bcSettingsReady() {
  const mode = localStorage.getItem('bc_portal_mode') || 'server';
  if (mode === 'server') {
    return !!localStorage.getItem('bc_portal_company_id');
  }
  const s = bcSettingsLoad();
  return !!(s.tenant && s.env && s.clientId && s.clientSecret && s.companyId);
}

/**
 * In server mode: returns only { 'x-bc-company': companyId } so the Azure Function
 * falls back to env vars for credentials while the company selection comes from the client.
 * In custom mode: returns the full credential header set, or null if any field is missing.
 */
function bcSettingsHeaders() {
  const s = bcSettingsLoad();
  const mode = localStorage.getItem('bc_portal_mode') || 'server';
  if (mode === 'server') {
    return s.companyId ? { 'x-bc-company': s.companyId } : null;
  }
  if (!s.tenant || !s.env || !s.clientId || !s.clientSecret || !s.companyId) return null;
  return {
    'x-bc-tenant':        s.tenant,
    'x-bc-client-id':     s.clientId,
    'x-bc-client-secret': s.clientSecret,
    'x-bc-environment':   s.env,
    'x-bc-company':       s.companyId,
  };
}

// ── Translation ───────────────────────────────────────────────────────────────
let _uiTranslations = {};

function t(s) { return _uiTranslations[s] || s; }

function applyUiTranslations() {
  document.querySelectorAll('[data-t]').forEach(el  => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-tp]').forEach(el => { el.placeholder = t(el.dataset.tp); });
}

async function bcLoadTranslations(companyId, lcid, uiStrings, headers) {
  _uiTranslations = {};
  if (!lcid || lcid === 1033) return;  // English — no fetch needed
  try {
    const res = await fetch('/api/explorer', {
      method: 'POST',
      headers: { ...headers, 'x-bc-endpoint': 'tasks', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specversion: '1.0', type: 'Data.Records.Get', source: 'BC Portal',
        subject: 'Cloud Event Translation',
        data: JSON.stringify({
          tableView: `WHERE(Windows Language ID=CONST(${lcid}),Source=CONST(BC Portal))`,
          take: uiStrings.length + 50,
        }),
      }),
    }).then(r => r.json());

    const rows = res.result || [];
    for (const rec of rows) {
      const src = (rec.primaryKey || {}).SourceText;
      const tgt = (rec.fields    || {}).TargetText;
      if (src && tgt) _uiTranslations[src] = tgt;
    }

    // Auto-create placeholder records for strings not yet in the translation table
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
              fields:     { TargetText: '' },
            })),
          }),
        }),
      });
    }
  } catch (_) { /* silently fall back to English on any error */ }
}
