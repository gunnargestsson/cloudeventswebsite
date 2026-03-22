# Requirement 15: IOBWS Proxy — Common Infrastructure

## Overview

Shared infrastructure for all Icelandic Online Banking Web Services (IOBWS) proxy
Azure Functions. Each bank has its own proxy function (Requirements 16, 17, …), but
they all rely on the same signing code, envelope builder, certificate loader, and
wire-format conventions defined here.

**Implement this requirement first.** Bank-specific proxy functions delegate entirely
to the shared module `api/shared/iobwsSigner.js` for all SOAP construction and
WS-Security signing.

---

## Status

**Status:** ✅ Implemented  
**Priority:** 🔴 High  
**Dependencies:** `xml-crypto` npm package, `node-forge` npm package

---

## Background: Why a Proxy Is Needed

IOBWS services require **WS-Security MutualCertificate** authentication. Every SOAP
message must be digitally signed with a company-owned Icelandic X.509 certificate.
Business Central AL cannot produce XML digital signatures, so these proxy functions
bridge that gap: BC AL builds the SOAP body and provides credentials; the proxy holds
the certificate and signs the message.

---

## Shared Request / Response Contract

All bank proxy functions accept the same JSON request shape and return the same
response shape.

### Request (BC → any proxy function)

```http
POST /api/{bank}?key={api-key}
Content-Type: application/json

{
  "serviceUrl":  "https://ws.b2b.is/Claims/20131015/ClaimService.svc",
  "soapAction":  "http://IOBWS.com/IIcelandicOnlineBankingClaimService/QueryClaims",
  "username":    "myBankUsername",
  "password":    "myBankPassword",
  "body":        "<QueryClaims xmlns=\"http://IOBWS.com/\"><query>...</query></QueryClaims>"
}
```

### Request fields

| Field | Type | Required | Description |
|---|---|---|---|
| `serviceUrl` | string | ✅ | Full HTTPS URL of the `.svc` or `.asmx` endpoint |
| `soapAction` | string | ✅ | Value for the `SOAPAction` HTTP header (or `wsa:Action`) |
| `username` | string | ✅ | Bank system username (sent as custom SOAP header) |
| `password` | string | ✅ | Bank system password (sent as custom SOAP header) |
| `body` | string | ✅ | Inner SOAP body XML — the operation element only, no `<soap:Body>` wrapper |

### Response: success

```http
200 OK
Content-Type: text/xml; charset=utf-8

<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="...">
  <s:Header>...</s:Header>
  <s:Body>
    <!-- operation response or s:Fault -->
  </s:Body>
</s:Envelope>
```

The raw SOAP envelope is returned verbatim. SOAP faults from the bank service are
passed through as HTTP 200 — BC AL must detect `<s:Fault>` in the response.

### Response: function-level errors

| HTTP status | Body | Cause |
|---|---|---|
| `401 Unauthorized` | `{ "error": "Unauthorized" }` | Missing or wrong API key |
| `400 Bad Request` | `{ "error": "Missing required field: <name>" }` | Required field absent |
| `400 Bad Request` | `{ "error": "serviceUrl host is not in the allowlist" }` | SSRF guard |
| `500 Internal Server Error` | `{ "error": "Certificate load failed: ..." }` | PFX env var missing or corrupt |

---

## Shared Module: `api/shared/iobwsSigner.js`

All bank proxy functions call a single exported function:

```js
/**
 * Build, sign, and POST a WS-Security SOAP message.
 *
 * @param {object} params
 * @param {string} params.serviceUrl   - Full HTTPS URL of the .svc / .asmx endpoint
 * @param {string} params.soapAction   - SOAPAction URI
 * @param {string} params.username     - Bank username (sent as custom header)
 * @param {string} params.password     - Bank password (sent as custom header)
 * @param {string} params.body         - Inner SOAP body XML (no <soap:Body> wrapper)
 * @param {{ cert: Buffer, key: string }} cert
 *   - cert: DER-encoded client certificate (Buffer)
 *   - key:  PEM-encoded private key (string)
 * @returns {Promise<string>}  Raw SOAP response XML
 */
async function sign(params, cert) { ... }

module.exports = { sign };
```

Callers never touch the envelope XML or WS-Security headers directly.

---

## Certificate Store

### Storage format

The company's Icelandic X.509 certificate is stored as a **base64-encoded PFX bundle**
(PKCS#12, containing both the certificate and its private key) in an Azure Function
application setting.

### Shared environment variables

All proxy functions read from these shared variables:

| Variable | Required | Description |
|---|---|---|
| `CLIENT_CERT_PFX` | ✅ | Base64-encoded PFX (PKCS#12) |
| `CLIENT_CERT_PASSWORD` | ❌ | PFX password (default: empty string) |

Bank-specific overrides can be set alongside the shared ones — each proxy function
checks its own bank-prefixed variable first (e.g. `ARIONBANKI_CLIENT_CERT_PFX`) and
falls back to the shared `CLIENT_CERT_PFX`. This allows a single certificate to serve
all banks today, with per-bank overrides available if banks ever require separate certs.

### Caching

The parsed key pair is cached in module memory (`let _clientCert = null`) for the
lifetime of the function instance. PFX parsing happens once on first call.

### PFX parsing

Use `node-forge` to parse the PFX:

```js
const forge = require('node-forge');

function parsePfx(pfxBuffer, password) {
  const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBags  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const cert = certBags[forge.pki.oids.certBag][0].cert;
  const key  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;
  return {
    cert: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'),  // DER
    key:  forge.pki.privateKeyToPem(key),  // PEM
  };
}
```

---

## SOAP Version Detection

```js
function detectSoapVersion(serviceUrl) {
  return serviceUrl.includes('/20131015/') ? '1.2' : '1.1';
}
```

| URL path pattern | SOAP version | Envelope namespace |
|---|---|---|
| Contains `/20131015/` | 1.2 | `http://www.w3.org/2003/05/soap-envelope` |
| Anything else | 1.1 | `http://schemas.xmlsoap.org/soap/envelope/` |

---

## SOAP Envelope Assembly

BC AL sends only the inner body XML. `iobwsSigner.js` wraps it in the full envelope
before signing.

### Envelope skeleton (SOAP 1.1 shown)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope
    xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:wsa="http://www.w3.org/2005/08/addressing"
    xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
    xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
    xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <s:Header>
    <wsa:Action s:mustUnderstand="1">{soapAction}</wsa:Action>
    <wsa:MessageID>urn:uuid:{random-uuid}</wsa:MessageID>
    <wsa:ReplyTo>
      <wsa:Address>http://www.w3.org/2005/08/addressing/anonymous</wsa:Address>
    </wsa:ReplyTo>
    <wsa:To s:mustUnderstand="1" wsu:Id="Id-To">{serviceUrl}</wsa:To>
    <UserName xmlns="http://IcelandicOnlineBanking/Security/">{username}</UserName>
    <Password xmlns="http://IcelandicOnlineBanking/Security/">{password}</Password>
    <wsse:Security s:mustUnderstand="1">
      <wsu:Timestamp wsu:Id="TS-{id}">
        <wsu:Created>{now ISO8601}</wsu:Created>
        <wsu:Expires>{now + 5 minutes ISO8601}</wsu:Expires>
      </wsu:Timestamp>
      <wsse:BinarySecurityToken
          ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"
          EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
          wsu:Id="BST-{id}">{base64(DER client cert)}</wsse:BinarySecurityToken>
      <!-- ds:Signature injected here by xml-crypto after signing -->
    </wsse:Security>
  </s:Header>
  <s:Body wsu:Id="Body-{id}">
    {body — injected verbatim from request}
  </s:Body>
</s:Envelope>
```

For SOAP 1.2, replace the envelope namespace and use
`application/soap+xml; action="{soapAction}"; charset=utf-8` as the Content-Type
(no separate `SOAPAction` header).

---

## WS-Security Signature

The XML signature follows the WS-Security X.509 Certificate Token Profile 1.0.

### Algorithm suite (WCF `DefaultAlgorithmSuite`)

| Algorithm | URI |
|---|---|
| Canonicalization | `http://www.w3.org/2001/10/xml-exc-c14n#` |
| Signature | `http://www.w3.org/2000/09/xmldsig#rsa-sha1` |
| Digest | `http://www.w3.org/2000/09/xmldsig#sha1` |

### Signed elements

| Element | `wsu:Id` | Transform |
|---|---|---|
| `<s:Body>` | `Body-{id}` | Exclusive C14N |
| `<wsu:Timestamp>` | `TS-{id}` | Exclusive C14N |

### KeyInfo

Reference the `BinarySecurityToken` via a `wsse:SecurityTokenReference` →
`wsse:Reference` pointing to `#BST-{id}`.

### Implementation

Use the `xml-crypto` npm package:

```js
const { SignedXml } = require('xml-crypto');

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
      const b64cert = certDer.toString('base64');
      return `<wsse:SecurityTokenReference>` +
             `<wsse:Reference URI="#BST-1" ` +
             `ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>` +
             `</wsse:SecurityTokenReference>`;
    }
  };

  sig.computeSignature(xmlString, {
    location: { reference: '//*[local-name()="Security"]', action: 'append' }
  });

  return sig.getSignedXml();
}
```

---

## HTTP Dispatch

After signing, POST the envelope to the bank service:

```js
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

  return response.text();   // Return raw XML regardless of HTTP status
}
```

Use Node.js 18+ built-in `fetch`. Do not throw on non-2xx HTTP status — return the
response body verbatim so BC AL can inspect any SOAP fault or bank-level error.

---

## Security

### SSRF protection (enforced by each proxy function, not the shared module)

Each proxy function validates `serviceUrl` against its own allowlist before calling
`iobwsSigner.sign()`. The shared module trusts the caller — it does **not** re-validate
the URL. This keeps the shared module simple and puts SSRF responsibility where the
bank-specific hostnames are known.

### No response signature verification

Bank service responses are not signature-verified. Standard TLS handles service
authenticity. Adding response verification is out of scope for v1.

### No logging of credentials

`username`, `password`, and the PFX contents must never be written to logs.

---

## npm Dependencies

Add to `api/package.json`:

```json
"dependencies": {
  "xml-crypto": "^6.0.0",
  "node-forge":  "^1.3.1"
}
```

---

## File Structure

```
api/
  shared/
    iobwsSigner.js      ← sign(params, cert): Promise<string>
                           parsePfx(pfxBuffer, password): { cert, key }
                           detectSoapVersion(serviceUrl): "1.1" | "1.2"
                           buildEnvelope(params, soapVersion): string  (unsigned)
                           signEnvelope(xmlString, certDer, keyPem): string
                           postToBank(serviceUrl, soapAction, xml, soapVersion): Promise<string>
```

---

## Pagination

The proxy is **stateless and page-unaware**: it signs and forwards one request, returns
one response, and has no memory between calls. Pagination is entirely the responsibility
of BC AL.

### ClaimService — ContinuationToken (20131015)

`QueryClaims` returns at most **5,000 claims** per call. When more exist the response
body contains a `<ContinuationToken>` element with an opaque string value:

```xml
<QueryClaimsResponse xmlns="http://IcelandicOnlineBanking/2013/10/15/Claims">
  <Claims>
    <Claim>...</Claim>
    <!-- up to 5,000 Claim elements -->
  </Claims>
  <ContinuationToken>eyJQYWdlIjoy...</ContinuationToken>
</QueryClaimsResponse>
```

To fetch the next page, include the token as `<ContinuationToken>` inside the `<Query>`
element of the next request:

```xml
<QueryClaims xmlns="http://IcelandicOnlineBanking/2013/10/15/Claims">
  <Query>
    <Claimant xmlns="http://IcelandicOnlineBanking/2013/10/15/ClaimTypes">...</Claimant>
    <Period xmlns="http://IcelandicOnlineBanking/2013/10/15/ClaimTypes">...</Period>
    <Status xmlns="http://IcelandicOnlineBanking/2013/10/15/ClaimTypes">...</Status>
    <ContinuationToken xmlns="http://IcelandicOnlineBanking/2013/10/15/ClaimTypes">eyJQYWdlIjoy...</ContinuationToken>
  </Query>
</QueryClaims>
```

Repeat until the response contains no `<ContinuationToken>` element (or it is empty).
Each paginated request is a full, independently-signed round-trip through the proxy.

BC AL implementation pattern (in the bank client codeunit):

```al
ContinuationToken := '';
IsFirstPage := true;
repeat
    BodyXml := ReqBuilder.BuildQueryClaimsBody(Claimant, DateFrom, DateTo, Status, ContinuationToken);
    RespXml  := IobwsClient.SendRequest(Enum::"IS Bank"::Arionbanki, ClaimsServiceUrl, SoapAction, BodyXml);
    RespReader.ReadClaimsPage(RespXml, TempClaim, ContinuationToken, not IsFirstPage);
    IsFirstPage := false;
until ContinuationToken = '';
```

### StatementsService — Date-range chunking (2005 ASMX)

`GetAccountStatement` returns **all transactions in the requested date range** in a
single response.  Banks enforce a practical limit of approximately **5,000 lines** per
call; there is no server-side `ContinuationToken` for statements.

Callers that need long histories must split the request across multiple narrower date
ranges (e.g. one month at a time) and accumulate results.  The proxy forwards each
sub-range request as a separate signed call.

---

## BC AL Responsibilities (common to all banks)

BC AL code calling any proxy function must:

1. **Build the SOAP body** — inner XML for the operation only, no `<soap:Envelope>` or
   `<soap:Body>` wrapper.
2. **Know the service URL and SOAP action** — constants per schema version and operation.
3. **Supply credentials** — username and password registered with the bank.
4. **Parse the response** — use `XmlDocument.ReadFrom()` and navigate to
   `Envelope/Body/*[1]` for the result, or `Envelope/Body/Fault` for errors.
5. **Detect SOAP faults** — surface `faultstring` / fault `Text` as a BC user error.
6. **Handle pagination** — loop `QueryClaims` using `ContinuationToken`; chunk
   `GetAccountStatement` by date range when the result set may exceed 5,000 lines.

---

## References

- Requirement 16 (Landsbankinn proxy): `../requirement-16-landsbankinn-iobws-proxy/SPECIFICATION.md`
- Requirement 17 (Arionbank proxy): `../requirement-17-arionbank-iobws-proxy/SPECIFICATION.md`
- WS-Security spec: `http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd`
- xml-crypto: `https://github.com/node-saml/xml-crypto`
- IOBWS service index: `https://ws.b2b.is/`
