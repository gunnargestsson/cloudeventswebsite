# Requirement 20: Kvika Banki IOBWS Proxy Azure Function

## Overview

Bank-specific Azure Function that forwards WS-Security-signed SOAP messages to Kvika
banki's IOBWS services on the shared Icelandic inter-bank platform (`ws.b2b.is`).

This is one of the bank-specific proxy functions. The shared signing infrastructure,
SOAP envelope assembly, certificate store, and helper module are specified in
**Requirement 15: IOBWS Proxy Common Infrastructure**. Read that specification first.

Kvika banki (formerly MP Bank) operates exclusively on the shared Sambankaskema 2013
(`ws.b2b.is`) platform. No proprietary schema is known to be in use.

More about Kvika banki: https://kvika.is/um-kviku/

---

## Status

**Status:** ✅ Implemented
**Priority:** 🔴 High
**Dependencies:** Requirement 15 (IOBWS Proxy Common Infrastructure)

---

## Available IOBWS Services

Kvika banki exposes services through the shared Sambankaskema 2013 (`ws.b2b.is`)
platform only.

### Sambankaskema 2013 (`ws.b2b.is` — WCF, SOAP 1.2)

| Service group | Schema | Endpoint |
|---|---|---|
| Statements / Account | 20131015 | `https://ws.b2b.is/Statements/20131015/AccountService.svc` |
| Statements / Currency | 20131015 | `https://ws.b2b.is/Statements/20131015/CurrencyRatesService.svc` |
| Payments | 20131015 | `https://ws.b2b.is/Payments/20131015/PaymentService.svc` |
| Claims | 20131015 | `https://ws.b2b.is/Claims/20131015/ClaimService.svc` |
| Secondary collection | 20131015 | `https://ws.b2b.is/Claims/20131015/SecondaryCollectionClaimService.svc` |
| Documents | 20131015 | `https://ws.b2b.is/Documents/20131015/DocumentService.svc` |
| ForeignPayments | 20131015 | `https://ws.b2b.is/ForeignPayments/20131015/ForeignPaymentService.svc` |

Dev / Int / Test environments are available at `ws-dev.b2b.is`, `ws-int.b2b.is`, and
`ws-test.b2b.is` with the same path patterns.

---

## Endpoint

```
POST /api/kvika?key={api-key}
```

Request and response format: see Requirement 15.

---

## Security

### API key

**Environment variable:** `KVIKA_API_KEY`

### Service URL allowlist

```
ws.b2b.is
ws-dev.b2b.is
ws-int.b2b.is
ws-test.b2b.is
```

### Client certificate

Resolution order (first match wins):

| Variable | Description |
|---|---|
| `KVIKA_CLIENT_CERT_PFX` | Bank-specific override (optional) |
| `CLIENT_CERT_PFX` | Shared certificate — see Requirement 15 |

| Variable | Description |
|---|---|
| `KVIKA_CLIENT_CERT_PASSWORD` | Bank-specific override (optional) |
| `CLIENT_CERT_PASSWORD` | Shared certificate password — see Requirement 15 |

### All environment variables

| Variable | Required | Description |
|---|---|---|
| `KVIKA_API_KEY` | ✅ | API key for this endpoint |
| `CLIENT_CERT_PFX` | ✅ (unless `KVIKA_CLIENT_CERT_PFX` set) | Shared base64-encoded PFX |
| `CLIENT_CERT_PASSWORD` | ❌ | Shared PFX password |
| `KVIKA_CLIENT_CERT_PFX` | ❌ | Bank-specific cert override |
| `KVIKA_CLIENT_CERT_PASSWORD` | ❌ | Bank-specific cert password override |

---

## File Structure

```
api/
  kvika/
    function.json     ← HTTP trigger, POST /api/kvika
    index.js          ← thin function: validate → call shared signer → return response
  shared/
    iobwsSigner.js    ← defined in Requirement 15
```

## Implementation

`index.js` is a thin wrapper that:

1. Validates `KVIKA_API_KEY`
2. Validates `serviceUrl` host against the Kvika allowlist above
3. Resolves the certificate (bank-specific override or shared)
4. Delegates to `iobwsSigner.sign(params, cert)` from `api/shared/iobwsSigner.js`
5. Returns the raw SOAP response

No signing logic lives in this file. All signing details are in Requirement 15.

---

## References

- Kvika banki: https://kvika.is/um-kviku/
- b2b.is platform: https://ws.b2b.is
- IOBWS Sambankaskema documentation: available from the b2b.is onboarding portal
