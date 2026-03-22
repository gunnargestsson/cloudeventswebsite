'use strict';

/**
 * Sparisjóðir IOBWS Proxy — Requirement 19
 *
 * POST /api/sparisjodur?key={api-key}
 * Body: { serviceUrl, soapAction, username, password, body }
 *
 * Validates the API key and serviceUrl, loads the client certificate, then
 * delegates all SOAP construction and WS-Security signing to the shared module.
 *
 * All supported savings banks use the Sambankaskema (IOBS) standard and each
 * operates its own endpoint on the heimabanki.is hosting platform. The target
 * savings bank is selected entirely by the serviceUrl field in the request.
 *
 * SSRF policy: any hostname ending in '-iobs.heimabanki.is' is accepted.
 * An explicit allowlist of known savings banks is also maintained; new banks
 * following the suffix pattern are admitted without a code change.
 *
 * Environment variables:
 *   SPARISJODUR_API_KEY              (required)
 *   SPARISJODUR_CLIENT_CERT_PFX      (optional — overrides shared cert)
 *   CLIENT_CERT_PFX                  (required if no group-specific cert)
 *   SPARISJODUR_CLIENT_CERT_PASSWORD (optional)
 *   CLIENT_CERT_PASSWORD             (optional, default: '')
 */

const { sign, parsePfx } = require('../shared/iobwsSigner');

// Explicit allowlist of known savings bank IOBS hostnames
const EXPLICIT_ALLOWLIST = new Set([
  'sparaust-iobs.heimabanki.is',
  'spthin-iobs.heimabanki.is',
  'spsh-iobs.heimabanki.is',
  'spstr-iobs.heimabanki.is',
]);

// SSRF guard: accept any savings bank following the standard naming convention
function isAllowedHost(host) {
  return EXPLICIT_ALLOWLIST.has(host) || host.endsWith('-iobs.heimabanki.is');
}

// Module-level certificate cache — parsed once per warm instance
let _certCache = null;

function resolveApiKey() {
  return process.env.SPARISJODUR_API_KEY || '';
}

function loadCert() {
  if (_certCache) return _certCache;
  const pfxB64  = process.env.SPARISJODUR_CLIENT_CERT_PFX       || process.env.CLIENT_CERT_PFX      || '';
  const pfxPass = process.env.SPARISJODUR_CLIENT_CERT_PASSWORD   || process.env.CLIENT_CERT_PASSWORD || '';
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
  if (!host || !isAllowedHost(host)) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'serviceUrl host is not in the Sparisjóðir allowlist' }) };
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
