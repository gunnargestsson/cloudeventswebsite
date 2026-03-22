'use strict';

/**
 * Íslandsbanki IOBWS Proxy — Requirement 18
 *
 * POST /api/islandsbanki?key={api-key}
 * Body: { serviceUrl, soapAction, username, password, body }
 *
 * Validates the API key and serviceUrl, loads the client certificate, then
 * delegates all SOAP construction and WS-Security signing to the shared module.
 * Supports both the shared Sambankaskema 2013 platform (ws.b2b.is) and
 * Íslandsbanki's proprietary ASMX endpoint (netbanki.islandsbanki.is).
 *
 * Environment variables:
 *   ISLANDSBANKI_API_KEY              (optional — overrides shared key)
 *   IOBWS_API_KEY                     (required if no bank-specific key)
 *   ISLANDSBANKI_CLIENT_CERT_PFX      (optional — overrides shared cert)
 *   CLIENT_CERT_PFX                   (required if no bank-specific cert)
 *   ISLANDSBANKI_CLIENT_CERT_PASSWORD (optional)
 *   CLIENT_CERT_PASSWORD              (optional, default: '')
 */

const { sign, parsePfx } = require('../shared/iobwsSigner');

// SSRF allowlist — hosts that may appear as serviceUrl
const ALLOWLIST = new Set([
  'ws.b2b.is',
  'ws-dev.b2b.is',
  'ws-int.b2b.is',
  'ws-test.b2b.is',
  'netbanki.islandsbanki.is',
]);

// Module-level certificate cache — parsed once per warm instance
let _certCache = null;

function resolveApiKey() {
  return process.env.ISLANDSBANKI_API_KEY || process.env.IOBWS_API_KEY || '';
}

function loadCert() {
  if (_certCache) return _certCache;
  const pfxB64  = process.env.ISLANDSBANKI_CLIENT_CERT_PFX       || process.env.CLIENT_CERT_PFX      || '';
  const pfxPass = process.env.ISLANDSBANKI_CLIENT_CERT_PASSWORD   || process.env.CLIENT_CERT_PASSWORD || '';
  if (!pfxB64) throw new Error('Certificate not configured: CLIENT_CERT_PFX env var is missing');
  _certCache = parsePfx(Buffer.from(pfxB64, 'base64'), pfxPass);
  return _certCache;
}

function extractHostname(serviceUrl) {
  try { return new URL(serviceUrl).hostname.toLowerCase(); }
  catch (_) { return null; }
}

module.exports = async function (context, req) {
  // 1. API key validation
  const expectedKey = resolveApiKey();
  const providedKey = (req.query && req.query.key) || '';
  if (!expectedKey || providedKey !== expectedKey) {
    context.res = { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    return;
  }

  // 2. Required field validation
  const params = req.body || {};
  for (const field of ['serviceUrl', 'soapAction', 'username', 'password', 'body']) {
    if (!params[field]) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Missing required field: ${field}` }) };
      return;
    }
  }

  // 3. SSRF guard
  const host = extractHostname(params.serviceUrl);
  if (!host || !ALLOWLIST.has(host)) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'serviceUrl host is not in the Íslandsbanki allowlist' }) };
    return;
  }

  // 4. Load client certificate
  let cert;
  try {
    cert = loadCert();
  } catch (err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Certificate load failed: ${err.message}` }) };
    return;
  }

  // 5. Sign and forward to bank
  try {
    const responseXml = await sign(params, cert);
    context.res = { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: responseXml };
  } catch (err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
