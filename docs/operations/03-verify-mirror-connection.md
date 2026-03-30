# Operation: Verify Mirror Connection

> **Action:** `verifyMirrorConnection`
> **Backend:** [`api/mirror/index.js`](../api/mirror/index.js) — `verifyMirrorConnection()`
> **Frontend:** [`bc-open-mirror.html`](../../bc-open-mirror.html) — `verifyConnection()`

---

## Purpose

Test connectivity to the ADLS Gen2 or OneLake landing zone by authenticating with the
provided service principal and probing the target filesystem/directory. On success, the
connection status is set to `"verified"`, which is a prerequisite for activating table mirrors.

## Request

```http
POST /api/mirror
Content-Type: application/json

{
  "action": "verifyMirrorConnection",
  "companyId": "company-guid",
  "connection": {
    "mirrorUrl": "https://account.dfs.core.windows.net/container/path",
    "tenant": "contoso.onmicrosoft.com",
    "clientId": "sp-client-id",
    "clientSecret": "sp-client-secret"
  }
}
```

## Response

```json
{ "verified": true }
```

## Sequence Diagram

```
┌──────────┐       ┌──────────────────┐       ┌────────────────────────────┐
│  Browser  │──────▶│  Azure Function   │──────▶│  ADLS Gen2 / OneLake       │
│           │       │  /api/mirror      │       │  account.dfs.core.windows  │
└──────────┘       └──────────────────┘       └────────────────────────────┘
     │                     │                            │
     │ verifyMirrorConn    │                            │
     │─────────────────────▶                            │
     │                     │                            │
     │                     │  1. Validate URL + creds   │
     │                     │  2. Create ClientSecret-   │
     │                     │     Credential              │
     │                     │  3. Probe endpoint          │
     │                     │     (ADLS or OneLake)       │
     │                     │────────────────────────────▶│
     │                     │                            │
     │                     │◀────────────────────────────│
     │                     │     filesystem exists       │
     │◀─────────────────────                            │
     │  { verified: true } │                            │
```

## Verification Logic

The function detects the endpoint type and applies different verification strategies:

### ADLS Gen2 Endpoints (`*.dfs.core.windows.net`)

```javascript
const serviceClient = createDataLakeServiceClient(conn.mirrorUrl, credential);
const fs = serviceClient.getFileSystemClient(fileSystemName);

// Check filesystem existence
await fs.exists();

// If a base path was specified, check directory existence
if (basePath) {
  const dir = fs.getDirectoryClient(basePath);
  await dir.exists();
}
```

### OneLake / Fabric Endpoints (`*.dfs.fabric.microsoft.com`)

```javascript
// OneLake can reject some filesystem probe operations even when auth/path are valid.
// For OneLake, verify by acquiring a storage token only.
if (/\.dfs\.fabric\.microsoft\.com$/i.test(parsed.accountHost)) {
  await credential.getToken("https://storage.azure.com/.default");
  return { verified: true };
}
```

### URL Parsing

The mirror URL is parsed into components:

```
https://account.dfs.core.windows.net/container/some/path
         ───────────────────────────  ─────────  ─────────
         accountHost                  fileSystem  basePath
```

### Automatic DFS Correction

If a `.blob.core.windows.net` URL is provided, the system automatically normalizes it
to the DFS endpoint:

```javascript
function normalizeAccountHost(host) {
  if (/\.blob\.core\.windows\.net$/i.test(value)) {
    return value.replace(/\.blob\.core\.windows\.net$/i, ".dfs.core.windows.net");
  }
  return value;
}
```

## Error Handling

| Error | Cause |
|-------|-------|
| `Mirror URL must use the DFS endpoint` | User provided a `.blob.core.windows.net` URL and the probe failed |
| `The mirror endpoint rejected the verification operation` | ADLS endpoint incompatible or permissions missing |
| Azure SDK authentication errors | Invalid tenant, client ID, or client secret |
| `mirrorUrl, tenant, clientId and clientSecret are required` | Missing required fields |

## Frontend Flow

```javascript
async function verifyConnection() {
  const connection = getConnectionForm();
  try {
    await api('verifyMirrorConnection', { connection });
    // On success: mark as verified and save
    state.connection = { ...connection, status: 'verified' };
    await api('saveMirrorConnection', { connection: state.connection });
    setConnectionPanelCollapsed(true);
    setBanner('connection-banner', t('Connection verified'), 'ok');
  } catch (error) {
    // On failure: mark as unverified
    state.connection = { ...connection, status: 'unverified' };
    setConnectionPanelCollapsed(false);
    setBanner('connection-banner', `Verification failed: ${error.message}`, 'error');
  }
}
```

The frontend calls verify first, then saves the connection with `status: "verified"` only
on success. This two-step approach ensures the stored connection always reflects connectivity.

## Dependencies

- `@azure/identity` — `ClientSecretCredential`
- `@azure/storage-file-datalake` — `DataLakeServiceClient`

## Enterprise Upgrade Path

In the [enterprise architecture](../ENTERPRISE-OPEN-MIRROR-ARCHITECTURE.md):

- Verification moves to the Management API: `POST /api/admin/zones/{zoneId}/verify`.
- Credentials retrieved from Key Vault for the specific landing zone.
- Managed Identity verification: attempt `DefaultAzureCredential` probe.
- Verification status stored in the `LandingZone.isVerified` SQL column.
