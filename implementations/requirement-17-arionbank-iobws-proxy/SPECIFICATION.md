# Requirement 17: Arionbank IOBWS Proxy Azure Function

## Overview

Bank-specific Azure Function that forwards WS-Security-signed SOAP messages to the
Arionbank IOBWS services at `ws.b2b.is`.

This is one of two bank-specific proxy functions. The shared signing infrastructure,
SOAP envelope assembly, certificate store, and helper module are specified in
**Requirement 15: IOBWS Proxy Common Infrastructure**. Read that specification first.

---

## Status

**Status:** ✅ Implemented  
**Priority:** � High  
**Dependencies:** Requirement 15 (IOBWS Proxy Common Infrastructure)

---

## Available IOBWS Services

Arionbank services are exposed on the shared Icelandic inter-bank platform `ws.b2b.is`.

| Service group | Schema | Endpoint |
|---|---|---|
| Statements | 20130101 (Arion-specific) | `https://ws.b2b.is/Statements/20130101/AccountService.svc` |
| Statements | 20130201 | `https://ws.b2b.is/Statements/20130201/BillService.svc` |
| Statements | 20131015 | `https://ws.b2b.is/Statements/20131015/AccountService.svc` |
| Statements | 20131015 | `https://ws.b2b.is/Statements/20131015/CurrencyRatesService.svc` |
| Payments | 20131015 | `https://ws.b2b.is/Payments/20131015/PaymentService.svc` |
| Claims | 20131015 | `https://ws.b2b.is/Claims/20131015/ClaimService.svc` |
| Claims | 20131015 | `https://ws.b2b.is/Claims/20131015/SecondaryCollectionClaimService.svc` |
| Documents | 20131015 | `https://ws.b2b.is/Documents/20131015/DocumentService.svc` |
| ForeignPayments | 20131015 | `https://ws.b2b.is/ForeignPayments/20131015/...` |
| CreditCards | 20131015 | `https://ws.b2b.is/CreditCards/20131015/...` |

Dev / Int / Test environments are available at `ws-dev.b2b.is`, `ws-int.b2b.is`, and
`ws-test.b2b.is` with the same path patterns.

---

## Endpoint

```
POST /api/arionbanki?key={api-key}
```

Request and response format: see Requirement 15.

---

## Security

### API key

**Environment variable resolution order** (first match wins):

| Variable | Description |
|---|---|
| `ARIONBANKI_API_KEY` | Bank-specific override (optional) |
| `IOBWS_API_KEY` | Shared API key used by all IOBWS proxies |

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
| `ARIONBANKI_CLIENT_CERT_PFX` | Bank-specific override (optional) |
| `CLIENT_CERT_PFX` | Shared certificate — see Requirement 15 |

| Variable | Description |
|---|---|
| `ARIONBANKI_CLIENT_CERT_PASSWORD` | Bank-specific override (optional) |
| `CLIENT_CERT_PASSWORD` | Shared certificate password — see Requirement 15 |

**All environment variables:**

| Variable | Required | Description |
|---|---|---|
| `IOBWS_API_KEY` | ✅ (unless `ARIONBANKI_API_KEY` set) | Shared API key for all IOBWS proxies |
| `CLIENT_CERT_PFX` | ✅ (unless `ARIONBANKI_CLIENT_CERT_PFX` set) | Shared base64-encoded PFX |
| `CLIENT_CERT_PASSWORD` | ❌ | Shared PFX password |
| `ARIONBANKI_API_KEY` | ❌ | Bank-specific API key override |
| `ARIONBANKI_CLIENT_CERT_PFX` | ❌ | Bank-specific cert override |
| `ARIONBANKI_CLIENT_CERT_PASSWORD` | ❌ | Bank-specific cert password override |

---

## File Structure

```
api/
  arionbanki/
    function.json     ← HTTP trigger, POST /api/arionbanki
    index.js          ← thin function: validate → call shared signer → return response
  shared/
    iobwsSigner.js    ← defined in Requirement 15
```

## Implementation

`index.js` is a thin wrapper that:

1. Validates `ARIONBANKI_API_KEY`
2. Validates `serviceUrl` host against the Arionbank allowlist above
3. Resolves the certificate (bank-specific override or shared)
4. Delegates to `iobwsSigner.sign(params, cert)` from `api/shared/iobwsSigner.js`
5. Returns the raw SOAP response

No signing logic lives in this file. All signing details are in Requirement 15.

---

## References

- Requirement 15 (common infrastructure): `../requirement-15-iobws-proxy-common/SPECIFICATION.md`
- Requirement 16 (Landsbankinn proxy): `../requirement-16-landsbankinn-iobws-proxy/SPECIFICATION.md`
