#!/usr/bin/env node
/**
 * IOBWS WS-Security signing test harness.
 *
 * Reads a PFX certificate, builds a sample SOAP envelope, signs it, and optionally
 * sends it to the bank. Useful for diagnosing signature verification failures without
 * needing to run the full Azure Functions host.
 *
 * Usage:
 *   node api/test-signer.js [options]
 *
 * Options:
 *   --pfx <path>            Path to .pfx / .p12 file
 *   --password <pass>       PFX password (default: empty)
 *   --service <url>         Target service URL
 *                           (default: https://ws.b2b.is/Statements/20131015/AccountService.svc)
 *   --action <uri>          SOAP action URI
 *                           (default: http://IcelandicOnlineBanking/2013/10/15/GetAccountStatement)
 *   --username <user>       IOBWS username
 *   --iobws-password <pw>   IOBWS password
 *   --send                  Actually POST to the bank (default: dry-run, xml only)
 *   --pretty                Run a basic XML indent pass on the output
 *
 * Environment variable fallbacks (same as the Azure Function):
 *   CLIENT_CERT_PFX         Base64-encoded PFX (alternative to --pfx)
 *   CLIENT_CERT_PASSWORD    PFX password
 *   IOBWS_USERNAME          IOBWS username
 *   IOBWS_PASSWORD          IOBWS password
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { buildEnvelope, signEnvelope, postToBank, parsePfx, detectSoapVersion } =
  require('./shared/iobwsSigner');

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const hasFlag = flag => args.includes(flag);

// ── Certificate ───────────────────────────────────────────────────────────────

let pfxBuffer;
const pfxPath = getArg('--pfx');
if (pfxPath) {
  pfxBuffer = fs.readFileSync(path.resolve(pfxPath));
} else if (process.env.CLIENT_CERT_PFX) {
  pfxBuffer = Buffer.from(process.env.CLIENT_CERT_PFX, 'base64');
} else {
  console.error('ERROR: supply --pfx <path> or set CLIENT_CERT_PFX env var (base64)');
  process.exit(1);
}
const pfxPassword    = getArg('--password')       ?? process.env.CLIENT_CERT_PASSWORD ?? '';
const username       = getArg('--username')        ?? process.env.IOBWS_USERNAME       ?? '';
const iobwsPassword  = getArg('--iobws-password')  ?? process.env.IOBWS_PASSWORD       ?? '';
const serviceUrl     = getArg('--service')
  ?? 'https://ws.b2b.is/Statements/20131015/AccountService.svc';
const soapAction     = getArg('--action')
  ?? 'http://IcelandicOnlineBanking/2013/10/15/GetAccountStatement';

// Sample body — change to test different operations
const body =
  '<GetAccountStatement xmlns="http://IcelandicOnlineBanking/2013/10/15/Accounts">\n' +
  '  <Query xmlns:at="http://IcelandicOnlineBanking/2013/10/15/AccountTypes">\n' +
  '    <at:Account></at:Account>\n' +
  '    <at:DateFrom>2026-01-01</at:DateFrom>\n' +
  '    <at:DateTo>2026-01-31</at:DateTo>\n' +
  '  </Query>\n' +
  '</GetAccountStatement>';

// ── Simple XML prettifier (for readability only — does not change semantics) ──

function prettyXml(xml) {
  let indent = 0;
  return xml
    .replace(/>\s*</g, '>\n<')  // one element per line
    .split('\n')
    .map(line => {
      line = line.trim();
      if (!line) return '';
      if (line.match(/^<\/[^>]+>/))  indent = Math.max(0, indent - 1);
      const out = '  '.repeat(indent) + line;
      if (line.match(/^<[^?!\/][^>]*[^\/]>$/) && !line.match(/<.*>.*<\//)) indent++;
      return out;
    })
    .filter(Boolean)
    .join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  let cert;
  try {
    cert = parsePfx(pfxBuffer, pfxPassword);
    console.error('✓ PFX parsed  (cert + key extracted)');
  } catch (e) {
    console.error('✗ PFX parse failed:', e.message);
    process.exit(1);
  }

  const soapVersion = detectSoapVersion(serviceUrl);
  console.error(`✓ SOAP version: ${soapVersion}  (${serviceUrl})`);
  console.error(`  action      : ${soapAction}`);

  const envelope = buildEnvelope(
    { serviceUrl, soapAction, username, password: iobwsPassword, body },
    soapVersion, cert.cert,
  );
  console.error('✓ Envelope built');

  let signedXml;
  try {
    signedXml = signEnvelope(envelope, cert.cert, cert.key);
    console.error('✓ Envelope signed');
  } catch (e) {
    console.error('✗ Signing failed:', e.message);
    process.exit(1);
  }

  const output = hasFlag('--pretty') ? prettyXml(signedXml) : signedXml;
  console.log(output);

  if (hasFlag('--send')) {
    console.error(`\n→ Sending to ${serviceUrl} …`);
    try {
      const response = await postToBank(serviceUrl, soapAction, signedXml, soapVersion);
      console.error('← Response received');
      console.error(hasFlag('--pretty') ? prettyXml(response) : response);
    } catch (e) {
      console.error('✗ Network error:', e.message);
    }
  } else {
    console.error('\n(dry-run — add --send to actually POST to the bank)');
  }
})();
