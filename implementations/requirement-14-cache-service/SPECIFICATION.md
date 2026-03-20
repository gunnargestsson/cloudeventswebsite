# Requirement 14: Azure Blob Cache Service

## Overview

Implement an XML cache service as an Azure Function that stores XML data in Azure Blob Storage and returns a publicly accessible URI. This service supports caching of Business Central API XML responses and temporary XML storage.

The service is based on an existing C# implementation but adapted to JavaScript/Node.js to match the current application stack.

---

## Status

**Status:** ❌ Not Implemented  
**Priority:** 🟡 Medium  
**Dependencies:** Azure Storage Account with Blob Storage enabled, SAS token with write permissions

---

## Architecture

### Endpoint
```
POST /api/cache?key={api-key}
```

### Request
```http
POST /api/cache?key=your-secret-key-here
Content-Type: application/json

{
  "xml": "<your XML content as string>",
  "ttl": 3600
}
```

### Response
```http
200 OK
Content-Type: application/json

{
  "uri": "https://{storage-account}.blob.core.windows.net/cache/{blob-name}",
  "blobName": "abc123def456.xml",
  "expiresAt": "2026-03-21T14:30:00Z",
  "sizeBytes": 1024
}
```

### Error Response
```http
400 Bad Request / 500 Internal Server Error
Content-Type: application/json

{
  "error": "Invalid request: data field is required"
}
```

---

## Security

### API Key Authentication
The service requires an API key passed as a URL parameter:
```
POST /api/cache?key={your-api-key}
```

**Environment Variable:** `CACHE_API_KEY`

The request will be rejected with `401 Unauthorized` if:
- The `key` parameter is missing
- The `key` parameter does not match `CACHE_API_KEY`

---

## Input Specification

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `xml` | string | ✅ | - | XML data to cache (as string) |
| `ttl` | integer | ❌ | `3600` | Time-to-live in seconds (default 1 hour, max 7 days = 604800) |

### URL Parameters

| Parameter | Required | Description |
|---|---|---|
| `key` | ✅ | API key for authentication (must match `CACHE_API_KEY` environment variable) |

### Validation Rules

1. **key** (URL parameter) — must be present and match `CACHE_API_KEY` environment variable
2. **xml** — must not be empty
3. **ttl** — must be between 60 (1 minute) and 604800 (7 days)

---Specified in SAS URL  
**Access level:** Public read (blob-level)  
**Connection:** Use Azure Storage SDK v12 with SAS URL from environment variable

**Environment Variables:**
```bash
CACHE_API_KEY=your-secret-key-here
CACHE_SAS_URL=https://yourstorageaccount.blob.core.windows.net/cache?sv=2022-11-02&ss=b&srt=sco&sp=rwdlac&se=2027-12-31T23:59:59Z&st=2024-01-01T00:00:00Z&spr=https&sig=yoursignature
```

**SAS URL Requirements:**
- Must include container name in the path (e.g., `/cache`)
- Must xml
```

Example: `a1b2c3d4e5f6.xml`

**GUID generation:** Use `uuid` package (`v4()` method), remove hyphens
6. Copy the **Blob SAS URL** (entire URL including signature)blobName` | string | Name of the blob in storage (GUID + optional extension) |
| `expiresAt` | string | ISO 8601 timestamp when the blob will be deleted |
| `sizeBytes` | integer | Size of the stored blob in bytes |

---

## Implementation Details

### Azure Storage Configuration

**Container name:** `cache`  
**Access level:** Public read (blob-level)  
**Connection:** Use Azure Storage SDK v12 with connection string from environment variable

**Environment Variables:**
```bash
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
```

### Blob Naming Convention

```
{GUID}.{extension}
```

Examples:
- `a1b2c3d4e5f6.xml`
- `9f8e7d6c5b4a.json`
- `1234567890ab.bin`

**GUID generation:** Use `uuid` package (`v4()` method)  
**Extension extraction:** Parse `fileName` parameter or derive from `contentType`

### TTL Implementation

Azure Blob Storage does not natively support TTL. Implement using **Blob Metadata** + **Lifecycle Management Policy** or **manual cleanup**:

#### Option 1: Blob Metadata + Lifecycle Policy (Recommended)
1. Set blob metadata: `expiresAt` = ISO 8601 timestamp
2. Configure Storage Account Lifecycle Management to delete blobs with `lastModifiedDate` older than 7 days
3. Client-side logic ignores expired URIs by checking `expiresAt`

#### Option 2: Manual Cleanup (Simpler for MVP)
1. Set blob metadata: `expiresAt` = ISO 8601 timestamp
2. Run a timer-triggered Azure Function daily to scan and delete expired blobs
3. Return `expiresAt` in response for client-side validation

**Recommendation:** Start with Option 2 for simplicity, migrate to Option 1 for production scale.

---

## Azure Function Structure

### Folder: `/api/cache`

**Files:**
```
api/cache/
├── function.json
└── index.js
```

### `function.json`
```json
{
  "bindings": [
    {
      "authLevel": "function",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["post", "options"],
      "route": "Complete Implementation)

```javascript
const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_TTL = 3600; // 1 hour
const MAX_TTL = 604800;   // 7 days
const MIN_TTL = 60;       // 1 minute

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    context.res = {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
    return;
  }

  try {
    // 1. Validate API key
    const apiKey = req.query.key;
    const expectedKey = process.env.CACHE_API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      context.res = {
        status: 401,
        body: { error: 'Unauthorized: Invalid or missing API key' },
      };
      return;
    }

    // 2. Validate input
    const { xml, ttl } = req.body || {};
    
    if (!xml) {
      context.res = { 
        status: 400, 
        body: { error: 'xml field is required' } 
      };
      return;
    }

    const validTtl = Math.min(Math.max(ttl || DEFAULT_TTL, MIN_TTL), MAX_TTL);

    // 3. Generate blob name
    const guid = uuidv4().replace(/-/g, '');
    const blobName = `${guid}.xml`;

    // 4. Upload to blob storage using SAS URL
    const sasUrl = process.env.CACHE_SAS_URL;
    if (!sasUrl) {
      context.log.error('CACHE_SAS_URL environment variable not configured');
      context.res = {
        status: 500,
        body: { error: 'Storage configuration missing' },
      };
      return;
    }

    const blobServiceClient = new BlobServiceClient(sasUrl);
    const containerClient = blobServiceClient.getContainerClient('');
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Convert XML string to buffer
    const buffer = Buffer.from(xml, 'utf-8');

    // Calculate expiry
    const expiresAt = new Date(Date.now() + validTtl * 1000).toISOString();

    // Upload with metadata
    await blockBlobClient.upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: 'text/xml; charset=utf-8' },
      metadata: { expiresAt },
    });

    // 5. Return response
    context.res = {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: {
        uri: blockBlobClient.url,
        blobName,
        expiresAt,
        sizeBytes: buffer.length,
      },
    };

  } catch (error) {
    context.log.error('Cache service error:', error);
    context.res = {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: { error: error.message || 'Internal server error' },
    };
  }
};   'text/xml': 'xml',
    'application/xml': 'xml',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/html': 'html',
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
  };

  return mimeMap[contentType] || 'bin';
}
```

---

## Dependencies

Add to `api/package.json`:

```json
{
  "dependencies": {
    "@azure/storage-blob": "^12.24.0",
    "uuid": "^9.0.0"
  }
}
```

Install:
```bash
cd api
npm install @azure/storage-blob uuid
```

---

## EnCACHE_API_KEY": "your-secret-key-here-use-strong-random-string",
    "CACHE_SAS_URL": "https://yourstorageaccount.blob.core.windows.net/cache?sv=2022-11-02&ss=b&srt=sco&sp=rwdlac&se=2027-12-31T23:59:59Z&st=2024-01-01T00:00:00Z&spr=https&sig=yoursignature"
  }
}
```

### How to Configure

#### 1. Generate API Key
Use a strong random string (32+ characters):

**PowerShell (all versions):**
```powershell
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

**PowerShell (simpler, using GUIDs):**
```powershell
[Convert]::ToBase64String([guid]::NewGuid().ToByteArray() + [guid]::NewGuid().ToByteArray())
```

**Node.js:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Bash/Linux:**
```bash
openssl rand -base64 32
```

**Online:** https://www.random.org/strings/ (use 32+ characters, mixed case + numbers + symbols)

Store the generated key in `CACHE_API_KEY` environment variable.

#### 2. Generate SAS URL
1. Azure Portal → Storage Account → Containers
2. Select or create `cache` container
3. Set **Public access level** to **Blob (anonymous read access for blobs only)**
4. Click **Shared access signature** in the left menu
5. Configure:
   - **Allowed services:** Blob
   - **Allowed resource types:** Service, Container, Object
   - **Allowed permissions:** Read, Write, Delete, List, Add, Create
   - **Start time:** Now
   - *apiKey = 'your-api-key-from-config';
const response = await fetch(`/api/cache?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    xml: xmlString,
    ttl: 1800, // 30 minutes
  }),
});

const { uri, expiresAt } = await response.json();
console.log(`XML cached until ${expiresAt}: ${uri}`);
```

### Use Case 2: Default TTL
```javascript
// Use default 1-hour TTL
const apiKey = 'your-api-key-from-config';
const response = await fetch(`/api/cache?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    xml: xmlString,
  }),
});

const { uri } = await response.json();
// Use uri to share or reference the datafy({ customers: [...], timestamp: Date.now() });

const response = await fetch('/api/cache', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    data: jsonData,
    contentType: 'application/json',
    ttl: 3600,
  }),
});

const { uri, expiresAt } = await response.json();
console.log(`Data cached until ${expiresAt}: ${uri}`);
```

### Use Case 3: Cache Binary File (Base64)
```javascript
const base64Image = btoa(binaryImageData);

const response = await fetch('/api/cache', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    data: base64Image,
    contentType: 'image/png',
    encoding: 'base64',
    ttl: 7200, // 2 hours
    fileName: 'logo.png',
  }),
});
API key authentication (missing key)
- ✅ Validate API key authentication (wrong key)
- ✅ Validate API key authentication (correct key)
- ✅ Validate required `xml` field
- ✅ Validate TTL bounds (min 60, max 604800)
- ✅ Test GUID generation and uniqueness
- ✅ Test XML UTF-8 encoding

### Integration Tests
- ✅ Upload XML data and verify blob exists
- ✅ Verify Content-Type is `text/xml; charset=utf-8`
- ✅ Verify returned URI is publicly accessible
- ✅ Verify blob metadata contains `expiresAt`
- ✅ Test CORS preflight (OPTIONS)
- ✅ Test error handling (missing SAS URL, invalid SAS URL)
- ✅ Test unauthorized access (no key)
- ✅ Test unauthorized access (wrong key)

### Manual Tests
- ✅ Cache XML from BC API response
- ✅ Verify URI can be opened in browser and displays XML
- ✅ Verify blob appears in Azure Storage Explorer
- ✅ Verify correct Content-Type in blob properties
- ✅ Verify metadata `expiresAt` is set correctly
- ✅ Test with large XML payloads (>1MB)
- ✅ Test concurrent uploads
- ✅ Test API key validation from different clientPTIONS)
- ✅ Test error handling (missing connection string, invalid container)

### Manual Tests
- ✅ Cache XML from BC API response
- ✅ Verify URI can be opened in browser
- ✅ Verify blob appears in Azure Storage Explorer
- ✅ Verify correct Content-Type in blob properties
- ✅ Verify metadata `expiresAt` is set correctly
- ✅ Test with large payloads (>1MB)
- ✅ Test concurrent uploads

---

## Optional Enhancements (Future)

### 1. GET /api/cache/{blobName}
Proxy read access with expiry validation:
```javascript
// Check metadata.expiresAt before returning blob
if (new Date() > new Date(metadata.expiresAt)) {
  return 410 Gone
}
return blob content
```

### 2. DELETE /api/cache/{blobName}
Allow manual deletion:
```javascript
await blockBlobClient.delete();
```

### 3. Timer-Triggered Cleanup Function
```javascript
// Runs daily at 2 AM UTC
module.exports = async function (context) {
  const containerClient = blobServiceClient.getContainerClient('cache');
  const now = new Date();

  for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
    const expiresAt = blob.metadata?.expiresAt;
    if (expiresAt && new Date(expiresAt) < now) {
      await containerClient.deleteBlob(blob.name);
      context.log(`Deleted expired blob: ${blob.name}`);
    }
  }
};
```

**Timer configuration (`function.json`):**
```json
{
  "bindings": [
    {
      "name": "timer",
      "type": "timerTrigger",
      "direction": "in",
      "schedule": "0 0 2 * * *"
    }
  ]
}
```

### 4. Compression Support
Add gzip compression for large text/JSON data:
```jaAPI key authentication** — all requests must include valid API key in URL parameter. Use strong random keys.
2. **Public read access** — blobs are publicly readable via URI. Do not cache sensitive data without additional security.
3. **Rate limiting** — consider implementing rate limiting to prevent abuse (Azure Functions has built-in throttling)
4. **Quota management** — monitor storage account usage and set alerts for capacity
5. **Input validation** — validate XML structure to prevent malformed uploads
6. **Secret management** — store `CACHE_API_KEY` and `CACHE_SAS_URL` in Azure Key Vault for production
7. **SAS expiry** — monitor SAS URL expiry and rotate before expiration (set calendar reminder)
8. **HTTPS only** — SAS URL should enforce HTTPS (`spr=https`)
9. **Minimal permissions** — SAS URL should only grant necessary permissions (read, write, delete, list, add, create on blob container)

### 5. Authentication
Require API key or Azure AD token:
```javascript
const apiKey = req.headers['x-api-key'];
if (apiKey !== process.env.CACHE_API_KEY) {
  return 401 Unauthorizednew BlobServiceClient(sasUrl)` |
| Connection string authentication | SAS URL authentication |
| `CloudBlobContainer.CreateIfNotExists()` | Not needed (container pre-exists) |
| `CloudBlockBlob.UploadFromStreamAsync()` | `blockBlobClient.upload(buffer, length)` |
| `Guid.NewGuid()` | `uuid.v4()` |
| `.Replace("-","")` | `.replace(/-/g, '')` |
| `StreamWriter` | `Buffer.from(xml, 'utf-8')` |
| HTTP Function (AuthLevel.Function) | URL parameter key authentication |
| Newtonsoft.Json | Native `JSON.parse()` / `JSON.stringify()` |

**Key improvements over original:**
- ✅ Explicit API key authentication (URL parameter)
- ✅ SAS URL instead of connection string (more flexible, more secure)
- ✅ TTL with metadata
- ✅ Input validation
- ✅ Better error handling with detailed messages
- ✅ CORS support
- ✅ Modern Azure SDK (v12)
- ✅ Simplified to XML-only (matching original use case
The original C# implementation (`CurrencyCacheService`) has been adapted as follows:

| C# Feature | JavaScript Equivalent |
|---|---|
| `Microsoft.Azure.Storage` (legacy SDK) | `@azure/storage-blob` (v12 SDK) |
| `CloudStorageAccount.Parse()` | `BlobServiceClient.fromConnectionString()` |
| `CloudBlobContainer.CreateIfNotExists()` | `containerClient.createIfNotExists()` |
| `CloudBlockBlob.UploadFromStreamAsync()` | `blockBlobClient.upload(buffer, length)` |
| `Guid.NewGuid()` | `uuid.v4()` |
| `.Replace("-","")` | `.replace(/-/g, '')` |
| `StreamWriter` | `Buffer.from(data, encoding)` |
| HTTP Function (AuthLevel.Function) | Same: `"authLevel": "function"` |
| Newtonsoft.Json | Native `JSON.parse()` / `JSON.stringify()` |

**Key improvements over original:**
- ✅ Generic data support (not just XML)
- ✅ Content-Type detection and configuration
- ✅ TTL with metadata
- ✅ Base64 encoding support
- ✅ Input validation
- ✅ Error handling
- ✅ Extension extraction logic
- ✅ Modern Azure SDK (v12)

---

## Files to Create/Modify

### New Files
1. `api/cache/index.js` — main function implementation
2. `api/cache/function.json` — function binding configuration

### Modified Files
1. `api/package.json` — add dependencies
2. `implementations/README.md` — add requirement 14 entry

---

## Acceptance Criteria

- ✅ POST /api/cache accepts data, contentType, ttl, fileName, encoding
- ✅ Returns uri, blobName, expiresAt, sizeBytes
- ✅ Blob is stored in `cache` container with public read access
- ✅ Blob URI is publicly accessible
- ✅ Content-Type header matches input
- ✅ Metadata contains expiresAt timestamp
- ✅ TTL validation enforces min/max bounds
- ✅ GUID-based blob naming prevents collisions
- ✅ CORS headers allow cross-origin requests
- ✅ Error responses return meaningful messages
- ✅ Base64 encoding support works correctly
- ✅ Extension detection from fileName and contentType works

---

## Deployment Notes

### Production Chec?key={...} requires valid API key
- ✅ Returns 401 Unauthorized if key is missing or invalid
- ✅ POST /api/cache accepts xml and ttl fields
- ✅ Returns uri, blobName, expiresAt, sizeBytes
- ✅ Blob is stored in configured container with public read access
- ✅ Blob URI is publicly accessible
- ✅ Content-Type is `text/xml; charset=utf-8`
- ✅ Metadata contains expiresAt timestamp
- ✅ TTL validation enforces min/max bounds (60s to 7 days)
- ✅ GUID-based blob naming prevents collisions
- ✅ All blobs named `{guid}.xml`
- ✅ CORS headers allow cross-origin requests
- ✅ Error responses return meaningful messages
- ✅ Environment variables `CACHE_API_KEY` and `CACHE_SAS_URL` are requiredon`
2. Add `AZURE_STORAGE_CONNECTION_STRING` from Azure Portal
3. Run `npm install` in `api/` folder
4. Start Azure Functions runtime: `npm run start` or use VS Code Azure Functions extension
5. Test with curl or Postman:
```bash
curl -X POST http://localhost:7071/api/ca (anonymous read access for blobs only)** public access level
3. ✅ Generate SAS URL for container (1+ year expiry, rwdlac permissions, HTTPS-only)
4. ✅ Generate strong random API key (32+ characters)
5. ✅ Add `CACHE_API_KEY` and `CACHE_SAS_URL` to Azure Static Web App configuration
6. ✅ Deploy function via GitHub Actions or Azure CLI
7. ✅ Test POST /api/cache?key=... endpoint
8. ✅ Verify blob accessibility via returned URI
9. ✅ Configure Lifecycle Management Policy for automatic cleanup (optional)
10. ✅ Set up monitoring and alerts for storage usage
11. ✅ Set calendar reminder to rotate SAS URL before expiry

### Local Development
1. Copy `local.settings.json.example` to `local.settings.json`
2. Generate API key and SAS URL (see Environment Variables section)
3. Add `CACHE_API_KEY` and `CACHE_SAS_URL` to `local.settings.json`
4. Run `npm install` in `api/` folder
5. Start Azure Functions runtime: `npm run start` or use VS Code Azure Functions extension
6. Test with curl or Postman:
```bash
curl -X POST "http://localhost:7071/api/cache?key=your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{"xml":"<root><item>test</item></root>","ttl":600}'
```

**Example response:**
```json
{
  "uri": "https://yourstorageaccount.blob.core.windows.net/cache/abc123def456.xml",
  "blobName": "abc123def456.xml",
  "expiresAt": "2026-03-20T15:30:00Z",
  "sizeBytes": 35
}