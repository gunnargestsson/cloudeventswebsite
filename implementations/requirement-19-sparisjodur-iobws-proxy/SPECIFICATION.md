# Requirement 19: Sparisjóðir IOBWS Proxy Azure Function

## Overview

Single Azure Function that forwards WS-Security-signed SOAP messages to Icelandic savings
bank (sparisjóðir) IOBWS services. All active savings banks run the **Sambankaskema
(IOBS)** standard and each operates its own endpoint on the `heimabanki.is` hosting
platform. The BC AL caller selects the target savings bank by providing its endpoint URL.

This is one of the bank-specific proxy functions. The shared signing infrastructure,
SOAP envelope assembly, certificate store, and helper module are specified in
**Requirement 15: IOBWS Proxy Common Infrastructure**. Read that specification first.

IOBS (Icelandic Online Banking Services) is a collaborative standard of all major
Icelandic financial institutions for standardising and simplifying data transfer between
banking systems and external software such as accounting, ERP, and POS systems.

---

## Status

**Status:** ✅ Implemented  
**Priority:** 🔴 High  
**Dependencies:** Requirement 15 (IOBWS Proxy Common Infrastructure)

---

## Supported Savings Banks

| Institution | Bank number | IOBS endpoint host |
|---|---|---|
| Sparisjóður Austurlands | 1106 | `sparaust-iobs.heimabanki.is` |
| Sparisjóður Þingeyinga | 1110 | `spthin-iobs.heimabanki.is` |
| Smári Sparisjóður (f.h. Höfðhverfinga) | 1187 | `spsh-iobs.heimabanki.is` |
| Smári Sparisjóður (f.h. Strandamanna) | 1161 | `spstr-iobs.heimabanki.is` |

> **Note on Smári Sparisjóður:** Sparisjóður Höfðhverfinga and Sparisjóður Strandamanna
> merged in 2025 under the name Smári Sparisjóður. Initially no changes were made to the
> services — both legacy endpoints remain active and continue to serve their respective
> customer bases. BC AL code should target the endpoint that corresponds to the customer's
> original savings bank.

All savings banks use exclusively the Sambankaskema (IOBS) standard. None operate a
proprietary schema.

---

## Available IOBWS Services

All savings bank endpoints expose the same set of Sambankaskema services (SOAP 1.2, WCF).
The service paths follow the same pattern as the shared `ws.b2b.is` platform, rooted at
the bank-specific host.

| Service | Description |
|---|---|
| `IcelandicOnlineBankingStatementsService` | Account statements, balance enquiries |
| `IcelandicOnlineBankingPaymentsService` | Create payments and payment bundles, domestic transfers |
| `IcelandicOnlineBankingClaimsService` | Create, modify, cancel claims; query unpaid claims |
| `UploadEDocumentService` | Submit electronic documents (payslips, invoices, claims) |
| Secondary collection (`milliinnheimta`) | Inter-collection claim services |
| `FundsTransferService` | Foreign payments |

Full service and field documentation is in the official PDF:
`https://www.spar.is/static/files/Umsoknir/Heimabanki/iobs-sambankaskema-leidbeiningar.pdf`

---

## Endpoint

```
POST /api/sparisjodur?key={api-key}
```

The target savings bank is determined entirely by the `serviceUrl` field in the request
body. No bank-selection parameter is needed.

Request and response format: see Requirement 15.

---

## Security

### API key

**Environment variable:** `SPARISJODUR_API_KEY`

### Service URL allowlist

Only `heimabanki.is` subdomains that belong to known savings banks are permitted.
The allowlist uses suffix matching on the hostname — any subdomain ending in
`-iobs.heimabanki.is` is accepted, as all savings bank IOBS endpoints follow that naming
convention. Explicitly known hostnames:

```
sparaust-iobs.heimabanki.is
spthin-iobs.heimabanki.is
spsh-iobs.heimabanki.is
spstr-iobs.heimabanki.is
```

> If a new savings bank comes online and follows the `-iobs.heimabanki.is` pattern, the
> suffix rule admits it without a code change. If a host does not match the suffix pattern
> it must be added explicitly to the allowlist.

### Client certificate

All savings banks share the same Icelandic X.509 mutual-authentication certificate used
by the other bank proxies.

Resolution order (first match wins):

| Variable | Description |
|---|---|
| `SPARISJODUR_CLIENT_CERT_PFX` | Bank-group-specific override (optional) |
| `CLIENT_CERT_PFX` | Shared certificate — see Requirement 15 |

| Variable | Description |
|---|---|
| `SPARISJODUR_CLIENT_CERT_PASSWORD` | Bank-group-specific override (optional) |
| `CLIENT_CERT_PASSWORD` | Shared certificate password — see Requirement 15 |

### All environment variables

| Variable | Required | Description |
|---|---|---|
| `SPARISJODUR_API_KEY` | ✅ | API key for this endpoint |
| `CLIENT_CERT_PFX` | ✅ (unless `SPARISJODUR_CLIENT_CERT_PFX` set) | Shared base64-encoded PFX |
| `CLIENT_CERT_PASSWORD` | ❌ | Shared PFX password |
| `SPARISJODUR_CLIENT_CERT_PFX` | ❌ | Override cert for all savings banks |
| `SPARISJODUR_CLIENT_CERT_PASSWORD` | ❌ | Override cert password |

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

1. Validates `SPARISJODUR_API_KEY`
2. Validates `serviceUrl` host against the savings bank allowlist above
3. Resolves the certificate (group-specific override or shared)
4. Delegates to `iobwsSigner.sign(params, cert)` from `api/shared/iobwsSigner.js`
5. Returns the raw SOAP response

No signing logic lives in this file. All signing details are in Requirement 15.

---

## Architecture

### What BC AL sends to the function

BC AL constructs the SOAP body for the desired operation and sends it, along with all
necessary parameters, to the function via a simple JSON HTTP request. The `serviceUrl`
field must point to the specific savings bank's IOBS endpoint.

### What the function does (and only this)

1. Validates the API key
2. Validates `serviceUrl` host against the savings bank allowlist
3. Loads the client X.509 certificate from the environment
4. Downloads (and caches in module memory per URL) the server certificate from `?wsdl`
5. All savings bank endpoints use Sambankaskema 2013 → SOAP 1.2 (WCF)
6. Builds the full SOAP envelope (headers + body)
7. Applies WS-Security: Timestamp, BinarySecurityToken, XML digital signature over
   Body + Timestamp + WS-Addressing headers
8. Adds Username and Password as custom SOAP message headers
   (namespace `http://IcelandicOnlineBanking/Security/`)
9. POSTs the signed envelope to the IOBS service
10. Returns the raw SOAP response XML to BC (verbatim, including fault bodies)

### What BC AL does with the response

BC AL receives the raw SOAP XML and parses it using `XmlDocument` or `XmlPort` to extract
the result or fault details for the specific operation.

---

## Request (BC → Function)

```http
POST /api/sparisjodur?key=your-api-key
Content-Type: application/json

{
  "serviceUrl":  "https://sparaust-iobs.heimabanki.is/Claims/20131015/ClaimService.svc",
  "soapAction":  "http://IOBWS.com/IIcelandicOnlineBankingClaimService/QueryClaims",
  "username":    "myBankUsername",
  "password":    "myBankPassword",
  "body":        "<QueryClaims xmlns=\"http://IOBWS.com/\"><query>...</query></QueryClaims>"
}
```

### Request fields

| Field | Type | Required | Description |
|---|---|---|---|
| `serviceUrl` | string | ✅ | Full HTTPS URL of the savings bank IOBS `.svc` endpoint |
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

## Overview table — all Icelandic banks and savings banks

For reference, here is the full picture of Icelandic financial institutions and their
IOBWS integration approach:

| Institution | Bank number | Integration | Proxy function |
|---|---|---|---|
| Íslandsbanki | 0101 | Sambankaskema only | Requirement 18 |
| Landsbankinn | 0130 | Proprietary schema + Sambankaskema | Requirement 16 |
| Arion banki | 0133 | Proprietary schema + Sambankaskema | Requirement 17 |
| Sparisjóður Austurlands | 1106 | Sambankaskema (heimabanki.is) | **This requirement** |
| Sparisjóður Þingeyinga | 1110 | Sambankaskema (heimabanki.is) | **This requirement** |
| Smári Sparisjóður (Höfðhverfinga) | 1187 | Sambankaskema (heimabanki.is) | **This requirement** |
| Smári Sparisjóður (Strandamanna) | 1161 | Sambankaskema (heimabanki.is) | **This requirement** |

---

## References

- Requirement 15 (common infrastructure): `../requirement-15-iobws-proxy-common/SPECIFICATION.md`
- Requirement 16 (Landsbankinn proxy): `../requirement-16-landsbankinn-iobws-proxy/SPECIFICATION.md`
- Requirement 17 (Arionbank proxy): `../requirement-17-arionbank-iobws-proxy/SPECIFICATION.md`
- Requirement 18 (Íslandsbanki proxy): `../requirement-18-islandsbanki-iobws-proxy/SPECIFICATION.md`
- Official IOBS Sambankaskema documentation (PDF): `https://www.spar.is/static/files/Umsoknir/Heimabanki/iobs-sambankaskema-leidbeiningar.pdf`
- Sparisjóðir website: `https://www.spar.is`
