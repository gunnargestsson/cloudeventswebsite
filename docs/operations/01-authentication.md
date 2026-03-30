# Operation: Authentication & Token Acquisition

> **Operation ID:** `getToken` (internal) + `resolveConn`
> **Trigger:** Every API call (implicit — tokens are cached)
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `resolveConn()`, `getToken()`

---

## Purpose

Authenticate with the Business Central Cloud Events API using OAuth2 client credentials
flow. Every mirror operation requires a valid BC access token.

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌───────────────────────────┐
│  Browser  │──────▶│  Azure Function   │──────▶│  Entra ID (login.ms.com)  │
│  (SPA)    │       │  /api/mirror      │       │  /oauth2/v2.0/token       │
└──────────┘       └──────────────────┘       └───────────────────────────┘
     │                     │                            │
     │  POST /api/mirror   │                            │
     │  x-bc-tenant: ...   │                            │
     │  x-bc-client-id: .. │                            │
     │  x-bc-client-secret │                            │
     │─────────────────────▶                            │
     │                     │  POST /oauth2/v2.0/token   │
     │                     │  grant_type=client_creds   │
     │                     │  scope=bc/.default          │
     │                     │────────────────────────────▶│
     │                     │                            │
     │                     │◀────────────────────────────│
     │                     │  { access_token, expires }  │
     │                     │                            │
     │                     │  Cache token in _tokenCache │
     │◀─────────────────────                            │
     │  (proceed to action)│                            │
```

## Credential Resolution

The function resolves BC credentials from two sources (headers take priority):

```javascript
function resolveConn(headers = {}) {
  const tenantId     = headers["x-bc-tenant"]        || process.env.BC_TENANT_ID;
  const clientId     = headers["x-bc-client-id"]     || process.env.BC_CLIENT_ID;
  const clientSecret = headers["x-bc-client-secret"] || process.env.BC_CLIENT_SECRET;
  const environment  = headers["x-bc-environment"]   || process.env.BC_ENVIRONMENT || "production";
  // ...
  return { tenantId, clientId, clientSecret, environment };
}
```

| Source | Priority | Use Case |
|--------|----------|----------|
| `x-bc-*` HTTP headers | 1 (highest) | Browser sends credentials stored in `localStorage` |
| `BC_*` environment variables | 2 (fallback) | Server-side default credentials |

## Token Cache

Tokens are cached **in-memory** per Function process using a `Map` keyed by
`tenantId|clientId`:

```javascript
const _tokenCache = new Map();
// Key:   "contoso.onmicrosoft.com|sp-client-id"
// Value: { token: "eyJ...", expiry: 1711800000000 }
```

- Tokens are reused until 60 seconds before expiry.
- Cache is per-process — Azure Static Web Apps may route requests to different
  instances, so each instance maintains its own cache.
- No persistent token storage.

## Token Request

```http
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={clientId}
&client_secret={clientSecret}
&scope=https://api.businesscentral.dynamics.com/.default
```

## Error Handling

| Error | Cause | Response |
|-------|-------|----------|
| `Token error (invalid_client)` | Wrong client ID or secret | HTTP 500 with error message |
| `Token error (invalid_request)` | Malformed tenant ID | HTTP 500 with error message |
| `No access_token returned` | Unexpected Entra response | HTTP 500 with error message |
| `Missing credentials: provide x-bc-* headers...` | No credentials in headers or env vars | HTTP 500 with error message |

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Credentials move from HTTP headers / env vars → **Azure Key Vault secrets**.
- Token acquisition uses **`@azure/identity` `ClientSecretCredential`** (already used for ADLS).
- Managed Identity eliminates secrets for same-tenant Azure resources.
- Token cache benefits from Durable Functions' longer-lived processes.
