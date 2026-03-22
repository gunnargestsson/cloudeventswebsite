# Requirement 19: Sparisjóður IOBWS Proxy Azure Function

## Overview

Bank-specific Azure Function that forwards WS-Security-signed SOAP messages to
Sparisjóður's IOBWS services — both on the shared Icelandic inter-bank platform
(`ws.b2b.is`) and on Sparisjóður's proprietary endpoint.

This is one of four bank-specific proxy functions. The shared signing infrastructure,
SOAP envelope assembly, certificate store, and helper module are specified in
**Requirement 15: IOBWS Proxy Common Infrastructure**. Read that specification first.

---

## Status

**Status:** ❌ Not Implemented  
**Priority:** 🔴 High  
**Dependencies:** Requirement 15 (IOBWS Proxy Common Infrastructure)

---

## Available IOBWS Services

Sparisjóður exposes services through two schemas:

### Sambankaskema 2013 (`ws.b2b.is` — WCF, SOAP 1.2)

Shared inter-bank platform. Sparisjóður uses the same endpoint paths as the other
Icelandic banks on this platform.

| Service group | Schema | Endpoint |
|---|---|---|
| Statements / Account | 20131015 | `https://ws.b2b.is/Statements/20131015/AccountService.svc` |
| Statements / Currency | 20131015 | `https://ws.b2b.is/Statements/20131015/CurrencyRatesService.svc` |
| Payments | 20131015 | `https://ws.b2b.is/Payments/20131015/PaymentService.svc` |
| Claims | 20131015 | `https://ws.b2b.is/Claims/20131015/ClaimService.svc` |
| Documents | 20131015 | `https://ws.b2b.is/Documents/20131015/DocumentService.svc` |
| ForeignPayments | 20131015 | `https://ws.b2b.is/ForeignPayments/20131015/ForeignPaymentService.svc` |

Dev / Int / Test environments are available at `ws-dev.b2b.is`, `ws-int.b2b.is`, and
`ws-test.b2b.is` with the same path patterns.

### Sparisjóðaskema (proprietary — ASMX, SOAP 1.1)

Sparisjóður's own schema. Confirm the exact hostname from Sparisjóður's WSDL/ASMX
documentation before implementing and update the SSRF allowlist accordingly.

Placeholder host: `netbanki.sparisjodur.is` (verify with bank documentation).

---

## Endpoint

```
POST /api/sparisjodur?key={api-key}
```

Request and response format: see Requirement 15.

---

## Security

### API key

**Environment variable resolution order** (first match wins):

| Variable | Description |
|---|---|
| `SPARISJODUR_API_KEY` | Bank-specific override (optional) |
| `IOBWS_API_KEY` | Shared API key used by all IOBWS proxies |

### Service URL allowlist

```
ws.b2b.is
ws-dev.b2b.is
ws-int.b2b.is
ws-test.b2b.is
netbanki.sparisjodur.is
```

Confirm the proprietary schema hostname from Sparisjóður documentation and update the
allowlist before deployment.

### Client certificate

Resolution order (first match wins):

| Variable | Description |
|---|---|
| `SPARISJODUR_CLIENT_CERT_PFX` | Bank-specific override (optional) |
| `CLIENT_CERT_PFX` | Shared certificate — see Requirement 15 |

| Variable | Description |
|---|---|
| `SPARISJODUR_CLIENT_CERT_PASSWORD` | Bank-specific override (optional) |
| `CLIENT_CERT_PASSWORD` | Shared certificate password — see Requirement 15 |

### All environment variables

| Variable | Required | Description |
|---|---|---|
| `IOBWS_API_KEY` | ✅ (unless `SPARISJODUR_API_KEY` set) | Shared API key for all IOBWS proxies |
| `CLIENT_CERT_PFX` | ✅ (unless `SPARISJODUR_CLIENT_CERT_PFX` set) | Shared base64-encoded PFX (PKCS#12) |
| `CLIENT_CERT_PASSWORD` | ❌ | Shared PFX password (empty string if none) |
| `SPARISJODUR_API_KEY` | ❌ | Bank-specific API key override |
| `SPARISJODUR_CLIENT_CERT_PFX` | ❌ | Bank-specific cert override |
| `SPARISJODUR_CLIENT_CERT_PASSWORD` | ❌ | Bank-specific cert password override |

---

## File Structure

```
api/
  sparisjodur/
    function.json     ← HTTP trigger, POST /api/sparisjodur
    index.js          ← thin function: validate → call shared signer → return response
  shared/
    iobwsSigner.js    ← defined in Requirement 15
```

---

## Implementation

`index.js` is a thin wrapper that:

1. Resolves the API key (`SPARISJODUR_API_KEY` → `IOBWS_API_KEY`) and validates the
   request key against it; rejects with `401 Unauthorized` if missing or wrong
2. Validates `serviceUrl` host against the Sparisjóður allowlist above
3. Resolves the certificate (`SPARISJODUR_CLIENT_CERT_PFX` → `CLIENT_CERT_PFX`) and
   password (`SPARISJODUR_CLIENT_CERT_PASSWORD` → `CLIENT_CERT_PASSWORD`)
4. Delegates to `iobwsSigner.sign(params, cert)` from `api/shared/iobwsSigner.js`
5. Returns the raw SOAP response

No signing logic lives in this file. All signing details are in Requirement 15.

---

## SOAP Version Detection

| URL path pattern | SOAP version | Content-Type |
|---|---|---|
| Contains `/20131015/` | SOAP 1.2 | `application/soap+xml; charset=utf-8` |
| All other paths | SOAP 1.1 | `text/xml; charset=utf-8` |

---

## Error Responses

```http
401 Unauthorized
{ "error": "Unauthorized" }
```

```http
400 Bad Request
{ "error": "Missing required field: serviceUrl" }
```

```http
400 Bad Request
{ "error": "serviceUrl host is not in the Sparisjóður allowlist" }
```

```http
500 Internal Server Error
{ "error": "Certificate load failed: ..." }
```

---

## References

- IOBWS shared platform: `https://ws.b2b.is`
- Requirement 15 (common infrastructure): `../requirement-15-iobws-proxy-common/SPECIFICATION.md`
- Requirement 16 (Landsbankinn proxy): `../requirement-16-landsbankinn-iobws-proxy/SPECIFICATION.md`
- Requirement 17 (Arionbank proxy): `../requirement-17-arionbank-iobws-proxy/SPECIFICATION.md`
- Requirement 18 (Íslandsbanki proxy): `../requirement-18-islandsbanki-iobws-proxy/SPECIFICATION.md`
