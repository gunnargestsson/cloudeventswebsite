# Requirement 8: BC Metadata MCP Server

## Overview

Document, stabilise, and extend the existing Model Context Protocol (MCP) server that exposes
Business Central metadata and data to AI assistants and developer tooling.

The server runs as an Azure Function at `/api/mcp`, uses the **Streamable HTTP** MCP transport
(JSON-RPC 2.0, protocol version `2024-11-05`), and authenticates to Business Central using
server-side credentials (`BC_TENANT_ID`, `BC_CLIENT_ID`, `BC_CLIENT_SECRET`).

A discovery file at `/.well-known/mcp.json` allows MCP-aware clients to auto-configure.

---

## Current State (as implemented)

### Endpoint
```
POST https://dynamics.is/api/mcp
```

### Credentials
| Env var | Required | Notes |
|---|---|---|
| `BC_TENANT_ID` | ✅ | Entra tenant GUID or domain |
| `BC_CLIENT_ID` | ✅ | App registration client ID |
| `BC_CLIENT_SECRET` | ✅ | Client secret |
| `BC_ENVIRONMENT` | ❌ | Defaults to `"production"` |

### Existing Tools

#### `list_tables`
Returns all tables in the BC company via `Help.Tables.Get`.

**Parameters:** `lcid` (integer, default 1033)  
**Returns:** `{ company, tableCount, tables: [{id, name, caption}] }`

#### `get_table_info`
Returns summary for one specific table (by name or number).

**Parameters:** `table` (string, required), `lcid`  
**Returns:** `{ company, table: {id, name, caption} }`

#### `get_table_fields`
Returns all fields for a table plus read/write permissions.

**Parameters:** `table` (string, required), `lcid`  
**Returns:** `{ company, table, permissions, fieldCount, fields: [{number, name, jsonName, caption, type, length, class, isPartOfPrimaryKey, enum}] }`

### Internal behaviour
- Entra token cached in module memory (expires 60 s before JWT expiry)
- Company resolved once via `GET /v2.0/{tenant}/{env}/api/v2.0/companies` — first result cached for module lifetime
- Batch JSON-RPC supported (`POST` with array body)
- CORS preflight (`OPTIONS`) returns 204 with wildcard headers
- Missing env vars return HTTP 500 with JSON-RPC `InternalError`

---

## Improvements & Additions

### 1. Company targeting (configuration)

**Problem:** The server always uses the first company returned by the BC REST API.  
**Solution:** Add optional env vars for explicit company selection.

```
BC_COMPANY_ID    — GUID of target company (takes priority)
BC_COMPANY_NAME  — Display name of target company (fallback match)
```

If neither is set, behaviour remains: use first company.  
Log a warning if multiple companies exist and neither var is set.

---

### 2. New Tool: `list_companies`

Expose the company list so MCP clients can discover available companies.

```jsonc
// Tool definition
{
  "name": "list_companies",
  "description": "Lists all companies available in the Business Central environment.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

**Returns:**
```jsonc
{ "companies": [{ "id": "guid", "name": "CRONUS International Ltd." }] }
```

---

### 3. New Tool: `list_message_types`

Exposes the BC Cloud Events message catalogue via `Help.MessageTypes.Get`.  
This is the primary discovery mechanism for what a BC installation can do.

```jsonc
{
  "name": "list_message_types",
  "description": "Lists all Cloud Event message types available in the Business Central company, grouped by namespace (e.g. Data, Help, Custom). Each type includes direction (Inbound / Outbound / Both) and a short description.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filter": {
        "type": "string",
        "description": "Optional name prefix or substring filter (case-insensitive)."
      }
    }
  }
}
```

**Returns:**
```jsonc
{
  "company": "CRONUS",
  "typeCount": 42,
  "types": [
    { "name": "Customer.Create", "direction": "Inbound", "description": "..." }
  ]
}
```

---

### 4. New Tool: `get_records`

Read data records from any BC table or entity via `Data.Records.Get`.  
This is the most broadly useful new capability — it turns the MCP server into a general-purpose
BC data reader that any AI assistant can use.

```jsonc
{
  "name": "get_records",
  "description": "Reads records from a Business Central table. Supports filtering, paging, and field selection. Returns up to 50 records by default.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "table": {
        "type": "string",
        "description": "BC table name (e.g. 'Customer', 'Item', 'Sales Header')."
      },
      "filter": {
        "type": "string",
        "description": "Optional BC-style tableView filter, e.g. \"WHERE(Blocked=CONST( ))\"."
      },
      "fields": {
        "type": "array",
        "items": { "type": "integer" },
        "description": "Optional list of field numbers to return. Omit to return all fields."
      },
      "skip": { "type": "integer", "description": "Records to skip for paging (default 0)." },
      "take": { "type": "integer", "description": "Max records to return (default 50, max 200)." },
      "lcid": { "type": "integer", "description": "LCID for caption-based enum values." }
    },
    "required": ["table"]
  }
}
```

**Returns:**
```jsonc
{
  "company": "CRONUS",
  "table": "Customer",
  "skip": 0,
  "take": 50,
  "count": 42,
  "records": [
    { "primaryKey": { "No": "10000" }, "fields": { "Name": "Adatum", "Blocked": " " } }
  ]
}
```

**Security note:** `take` must be capped at 200 server-side regardless of client input.  
The `filter` string is passed verbatim to BC (BC validates it server-side); no additional
sanitisation is required beyond ensuring it is a string.

---

### 5. New Tool: `search_customers`

Convenience wrapper around `Data.Records.Get` on the Customer table.  
Optimised for AI assistant use: natural-language search by name, number, or registration number.

```jsonc
{
  "name": "search_customers",
  "description": "Search for customers in Business Central by name or customer number. Returns matching customers with key fields.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Customer name or number to search for (partial match)."
      },
      "take": { "type": "integer", "description": "Max results (default 10, max 50)." }
    },
    "required": ["query"]
  }
}
```

**Implementation:** Use `Data.Records.Get` with `tableView: "WHERE(Name=FILTER(*{query}*))"`
and field numbers `[1, 2, 5, 7, 9, 35]` (No., Name, Address, Phone, Contact, Country).  
If query looks like a customer number (numeric), also try exact `No.=CONST(...)` match.

---

### 6. New Tool: `search_items`

Same pattern as `search_customers` but for the Item table.

```jsonc
{
  "name": "search_items",
  "description": "Search for items/products in Business Central by description or item number.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Item description or number (partial match)." },
      "take": { "type": "integer", "description": "Max results (default 10, max 50)." }
    },
    "required": ["query"]
  }
}
```

**Fields returned:** No., Description, Unit of Measure, Unit Price, Inventory, Blocked.

---

### 7. Pagination for `list_tables`

`Help.Tables.Get` returns all 1 000+ BC tables in one call.  
Add `filter` and `take` / `skip` to avoid overwhelming LLM context windows.

```jsonc
// Additional parameters for list_tables
"filter": { "type": "string", "description": "Substring filter on table name (case-insensitive)." },
"take":   { "type": "integer", "description": "Max tables to return (default 200)." },
"skip":   { "type": "integer", "description": "Tables to skip (default 0)." }
```

Filtering happens **after** the BC call (BC does not support server-side table name filter on
`Help.Tables.Get`), so the full result is fetched and sliced in the function.

---

### 8. Markdown output format

LLMs consume plain text better than raw JSON for tabular data.  
Add an optional `format` parameter to `get_table_fields` and `get_records`.

| Value | Behaviour |
|---|---|
| `"json"` (default) | Current JSON output |
| `"markdown"` | Returns a Markdown table with column headers |

Example for `get_table_fields` in markdown mode:
```
| # | Name | JSON Key | Caption | Type | Len | Class | PK |
|---|------|----------|---------|------|-----|-------|-----|
| 1 | No. | no | No. | Code | 20 | Normal | ✓ |
| 2 | Name | name | Name | Text | 100 | Normal | |
```

---

### 9. MCP Resources

MCP Resources allow clients to `read` well-known URIs rather than calling a tool.  
Implement the `resources/list` and `resources/read` methods.

#### Defined resources

| URI | Content | MIME type |
|---|---|---|
| `bc://companies` | JSON list of all companies | `application/json` |
| `bc://message-types` | JSON list from `Help.MessageTypes.Get` | `application/json` |
| `bc://tables` | Full table list (JSON) | `application/json` |
| `bc://tables/{name}` | Fields for one table (JSON) | `application/json` |

**capabilities declaration:**
```jsonc
"capabilities": { "tools": {}, "resources": {} }
```

---

### 10. MCP Prompts

MCP Prompts provide reusable prompt templates.  
Implement `prompts/list` and `prompts/get`.

#### Defined prompts

| Name | Description |
|---|---|
| `describe_table` | Generates a structured description of a BC table including all fields, types, and enums |
| `find_tables_for_entity` | Finds all tables related to a given business entity (e.g. "sales", "inventory") |
| `data_model_overview` | Returns a high-level overview of the BC data model grouped by functional area |

**Prompt definition example:**
```jsonc
{
  "name": "describe_table",
  "description": "Get a complete description of a Business Central table for documentation or analysis.",
  "arguments": [
    { "name": "table", "description": "Table name or number", "required": true },
    { "name": "lcid", "description": "Language LCID (default 1033)", "required": false }
  ]
}
```

When `prompts/get` is called with `describe_table`, the server calls `toolGetTableFields` and
returns a pre-formatted user message with the schema embedded.

---

### 11. Security improvements

#### 11a. Optional API key
Add optional `MCP_API_KEY` env var.  
If set, requests without `Authorization: Bearer {key}` return HTTP 401.  
If not set, the server remains open (current behaviour for intranet / trusted use).

```jsonc
// In Azure Function application settings:
"MCP_API_KEY": "a-random-secret-token"
```

#### 11b. Table parameter sanitisation
The `table` parameter is used in `subject` / `data.tableName` of Cloud Event envelopes.  
Validate that it contains only: alphanumeric characters, spaces, underscores, hyphens, and dots.  
Reject with error message if it contains `{`, `}`, `"`, `\`, or control characters.

Regex: `/^[\w\s.\-]{1,80}$/`

#### 11c. take / skip bounds
Always enforce upper bounds server-side:
- `get_records`: `take` ≤ 200
- `list_tables`: `take` ≤ 500
- `search_customers` / `search_items`: `take` ≤ 50

---

### 12. Token cache hardening

**Problem:** Module-level `_token` and `_companyId` survive across warm invocations but are lost on cold starts. If BC_ENVIRONMENT changes or multiple companies exist, the cached company may be wrong.

**Improvements:**
- Store the env var values used when `_companyId` was cached; if they change, invalidate.
- Add `_companyCacheEnv` string: `${BC_TENANT_ID}|${BC_ENVIRONMENT}` — if different from cached, refetch.
- Keep existing 60 s pre-expiry buffer on the token.

---

### 13. Well-known discovery improvements

Update `/.well-known/mcp.json` to include the full tool list and authentication requirements:

```jsonc
{
  "mcpVersion": "2024-11-05",
  "name": "BC Metadata MCP Server",
  "description": "Exposes Business Central table metadata, field definitions, message types, and data records via the Cloud Events API.",
  "endpoint": "https://dynamics.is/api/mcp",
  "transport": "http",
  "authentication": {
    "type": "bearer",
    "required": false,
    "note": "Set Authorization: Bearer {MCP_API_KEY} if the server is configured with a key."
  },
  "tools": [
    "list_tables", "get_table_info", "get_table_fields",
    "list_companies", "list_message_types",
    "get_records", "search_customers", "search_items"
  ]
}
```

---

## Implementation Order (recommended)

| Priority | Item | Effort |
|---|---|---|
| 🔴 High | §11b table input validation | < 30 min |
| 🔴 High | §11c take/skip bounds | < 30 min |
| 🔴 High | §1 BC_COMPANY_ID / BC_COMPANY_NAME env vars | ~1 h |
| 🟡 Medium | §2 `list_companies` tool | ~30 min |
| 🟡 Medium | §3 `list_message_types` tool | ~1 h |
| 🟡 Medium | §4 `get_records` tool | ~2 h |
| 🟡 Medium | §5 `search_customers` tool | ~1 h |
| 🟡 Medium | §6 `search_items` tool | ~30 min |
| 🟡 Medium | §7 list_tables filter/paging params | ~30 min |
| 🟢 Low | §8 markdown output format | ~1 h |
| 🟢 Low | §9 MCP Resources | ~2 h |
| 🟢 Low | §10 MCP Prompts | ~1 h |
| 🟢 Low | §11a API key auth | ~1 h |
| 🟢 Low | §12 token cache hardening | ~30 min |
| 🟢 Low | §13 well-known improvements | ~15 min |

---

## File Locations

| File | Notes |
|---|---|
| `api/mcp/index.js` | Azure Function entry point + all MCP logic |
| `api/mcp/function.json` | HTTP trigger binding (POST, OPTIONS) |
| `.well-known/mcp.json` | MCP discovery document |
| `staticwebapp.config.json` | Route rules (ensure `/.well-known/mcp.json` and `/api/mcp` are reachable) |

---

## Testing

### Manual (via curl / Postman)

```bash
# Initialize
curl -s -X POST https://dynamics.is/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0"},"protocolVersion":"2024-11-05"}}'

# List tools
curl -s -X POST https://dynamics.is/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call list_tables
curl -s -X POST https://dynamics.is/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tables","arguments":{}}}'
```

### AI Client integration
Configure in GitHub Copilot (`settings.json`):
```jsonc
"mcp": {
  "servers": {
    "bc-metadata": {
      "type": "http",
      "url": "https://dynamics.is/api/mcp"
    }
  }
}
```

Configure in Claude Desktop (`claude_desktop_config.json`):
```jsonc
{
  "mcpServers": {
    "bc-metadata": {
      "command": "npx",
      "args": ["mcp-remote", "https://dynamics.is/api/mcp"]
    }
  }
}
```

### Checklist
- [ ] `initialize` returns `protocolVersion: "2024-11-05"` and correct server info
- [ ] `tools/list` returns all defined tools with valid JSON Schema
- [ ] `list_tables` returns table list with correct company name
- [ ] `get_table_fields` on "Customer" returns ≥ 100 fields with jsonName populated
- [ ] `get_table_fields` with invalid table name returns `isError: true`
- [ ] `list_companies` returns at least one company
- [ ] `list_message_types` returns available types
- [ ] `get_records` on "Customer" with `take: 5` returns exactly 5 records
- [ ] `get_records` with `take: 300` is capped to 200
- [ ] `search_customers` with "Adatum" returns matching customers
- [ ] Table parameter with injection characters (`{`, `"`) returns validation error
- [ ] Batch request `[msg1, msg2]` returns two responses
- [ ] `notifications/initialized` returns HTTP 202 with no body
- [ ] Cold start (fresh function instance) completes first call successfully
- [ ] `/.well-known/mcp.json` is reachable and returns valid JSON
