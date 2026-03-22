# Requirement 16: Landsbankinn IOBWS Proxy Azure Function

## Overview

Bank-specific Azure Function that forwards WS-Security-signed SOAP messages to
Landsbankinn's IOBWS services.

This is one of two bank-specific proxy functions. The shared signing infrastructure,
SOAP envelope assembly, certificate store, and helper module are specified in
**Requirement 15: IOBWS Proxy Common Infrastructure**. Read that specification first.

Landsbankinn supports three schemas:

| Schema | Year | Notes |
|---|---|---|
| Sambankaskema 2013 | 2013 | Shared inter-bank — `ws.b2b.is`, SOAP 1.2, WCF |
| Sambankaskema 2005 | 2005 | Shared inter-bank — `ws.b2b.is`, SOAP 1.1, ASMX |
| Landsbankaskema | — | Landsbankinn-proprietary — `netbanki.landsbankinn.is`, ASMX |

---

## Status

**Status:** ✅ Implemented  
**Priority:** 🔴 High  
**Dependencies:** Requirement 15 (IOBWS Proxy Common Infrastructure)

---

## Available Services

### Sambankaskema 2013 (`ws.b2b.is` — WCF, SOAP 1.2)

Same host as Arionbank. Landsbankinn-relevant services on the shared platform:

| Service | Endpoint |
|---|---|
| AccountService 2013 | `https://ws.b2b.is/Statements/20131015/AccountService.svc` |
| CurrencyRatesService | `https://ws.b2b.is/Statements/20131015/CurrencyRatesService.svc` |
| PaymentService | `https://ws.b2b.is/Payments/20131015/PaymentService.svc` |
| ClaimService | `https://ws.b2b.is/Claims/20131015/ClaimService.svc` |
| DocumentService | `https://ws.b2b.is/Documents/20131015/DocumentService.svc` |
| ForeignPaymentsService | `https://ws.b2b.is/ForeignPayments/20131015/...` |

Dev/Int/Test environments available at `ws-dev.b2b.is`, `ws-int.b2b.is`, `ws-test.b2b.is`.

### Sambankaskema 2005 (`ws.b2b.is` — ASMX, SOAP 1.1)

Older shared schema, still in use for some integrations. Exposed as `B2Bws` ASMX service
on the same `ws.b2b.is` platform.

### Landsbankaskema (`netbanki.landsbankinn.is` — ASMX, SOAP 1.1)

Landsbankinn-proprietary schema with `LI_*` operations. Endpoint host:
`netbanki.landsbankinn.is`.

Representative `LI_*` operations (non-exhaustive):

| Request | Response |
|---|---|
| `LI_Innskra` | `LI_Innskra_svar` |
| `LI_Utskra` | `LI_Utskra_svar` |
| `LI_Claim_get` | `LI_Claim_get_response` |
| `LI_Claim_search` | `LI_Claim_search_response` |
| `LI_Claim_search_by_day` | `LI_Claim_search_by_day_response` |
| `LI_Claim_todays_payment_info` | `LI_Claim_todays_payment_info_response` |
| `LI_Fyrirspurn_reikningsyfirlit` | `LI_Fyrirspurn_reikningsyfirlit_svar` |
| `LI_Fyrirspurn_gengi_gjaldmidla` | `LI_Fyrirspurn_gengi_gjaldmidla_svar` |
| `LI_Fyrirspurn_greidslubunki` | `LI_Fyrirspurn_greidslubunki_svar` |
| `LI_Fyrirspurn_erlendar_greidslur` | `LI_Fyrirspurn_erlendar_greidslur_svar` |
| `LI_Stofna_greidslur` | `LI_Stofna_greidslur_svar` |
| `LI_Stofna_erlendar_greidslur` | `LI_Stofna_erlendar_greidslur_svar` |
| `LI_Innheimta_krofur_stofna` | `LI_Innheimta_krofur_svar` |
| `LI_Innheimta_krofur_breyta` | `LI_Innheimta_krofur_svar` |
| `LI_Innheimta_krofur_eyda` | `LI_Innheimta_krofur_svar` |
| `LI_Innheimta_fyrirspurn_krofur` | `LI_Innheimta_fyrirspurn_krofur_svar` |
| `LI_Innheimta_fyrirspurn_greidslur` | `LI_Innheimta_fyrirspurn_greidslur_svar` |
| `LI_Get_Index` | `LI_Get_Index_Response` |
| `LI_Innborgun_kreditkorts` | `LI_Innborgun_kreditkorts_svar` |
| `LI_Innsending_gagna` | `LI_Innsending_gagna_svar` |
| `LI_Breyta_lykilordi` | `LI_Breyta_lykilordi_svar` |

Full schema documentation and XSD/WSDL files are published at:
`https://www.landsbankinn.is/fyrirtaeki/beintenging-vid-bokhald-b2b/skemu`

---

## Architecture

Identical to Requirement 17 (Arionbank proxy). `index.js` is a thin wrapper;
all signing logic lives in `api/shared/iobwsSigner.js` (see Requirement 15).

---

## Endpoint

```
POST /api/landsbankinn?key={api-key}
```

---

## Request (BC → Function)

```http
POST /api/landsbankinn?key=your-api-key
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
| `body` | string | ✅ | Inner SOAP body XML — the operation element and its children, no `<soap:Body>` wrapper |

---

## Response (Function → BC)

On success the function returns HTTP 200 with the raw SOAP response envelope as plain text:

```http
200 OK
Content-Type: text/xml; charset=utf-8

<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="...">
  <s:Header>...</s:Header>
  <s:Body>
    <QueryClaimsResponse xmlns="...">
      ...
    </QueryClaimsResponse>
  </s:Body>
</s:Envelope>
```

When the service returns a SOAP fault the function still returns HTTP 200 and passes
the fault envelope verbatim. BC AL is responsible for detecting `<s:Fault>`.

### Error responses (function-level errors)

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
{ "error": "serviceUrl host is not in the Landsbankinn allowlist" }
```

```http
500 Internal Server Error
{ "error": "Certificate load failed: ..." }
```

---

## Security

### API key authentication

Every request must pass `?key={api-key}`. Requests without a matching key are rejected
with `401 Unauthorized`.

**Environment variable resolution order** (first match wins):

| Variable | Description |
|---|---|
| `LANDSBANKINN_API_KEY` | Bank-specific override (optional) |
| `IOBWS_API_KEY` | Shared API key used by all IOBWS proxies |

### Service URL allowlist

The `serviceUrl` host must be one of:

```
ws.b2b.is
ws-dev.b2b.is
ws-int.b2b.is
ws-test.b2b.is
netbanki.landsbankinn.is
```

Any other host is rejected with `400 Bad Request`. This prevents SSRF abuse.

### Client certificate

The same Icelandic X.509 company certificate used by the Arionbank proxy is reused here.
It is stored as a **base64-encoded PFX bundle** in the environment.

**Environment variable resolution order** (first match wins):

| Variable | Description |
|---|---|
| `LANDSBANKINN_CLIENT_CERT_PFX` | Bank-specific override (optional) |
| `CLIENT_CERT_PFX` | Shared certificate used by all IOBWS proxies |

| Variable | Description |
|---|---|
| `LANDSBANKINN_CLIENT_CERT_PASSWORD` | Bank-specific override (optional) |
| `CLIENT_CERT_PASSWORD` | Shared certificate password used by all IOBWS proxies |

**All environment variables:**

| Variable | Required | Description |
|---|---|---|
| `IOBWS_API_KEY` | ✅ (unless `LANDSBANKINN_API_KEY` set) | Shared API key for all IOBWS proxies |
| `CLIENT_CERT_PFX` | ✅ (unless `LANDSBANKINN_CLIENT_CERT_PFX` set) | Shared base64-encoded PFX (PKCS#12) |
| `CLIENT_CERT_PASSWORD` | ❌ | Shared PFX password (empty string if none) |
| `LANDSBANKINN_API_KEY` | ❌ | Bank-specific API key override |
| `LANDSBANKINN_CLIENT_CERT_PFX` | ❌ | Bank-specific cert override |
| `LANDSBANKINN_CLIENT_CERT_PASSWORD` | ❌ | Bank-specific cert password override |

---

## Implementation Notes

### Shared code with Arionbank proxy

All signing and envelope logic lives in `api/shared/iobwsSigner.js` (Requirement 15).
The only Landsbankinn-specific items are:

- The API key env var name (`LANDSBANKINN_API_KEY`)
- The SSRF allowlist (adds `netbanki.landsbankinn.is` to the shared `ws.b2b.is` hosts)
- The certificate env var resolution (shared → bank-specific override)
- The function route (`/api/landsbankinn`)

### SOAP version detection

| URL path pattern | SOAP version | Content-Type |
|---|---|---|
| Contains `/20131015/` | SOAP 1.2 | `application/soap+xml; charset=utf-8` |
| All other paths | SOAP 1.1 | `text/xml; charset=utf-8` |

### Landsbankaskema endpoint confirmation

The `netbanki.landsbankinn.is` hostname is the expected host for the Landsbankaskema
ASMX services. Confirm exact endpoint URLs from the WSDL/ASMX documentation at
`https://www.landsbankinn.is/fyrirtaeki/beintenging-vid-bokhald-b2b/skemu` before
implementing, and update the SSRF allowlist accordingly.

---

## References

- Landsbankinn B2B schemas: `https://www.landsbankinn.is/fyrirtaeki/beintenging-vid-bokhald-b2b/skemu`
- IOBWS shared platform: `https://ws.b2b.is`
- Requirement 15 (common infrastructure): `../requirement-15-iobws-proxy-common/SPECIFICATION.md`
- Requirement 17 (Arionbank proxy): `../requirement-17-arionbank-iobws-proxy/SPECIFICATION.md`
