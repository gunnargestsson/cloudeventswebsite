'use strict';

/**
 * Certificate Info — GET /api/cert?bank={slug}&key={api-key}
 *
 * Returns the properties of the PFX certificate configured for the given bank:
 * subject, issuer, serial, validity dates, SHA1 thumbprint, key algorithm,
 * key size, and Subject Alternative Names.
 *
 * Environment variables mirror each bank proxy function's resolution order.
 */

const forge = require('node-forge');

// ── Per-bank configuration ────────────────────────────────────────────────────
const BANK_CONFIGS = {
  landsbankinn: {
    keyEnvs:  ['LANDSBANKINN_API_KEY',          'IOBWS_API_KEY'],
    certEnvs: ['LANDSBANKINN_CLIENT_CERT_PFX',  'CLIENT_CERT_PFX'],
    passEnvs: ['LANDSBANKINN_CLIENT_CERT_PASSWORD', 'CLIENT_CERT_PASSWORD'],
  },
  arionbanki: {
    keyEnvs:  ['ARIONBANKI_API_KEY',             'IOBWS_API_KEY'],
    certEnvs: ['ARIONBANKI_CLIENT_CERT_PFX',     'CLIENT_CERT_PFX'],
    passEnvs: ['ARIONBANKI_CLIENT_CERT_PASSWORD', 'CLIENT_CERT_PASSWORD'],
  },
  islandsbanki: {
    keyEnvs:  ['ISLANDSBANKI_API_KEY',            'IOBWS_API_KEY'],
    certEnvs: ['ISLANDSBANKI_CLIENT_CERT_PFX',    'CLIENT_CERT_PFX'],
    passEnvs: ['ISLANDSBANKI_CLIENT_CERT_PASSWORD', 'CLIENT_CERT_PASSWORD'],
  },
  sparisjodur: {
    keyEnvs:  ['SPARISJODUR_API_KEY'],
    certEnvs: ['SPARISJODUR_CLIENT_CERT_PFX',    'CLIENT_CERT_PFX'],
    passEnvs: ['SPARISJODUR_CLIENT_CERT_PASSWORD', 'CLIENT_CERT_PASSWORD'],
  },
  kvika: {
    keyEnvs:  ['KVIKA_API_KEY'],
    certEnvs: ['KVIKA_CLIENT_CERT_PFX',          'CLIENT_CERT_PFX'],
    passEnvs: ['KVIKA_CLIENT_CERT_PASSWORD',      'CLIENT_CERT_PASSWORD'],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveEnv(envNames) {
  for (const name of envNames) {
    const v = process.env[name];
    if (v) return v;
  }
  return '';
}

function formatDN(attrs) {
  return attrs.map(a => `${a.shortName || a.type}=${a.value}`).join(', ');
}

function sha1Fingerprint(forgeCert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forgeCert)).getBytes();
  const md  = forge.md.sha1.create();
  md.update(der);
  return md.digest().toHex().toUpperCase().match(/.{2}/g).join(':');
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function (context, req) {
  const bank        = ((req.query && req.query.bank) || '').trim().toLowerCase();
  const providedKey = ((req.query && req.query.key)  || '').trim();

  // 1. Validate bank slug
  const config = BANK_CONFIGS[bank];
  if (!config) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Unknown bank: ${bank}` }) };
    return;
  }

  // 2. API key validation — mirrors each bank's proxy function
  const expectedKey = resolveEnv(config.keyEnvs);
  if (!expectedKey || providedKey !== expectedKey) {
    context.res = { status: 401, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }) };
    return;
  }

  // 3. Resolve certificate
  const pfxB64  = resolveEnv(config.certEnvs);
  const pfxPass = resolveEnv(config.passEnvs);
  if (!pfxB64) {
    context.res = { status: 404, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No certificate configured for this bank' }) };
    return;
  }

  // 4. Parse PFX and extract certificate properties
  try {
    const pfxBuffer = Buffer.from(pfxB64, 'base64');
    const p12Asn1   = forge.asn1.fromDer(pfxBuffer.toString('binary'));
    const p12       = forge.pkcs12.pkcs12FromAsn1(p12Asn1, pfxPass);

    const certBags   = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBagArr = certBags[forge.pki.oids.certBag] || [];
    if (!certBagArr.length) throw new Error('PFX contains no certificate');

    const cert     = certBagArr[0].cert;
    const now      = new Date();
    const notAfter = cert.validity.notAfter;
    const daysLeft = Math.floor((notAfter - now) / (1000 * 60 * 60 * 24));

    // Subject Alternative Names
    const sanExt = cert.getExtension('subjectAltName');
    const sans   = sanExt
      ? (sanExt.altNames || []).map(a => a.value || a.ip || a.oid).filter(Boolean)
      : [];

    // Key algorithm and size
    let keyAlgorithm = 'Unknown';
    let keyBits      = null;
    if (cert.publicKey.n) {
      keyAlgorithm = 'RSA';
      keyBits      = cert.publicKey.n.bitLength();
    } else if (cert.publicKey.curve) {
      keyAlgorithm = 'EC';
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject:         formatDN(cert.subject.attributes),
        issuer:          formatDN(cert.issuer.attributes),
        serialNumber:    cert.serialNumber,
        notBefore:       cert.validity.notBefore.toISOString(),
        notAfter:        notAfter.toISOString(),
        thumbprint:      sha1Fingerprint(cert),
        subjectAltNames: sans,
        keyAlgorithm,
        keyBits,
        isExpired:       daysLeft < 0,
        daysUntilExpiry: daysLeft,
      }),
    };
  } catch (err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Certificate parse failed: ${err.message}` }) };
  }
};
