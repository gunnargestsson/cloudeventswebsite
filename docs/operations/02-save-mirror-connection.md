# Operation: Save Mirror Connection

> **Action:** `saveMirrorConnection`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `saveMirrorConnection()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `saveConnection()`

---

## Purpose

Persist the ADLS Gen2 / OneLake landing zone connection details (URL, service principal
credentials) to Business Central's `Cloud Events Storage` table, encrypted with AES-256-GCM.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "saveMirrorConnection",
  "companyId": "company-guid",
  "connection": {
    "mirrorUrl": "https://account.dfs.core.windows.net/container/path",
    "tenant": "contoso.onmicrosoft.com",
    "clientId": "sp-client-id",
    "clientSecret": "sp-client-secret",
    "status": "verified",
    "maxConcurrentMirrors": 3
  }
}
```

## Response

```json
{ "saved": true, "status": "verified" }
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌─────────────────────┐
│  Browser  │──────▶│  Azure Function   │──────▶│  BC Cloud Events    │
│           │       │  /api/mirror      │       │  Data.Records.Set   │
└──────────┘       └──────────────────┘       └─────────────────────┘
     │                     │                            │
     │ saveMirrorConnection│                            │
     │─────────────────────▶                            │
     │                     │                            │
     │                     │  1. Validate input fields   │
     │                     │  2. Encrypt JSON with       │
     │                     │     AES-256-GCM             │
     │                     │  3. Base64-encode            │
     │                     │  4. Upsert to Cloud Events  │
     │                     │     Storage table            │
     │                     │────────────────────────────▶│
     │                     │     (Source="BC Open Mirror" │
     │                     │      Id=CONFIG_CONN_ID)     │
     │                     │◀────────────────────────────│
     │◀─────────────────────                            │
     │  { saved: true }    │                            │
```

## Data Flow

### Input Validation

```javascript
function sanitizeConnection(connection) {
  const mirrorUrl    = String(connection.mirrorUrl || "").trim();
  const tenant       = String(connection.tenant || "").trim();
  const clientId     = String(connection.clientId || "").trim();
  const clientSecret = String(connection.clientSecret || "").trim();
  const status       = connection.status === "verified" ? "verified" : "unverified";

  if (!mirrorUrl || !tenant || !clientId || !clientSecret) {
    throw new Error("mirrorUrl, tenant, clientId and clientSecret are required");
  }
  return { mirrorUrl, tenant, clientId, clientSecret, status };
}
```

### Encryption

The connection JSON is encrypted with **AES-256-GCM** before storage:

```javascript
function encryptText(plaintext) {
  const key = getEncryptionKey();          // MCP_ENCRYPTION_KEY env var (32 bytes hex)
  const iv  = crypto.randomBytes(12);      // 96-bit nonce
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();         // 128-bit authentication tag
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
```

Storage format: `base64( 12-byte IV | 16-byte auth tag | ciphertext )`

### BC Storage Location

| Field | Value |
|-------|-------|
| Table | `Cloud Events Storage` |
| Source | `BC Open Mirror` |
| Id | `11111111-1111-1111-1111-000000000001` |
| Data | Base64-encoded encrypted JSON |

## Error Handling

| Error | Cause |
|-------|-------|
| `mirrorUrl, tenant, clientId and clientSecret are required` | Missing required fields |
| `MCP_ENCRYPTION_KEY must be set to 64 hex chars` | Missing or invalid encryption key in env vars |
| BC API errors | Cloud Events Storage write failed |

## Frontend Code

```javascript
async function saveConnection() {
  const connection = getConnectionForm();
  const result = await api('saveMirrorConnection', { connection });
  state.connection = { ...connection, status: result.status || connection.status };
  populateConnectionForm();
  setBanner('connection-banner', t('Connection saved'), 'ok');
}
```

The frontend also stores `maxConcurrentMirrors` as part of the connection form state,
though this value is not persisted server-side — it is a browser-local scheduler setting.

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Connection credentials move to **Azure Key Vault** per landing zone.
- The `LandingZone` SQL table replaces the single encrypted blob.
- `authMethod` supports both `ServicePrincipal` and `ManagedIdentity`.
- No encryption key management needed — Key Vault handles encryption at rest.
