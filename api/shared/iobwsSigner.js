'use strict';

/**
 * iobwsSigner.js — Shared WS-Security signing infrastructure for IOBWS proxy functions.
 *
 * Exports:
 *   sign(params, clientCert)   Build, sign, and POST a WS-Security SOAP message.
 *   parsePfx(pfxBuffer, password)  Parse a PFX (PKCS#12) bundle into { cert, key }.
 *
 * All bank-specific proxy functions delegate entirely to this module.
 * The shared module does NOT validate serviceUrl or API keys — those are the
 * responsibility of each bank proxy function.
 *
 * Dependencies: xml-crypto ^6, node-forge ^1.3, uuid ^9
 */

const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { v4: uuidv4 } = require('uuid');

// ── PFX parsing ───────────────────────────────────────────────────────────────

/**
 * Parse a PFX (PKCS#12) buffer into a DER-encoded certificate and PEM private key.
 *
 * @param {Buffer} pfxBuffer  Raw PFX bytes
 * @param {string} password   PFX password (pass '' if none)
 * @returns {{ cert: Buffer, key: string }}
 */
function parsePfx(pfxBuffer, password) {
  const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password || '');

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBagArr = certBags[forge.pki.oids.certBag] || [];
  if (!certBagArr.length) throw new Error('PFX contains no certificate');

  // Support both pkcs8ShroudedKeyBag and keyBag
  let privateKey;
  const shroudedBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const shroudedArr = shroudedBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  if (shroudedArr.length) {
    privateKey = shroudedArr[0].key;
  } else {
    const keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag });
    const keyBagArr = keyBags[forge.pki.oids.keyBag] || [];
    if (!keyBagArr.length) throw new Error('PFX contains no private key');
    privateKey = keyBagArr[0].key;
  }

  const cert = certBagArr[0].cert;
  return {
    cert: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'),
    key: forge.pki.privateKeyToPem(privateKey),
  };
}

// ── SOAP version detection ────────────────────────────────────────────────────

/**
 * Detect SOAP version (1.1 or 1.2) from the service URL.
 * URLs containing '/20131015/' use the 2013 Sambankaskema schema → SOAP 1.2 (WCF).
 * All other paths (ASMX / older schemas) use SOAP 1.1.
 *
 * @param {string} serviceUrl
 * @returns {'1.1'|'1.2'}
 */
function detectSoapVersion(serviceUrl) {
  return serviceUrl.includes('/20131015/') ? '1.2' : '1.1';
}

// ── XML escaping ──────────────────────────────────────────────────────────────

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Envelope builder ──────────────────────────────────────────────────────────

/**
 * Build an unsigned SOAP envelope containing WS-Addressing headers, WS-Security
 * Timestamp, BinarySecurityToken, and the caller-supplied body.
 *
 * IDs used in this envelope: Body-1, TS-1, BST-1
 *
 * @param {{ serviceUrl, soapAction, username, password, body }} params
 * @param {'1.1'|'1.2'} soapVersion
 * @param {Buffer} certDer  DER-encoded client certificate (for BinarySecurityToken)
 * @returns {string} Unsigned XML envelope
 */
function buildEnvelope(params, soapVersion, certDer) {
  const { serviceUrl, soapAction, username, password, body } = params;

  const sNs = soapVersion === '1.2'
    ? 'http://www.w3.org/2003/05/soap-envelope'
    : 'http://schemas.xmlsoap.org/soap/envelope/';

  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000);
  const created = now.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const expiresStr = expires.toISOString().replace(/\.\d{3}Z$/, '.000Z');

  const msgId = uuidv4();
  const b64cert = certDer.toString('base64');

  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope
    xmlns:s="${sNs}"
    xmlns:wsa="http://www.w3.org/2005/08/addressing"
    xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
    xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
    xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <s:Header>
    <wsa:Action s:mustUnderstand="1">${escXml(soapAction)}</wsa:Action>
    <wsa:MessageID>urn:uuid:${msgId}</wsa:MessageID>
    <wsa:ReplyTo>
      <wsa:Address>http://www.w3.org/2005/08/addressing/anonymous</wsa:Address>
    </wsa:ReplyTo>
    <wsa:To s:mustUnderstand="1" wsu:Id="Id-To">${escXml(serviceUrl)}</wsa:To>
    <UserName xmlns="http://IcelandicOnlineBanking/Security/">${escXml(username)}</UserName>
    <Password xmlns="http://IcelandicOnlineBanking/Security/">${escXml(password)}</Password>
    <wsse:Security s:mustUnderstand="1">
      <wsu:Timestamp wsu:Id="TS-1">
        <wsu:Created>${created}</wsu:Created>
        <wsu:Expires>${expiresStr}</wsu:Expires>
      </wsu:Timestamp>
      <wsse:BinarySecurityToken
          ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"
          EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
          wsu:Id="BST-1">${b64cert}</wsse:BinarySecurityToken>
    </wsse:Security>
  </s:Header>
  <s:Body wsu:Id="Body-1">
    ${body}
  </s:Body>
</s:Envelope>`;
}

// ── WS-Security signature ─────────────────────────────────────────────────────

/**
 * Apply a WS-Security XML digital signature to the envelope.
 * Signs Body-1 and TS-1 using RSA-SHA1 with Exclusive C14N.
 * KeyInfo references BinarySecurityToken BST-1.
 *
 * @param {string} xmlString   Unsigned SOAP envelope
 * @param {Buffer} certDer     DER-encoded client certificate
 * @param {string} keyPem      PEM-encoded private key
 * @returns {string} Signed XML envelope
 */
function signEnvelope(xmlString, certDer, keyPem) {
  const sig = new SignedXml({ privateKey: keyPem });

  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.signatureAlgorithm        = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';

  sig.addReference({
    xpath: '//*[@wsu:Id="Body-1"]',
    transforms: ['http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  });

  sig.addReference({
    xpath: '//*[@wsu:Id="TS-1"]',
    transforms: ['http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  });

  sig.keyInfoProvider = {
    getKeyInfo() {
      return '<wsse:SecurityTokenReference' +
        ' xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
        '<wsse:Reference URI="#BST-1"' +
        ' ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>' +
        '</wsse:SecurityTokenReference>';
    },
  };

  sig.computeSignature(xmlString, {
    location: { reference: '//*[local-name()="Security"]', action: 'append' },
  });

  return sig.getSignedXml();
}

// ── HTTP dispatch ─────────────────────────────────────────────────────────────

/**
 * POST the signed SOAP envelope to the bank service.
 * Returns the raw response body as a string regardless of HTTP status —
 * SOAP faults are passed through so BC AL can inspect them.
 *
 * @param {string} serviceUrl
 * @param {string} soapAction
 * @param {string} signedXml
 * @param {'1.1'|'1.2'} soapVersion
 * @returns {Promise<string>} Raw SOAP response XML
 */
async function postToBank(serviceUrl, soapAction, signedXml, soapVersion) {
  const contentType = soapVersion === '1.2'
    ? `application/soap+xml; action="${soapAction}"; charset=utf-8`
    : 'text/xml; charset=utf-8';

  const headers = { 'Content-Type': contentType };
  if (soapVersion === '1.1') headers['SOAPAction'] = `"${soapAction}"`;

  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers,
    body: signedXml,
  });

  return response.text();
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Build, sign, and POST a WS-Security SOAP message.
 *
 * @param {{ serviceUrl: string, soapAction: string, username: string, password: string, body: string }} params
 * @param {{ cert: Buffer, key: string }} clientCert  Pre-parsed certificate and private key
 * @returns {Promise<string>} Raw SOAP response XML
 */
async function sign(params, clientCert) {
  const soapVersion = detectSoapVersion(params.serviceUrl);
  const envelope    = buildEnvelope(params, soapVersion, clientCert.cert);
  const signedXml   = signEnvelope(envelope, clientCert.cert, clientCert.key);
  return postToBank(params.serviceUrl, params.soapAction, signedXml, soapVersion);
}

module.exports = { sign, parsePfx, detectSoapVersion, buildEnvelope, signEnvelope, postToBank };
