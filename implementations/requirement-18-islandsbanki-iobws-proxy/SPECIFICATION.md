# Requirement 18: Íslandsbanki IOBWS Proxy Azure Function

## Overview

Bank-specific Azure Function that forwards WS-Security-signed SOAP messages to the
Íslandsbanki IOBWS services — both on the shared Icelandic inter-bank platform
(`ws.b2b.is`) and on Íslandsbanki's proprietary endpoint.

This is one of three bank-specific proxy functions. The shared signing infrastructure,
SOAP envelope assembly, certificate store, and helper module are specified in
**Requirement 15: IOBWS Proxy Common Infrastructure**. Read that specification first.

---

## Status

**Status:** ✅ Implemented  
**Priority:** 🔴 High  
**Dependencies:** Requirement 15 (IOBWS Proxy Common Infrastructure)

---

## Available IOBWS Services

Íslandsbanki exposes services through two schemas:

### Sambankaskema 2013 (`ws.b2b.is` — WCF, SOAP 1.2)

Shared inter-bank platform. Íslandsbanki uses the same endpoint paths as the other
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

### Íslandsbankaskema (proprietary — ASMX, SOAP 1.1)

Íslandsbanki's own schema, documented in the *Handbók fyrir hugbúnaðarhús* manual.
Host: `netbanki.islandsbanki.is`

Services available via this proprietary schema:

| Area | Capabilities |
|---|---|
| **Account balance** | Deposit accounts, credit cards |
| **Payments** | Create payments and payment bundles, domestic transfers, claim payments, foreign payments |
| **Payment information** | Itemised payment statements into accounting |
| **Exchange rates** | Customs rate (`tollgengi`), central bank rate (`seðlagengi`), general rate (`almennt gengi`) |
| **Claims** | Create, cancel, modify claims; query unpaid claims |
| **Electronic documents** | Submit payslips, invoices, and claims electronically |

---

## Endpoint

```
POST /api/islandsbanki?key={api-key}
```

Request and response format: see Requirement 15.

---

## Security

### API key

**Environment variable resolution order** (first match wins):

| Variable | Description |
|---|---|
| `ISLANDSBANKI_API_KEY` | Bank-specific override (optional) |
| `IOBWS_API_KEY` | Shared API key used by all IOBWS proxies |

### Service URL allowlist

```
ws.b2b.is
ws-dev.b2b.is
ws-int.b2b.is
ws-test.b2b.is
netbanki.islandsbanki.is
```

### Client certificate

Resolution order (first match wins):

| Variable | Description |
|---|---|
| `ISLANDSBANKI_CLIENT_CERT_PFX` | Bank-specific override (optional) |
| `CLIENT_CERT_PFX` | Shared certificate — see Requirement 15 |

| Variable | Description |
|---|---|
| `ISLANDSBANKI_CLIENT_CERT_PASSWORD` | Bank-specific override (optional) |
| `CLIENT_CERT_PASSWORD` | Shared certificate password — see Requirement 15 |

### All environment variables

| Variable | Required | Description |
|---|---|---|
| `IOBWS_API_KEY` | ✅ (unless `ISLANDSBANKI_API_KEY` set) | Shared API key for all IOBWS proxies |
| `CLIENT_CERT_PFX` | ✅ (unless `ISLANDSBANKI_CLIENT_CERT_PFX` set) | Shared base64-encoded PFX |
| `CLIENT_CERT_PASSWORD` | ❌ | Shared PFX password |
| `ISLANDSBANKI_API_KEY` | ❌ | Bank-specific API key override |
| `ISLANDSBANKI_CLIENT_CERT_PFX` | ❌ | Bank-specific cert override |
| `ISLANDSBANKI_CLIENT_CERT_PASSWORD` | ❌ | Bank-specific cert password override |

---

## File Structure

```
api/
  islandsbanki/
    function.json     ← HTTP trigger, POST /api/islandsbanki
    index.js          ← thin function: validate → call shared signer → return response
  shared/
    iobwsSigner.js    ← defined in Requirement 15
```

---

## Implementation

`index.js` is a thin wrapper that:

1. Validates `ISLANDSBANKI_API_KEY`
2. Validates `serviceUrl` host against the Íslandsbanki allowlist above
3. Resolves the certificate (bank-specific override or shared)
4. Delegates to `iobwsSigner.sign(params, cert)` from `api/shared/iobwsSigner.js`
5. Returns the raw SOAP response

No signing logic lives in this file. All signing details are in Requirement 15.

---

## Architecture

### What BC AL sends to the function

BC AL constructs the SOAP body for the desired operation and sends it, along with all
necessary parameters, to the function via a simple JSON HTTP request.

### What the function does (and only this)

1. Validates the API key
2. Validates `serviceUrl` against an allowlist of known Íslandsbanki hostnames
3. Loads the client X.509 certificate from the environment
4. Downloads (and caches in module memory per URL) the server certificate from `?wsdl`
5. Detects the SOAP version from the URL:
   - `ws.b2b.is/…/20131015/…` → SOAP 1.2 (WCF)
   - `netbanki.islandsbanki.is/…` → SOAP 1.1 (ASMX)
6. Builds the full SOAP envelope (headers + body)
7. Applies WS-Security: Timestamp, BinarySecurityToken, XML digital signature over
   Body + Timestamp + WS-Addressing headers
8. Adds Username and Password as custom SOAP message headers
   (namespace `http://IcelandicOnlineBanking/Security/`)
9. POSTs the signed envelope to the IOBWS service
10. Returns the raw SOAP response XML to BC (verbatim, including fault bodies)

### What BC AL does with the response

BC AL receives the raw SOAP XML and parses it using `XmlDocument` or `XmlPort` to extract
the result or fault details relevant to the specific operation.

---

## Request (BC → Function)

```http
POST /api/islandsbanki?key=your-api-key
Content-Type: application/json

{
  "serviceUrl":  "https://ws.b2b.is/Payments/20131015/PaymentService.svc",
  "soapAction":  "http://IOBWS.com/IIcelandicOnlineBankingPaymentService/CreatePayment",
  "username":    "myBankUsername",
  "password":    "myBankPassword",
  "body":        "<CreatePayment xmlns=\"http://IOBWS.com/\"><payment>...</payment></CreatePayment>"
}
```

### Request fields

| Field | Type | Required | Description |
|---|---|---|---|
| `serviceUrl` | string | ✅ | Full HTTPS URL of the IOBWS `.svc` or ASMX endpoint |
| `soapAction` | string | ✅ | Value for the `SOAPAction` HTTP header (or `wsa:Action`) |
| `username` | string | ✅ | Bank system username (sent as custom SOAP header) |
| `password` | string | ✅ | Bank system password (sent as custom SOAP header) |
| `body` | string | ✅ | Inner SOAP body XML — the operation element and its children, no `<soap:Body>` wrapper |

---

## Response (Function → BC)

On success the function returns HTTP 200 with the raw SOAP response envelope as plain text:

```http
200 OK
Content-Type: text/xml; charset=utf-8

<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="...">
  ...
</soap:Envelope>
```

On error (invalid API key, disallowed host, signing failure, upstream SOAP fault) the
function returns HTTP 4xx/5xx with a JSON error body — same contract as the other
bank-specific proxies. See Requirement 15.

---

## References

- Requirement 15 (common infrastructure): `../requirement-15-iobws-proxy-common/SPECIFICATION.md`
- Requirement 16 (Landsbankinn proxy): `../requirement-16-landsbankinn-iobws-proxy/SPECIFICATION.md`
- Requirement 17 (Arionbank proxy): `../requirement-17-arionbank-iobws-proxy/SPECIFICATION.md`
- Íslandsbanki Sambankaskema documentation: `https://cdn.islandsbanki.is/image/upload/v1/documents/Vefthjonusta_Islandsbanka_Sambankaskema.pdf`
- Íslandsbankaskema developer manual (*Handbók fyrir hugbúnaðarhús*): `https://cdn.islandsbanki.is/image/upload/v1/documents/Handbok_fyrir_hugbunadarhus.pdf`
- Creditor (kröfuhafi) manual: `https://cdn.islandsbanki.is/image/upload/v1/documents/Handbok-krofuhafa-2025.pdf`
- Íslandsbanki accounting integration page: `https://www.islandsbanki.is/is/vara/fyrirtaeki/bokhaldstengingar`
