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

Each item below is **❌ Not Implemented**. The file to edit is `api/mcp/index.js` unless noted otherwise.

---

### 1. Company targeting via environment variables
**Status:** ✅ Implemented  
**Priority:** 🔴 High  
**File:** `api/mcp/index.js` — `getCompany()` function

**Problem:** The server always picks the first company returned by BC, which is non-deterministic when multiple companies exist.

**Solution:** Honour two new optional env vars: `BC_COMPANY_ID` (GUID, checked first) and `BC_COMPANY_NAME` (display name, fallback). If neither is set, fall back to the current first-company behaviour.

**Implementation — replace `getCompany()`:**
```js
async function getCompany() {
  if (_companyId) return { id: _companyId, name: _companyName };

  const tenantId  = process.env.BC_TENANT_ID;
  const env       = process.env.BC_ENVIRONMENT || "production";
  const targetId  = process.env.BC_COMPANY_ID;
  const targetName = (process.env.BC_COMPANY_NAME || "").toLowerCase();

  const result    = await bcGet(`/v2.0/${tenantId}/${env}/api/v2.0/companies`);
  const companies = Array.isArray(result) ? result : (result.value || []);
  if (!companies.length) throw new Error("No companies found in Business Central");

  let company;
  if (targetId) {
    company = companies.find(c => c.id === targetId);
    if (!company) throw new Error(`Company with id '${targetId}' not found`);
  } else if (targetName) {
    company = companies.find(c => (c.name || "").toLowerCase() === targetName);
    if (!company) throw new Error(`Company with name '${process.env.BC_COMPANY_NAME}' not found`);
  } else {
    if (companies.length > 1) {
      console.warn(`[MCP] Multiple companies found; using first. Set BC_COMPANY_ID to pin a specific company.`);
    }
    company = companies[0];
  }

  _companyId   = company.id;
  _companyName = company.name;
  return { id: _companyId, name: _companyName };
}
```

---

### 2. New Tool: `list_companies`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Returns all companies in the BC environment. Useful for clients to discover available companies before targeting one.

**Implementation — add tool function:**
```js
async function toolListCompanies() {
  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";

  const result    = await bcGet(`/v2.0/${tenantId}/${env}/api/v2.0/companies`);
  const companies = (Array.isArray(result) ? result : (result.value || []))
    .map(c => ({ id: c.id, name: c.name, displayName: c.displayName }));

  return { companies };
}
```

**Add to `TOOLS` array:**
```js
{
  name:        "list_companies",
  description: "Lists all companies available in the Business Central environment.",
  inputSchema: { type: "object", properties: {} },
},
```

**Add to `tools/call` switch:**
```js
case "list_companies": content = await toolListCompanies(); break;
```

**Returns:**
```jsonc
{ "companies": [{ "id": "guid", "name": "CRONUS International Ltd.", "displayName": "CRONUS" }] }
```

---

### 3. New Tool: `list_message_types`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Exposes the BC Cloud Events message catalogue via `Help.MessageTypes.Get`. This is the primary discovery mechanism for what a specific BC installation can process. The optional `filter` parameter performs a substring match client-side after the BC call (BC doesn't support server-side filtering on this endpoint).

**Implementation — add tool function:**
```js
async function toolListMessageTypes({ filter } = {}) {
  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Help.MessageTypes.Get",
    source:      "BC Metadata MCP v1.0",
  });

  let types = result.result || result.value || (Array.isArray(result) ? result : []);
  if (filter) {
    const lf = filter.toLowerCase();
    types = types.filter(t => (t.name || "").toLowerCase().includes(lf));
  }

  return { company: company.name, typeCount: types.length, types };
}
```

**Add to `TOOLS` array:**
```js
{
  name:        "list_message_types",
  description: "Lists all Cloud Event message types available in the Business Central company. Each type includes its name, direction (Inbound/Outbound/Both), and description.",
  inputSchema: {
    type:       "object",
    properties: {
      filter: { type: "string", description: "Optional substring filter on type name (case-insensitive)." },
    },
  },
},
```

**Returns:**
```jsonc
{
  "company": "CRONUS",
  "typeCount": 42,
  "types": [{ "name": "Customer.Create", "direction": "Inbound", "description": "..." }]
}
```

---

### 4. New Tool: `get_records`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Reads records from any BC table via `Data.Records.Get`. Supports filtering, field selection, and paging. This is the most broadly useful addition — it makes the MCP server a general-purpose BC data reader.

**Implementation — add tool function:**
```js
async function toolGetRecords({ table, filter, fields, skip = 0, take = 50, lcid = 1033 } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);                          // see §11b
  take = Math.min(Number(take) || 50, 200);          // cap at 200 (see §11c)
  skip = Math.max(Number(skip) || 0, 0);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const data = { tableName: String(table), skip, take };
  if (filter) data.tableView = String(filter);
  if (Array.isArray(fields) && fields.length) data.fieldNumbers = fields;

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
    lcid,
  });

  const records = result.result || result.value || (Array.isArray(result) ? result : []);
  return { company: company.name, table: String(table), skip, take, count: records.length, records };
}
```

**Add to `TOOLS` array:**
```js
{
  name:        "get_records",
  description: "Reads records from a Business Central table with optional filter, field selection, and paging. Returns up to 50 records by default (max 200).",
  inputSchema: {
    type:       "object",
    properties: {
      table:  { type: "string",  description: "BC table name (e.g. 'Customer', 'Item', 'Sales Header')." },
      filter: { type: "string",  description: "BC-style tableView filter, e.g. \"WHERE(Blocked=CONST( ))\"." },
      fields: { type: "array", items: { type: "integer" }, description: "Field numbers to return (omit for all)." },
      skip:   { type: "integer", description: "Records to skip for paging (default 0)." },
      take:   { type: "integer", description: "Max records to return (default 50, max 200)." },
      lcid:   { type: "integer", description: "Language LCID for enum captions (default 1033)." },
    },
    required: ["table"],
  },
},
```

---

### 5. Enhanced Tool: `search_customers` — Multi-field parallel search
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Upgraded from a 2-field OR search to a multi-field parallel search engine. Searches 9 fields simultaneously using `Data.RecordIds.Get` per field, deduplicates SystemIds (capped at 100), then fetches full records in a single `Data.Records.Get` call.

**Search fields:** No., Name, Address, Post Code, City, Registration No., Contact, Phone No., E-Mail

**Result field numbers:** 1, 2, 5, 7, 8, 9, 23, 35, 86, 91, 102

**Algorithm:**
1. Escape BC filter characters in user input (`*|&<>='"\()@` → `?`)
2. Fire 9 parallel `Data.RecordIds.Get` calls — one per search field — with `@*escaped*` filter (case-insensitive)
3. Collect SystemIds into a `Set` (automatic deduplication, capped at 100)
4. If any IDs found, fetch full records with `WHERE(System Id=FILTER(id1|id2|...))`
5. Return up to `take` records (default 50, max 100)

**Implementation — add tool function:**
```js
async function toolSearchCustomers({ query, take = 10 } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 10, 50);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const isNo    = /^[\w\-]+$/.test(String(query).trim()) && query.length <= 20;
  const filter  = isNo
    ? `WHERE(No.=FILTER(${query}*)|Name=FILTER(*${query}*))`
    : `WHERE(Name=FILTER(*${query}*))`;

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify({ tableName: "Customer", tableView: filter, fieldNumbers: [1, 2, 5, 8, 23, 35], take }),
  });

  const records = result.result || result.value || [];
  return { company: company.name, query, count: records.length, customers: records };
}
```

**Add to `TOOLS` array:**
```js
{
  name:        "search_customers",
  description: "Search for customers in Business Central by name or customer number. Returns key fields (No., Name, Address, Phone, Contact, Country).",
  inputSchema: {
    type:       "object",
    properties: {
      query: { type: "string",  description: "Customer name or number to search for (partial match supported)." },
      take:  { type: "integer", description: "Max results to return (default 10, max 50)." },
    },
    required: ["query"],
  },
},
```

---

### 6. Enhanced Tool: `search_items` — Multi-field parallel search
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Upgraded to the same multi-field parallel search engine as `search_customers`. Searches 6 fields simultaneously.

**Search fields:** No., Description, Description 2, Vendor Item No., Base Unit of Measure, Item Category Code

**Result field numbers:** 1, 3, 4, 8, 18, 21, 54, 5702, 5704

**Algorithm:** Same as §5 — parallel `Data.RecordIds.Get` per field → deduplicated ID Set (max 100) → single `Data.Records.Get`.

**Implementation — add tool function:**
```js
async function toolSearchItems({ query, take = 10 } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 10, 50);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const filter = /^[\w\-]+$/.test(String(query).trim()) && query.length <= 20
    ? `WHERE(No.=FILTER(${query}*)|Description=FILTER(*${query}*))`
    : `WHERE(Description=FILTER(*${query}*))`;

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify({ tableName: "Item", tableView: filter, fieldNumbers: [1, 3, 8, 18, 21, 54], take }),
  });

  const records = result.result || result.value || [];
  return { company: company.name, query, count: records.length, items: records };
}
```

**Add to `TOOLS` array:**
```js
{
  name:        "search_items",
  description: "Search for items/products in Business Central by description or item number. Returns No., Description, Unit of Measure, Unit Price, Inventory, and Blocked status.",
  inputSchema: {
    type:       "object",
    properties: {
      query: { type: "string",  description: "Item description or number to search for (partial match supported)." },
      take:  { type: "integer", description: "Max results to return (default 10, max 50)." },
    },
    required: ["query"],
  },
},
```

---

### 7. Filter and paging for `list_tables`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js` — `toolListTables()` and the `list_tables` entry in `TOOLS`

**Problem:** BC returns 1 000+ tables in a single call. Passing the full list to an LLM wastes context window and can cause truncation.

**Solution:** Add `filter`, `take`, and `skip` parameters. Filtering is client-side (BC does not support name filters on `Help.Tables.Get`).

**Implementation — update `toolListTables()`:**
```js
async function toolListTables({ lcid = 1033, filter, skip = 0, take = 200 } = {}) {
  take = Math.min(Number(take) || 200, 500);
  skip = Math.max(Number(skip) || 0, 0);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0", type: "Help.Tables.Get", source: "BC Metadata MCP v1.0", lcid,
  });

  let tables = result.result || result.value || result.tables || (Array.isArray(result) ? result : []);
  if (filter) {
    const lf = filter.toLowerCase();
    tables = tables.filter(t => (t.name || "").toLowerCase().includes(lf) || (t.caption || "").toLowerCase().includes(lf));
  }
  const total = tables.length;
  tables = tables.slice(skip, skip + take);

  return { company: company.name, total, skip, take, tableCount: tables.length, tables };
}
```

**Update `TOOLS` entry for `list_tables`** to add the new parameters to `inputSchema.properties`:
```js
filter: { type: "string",  description: "Substring filter on table name or caption (case-insensitive)." },
take:   { type: "integer", description: "Max tables to return (default 200, max 500)." },
skip:   { type: "integer", description: "Number of tables to skip for paging (default 0)." },
```

---

### 8. Markdown output format
**Status:** ✅ Implemented  
**Priority:** 🟢 Low  
**File:** `api/mcp/index.js` — `toolGetTableFields()` and `toolGetRecords()`

**Description:** Add an optional `format` parameter (`"json"` | `"markdown"`) to `get_table_fields` and `get_records`. Markdown tables are easier for LLMs to read and present to users.

**Implementation — format helper:**
```js
function toMarkdownTable(headers, rows) {
  const sep = headers.map(() => "---");
  const lines = [
    "| " + headers.join(" | ") + " |",
    "| " + sep.join(" | ") + " |",
    ...rows.map(r => "| " + r.map(v => String(v ?? "").replace(/\|/g, "\\|")).join(" | ") + " |"),
  ];
  return lines.join("\n");
}
```

**Usage in `toolGetTableFields()`:**
```js
if (format === "markdown") {
  const md = toMarkdownTable(
    ["#", "Name", "JSON Key", "Caption", "Type", "Len", "Class", "PK"],
    fields.map(f => [f.number, f.name, f.jsonName, f.caption, f.type, f.length || "", f.class || "", f.isPartOfPrimaryKey ? "✓" : ""]),
  );
  return { company: company.name, table: String(table), permissions, fieldCount: fields.length, markdown: md };
}
```

**Add `format` to `inputSchema` for both tools:**
```js
format: { type: "string", enum: ["json", "markdown"], description: "Output format: 'json' (default) or 'markdown' for LLM-friendly table output." },
```

---

### 9. MCP Resources
**Status:** ✅ Implemented  
**Priority:** 🟢 Low  
**File:** `api/mcp/index.js` — `initialize` response, `handleMessage()` switch

**Description:** MCP Resources let clients subscribe to or read named URIs. Add `resources/list` and `resources/read` to the dispatcher and declare `"resources": {}` in capabilities.

**Resources to expose:**

| URI | Description | MIME type |
|---|---|---|
| `bc://companies` | All companies | `application/json` |
| `bc://message-types` | All message types | `application/json` |
| `bc://tables` | Full table list | `application/json` |
| `bc://tables/{name}` | Fields for one table | `application/json` |

**Implementation — add to `handleMessage()` switch:**
```js
case "resources/list":
  return {
    jsonrpc: "2.0", id,
    result: {
      resources: [
        { uri: "bc://companies",      name: "Companies",      mimeType: "application/json" },
        { uri: "bc://message-types",  name: "Message Types",  mimeType: "application/json" },
        { uri: "bc://tables",         name: "Tables",         mimeType: "application/json" },
      ],
    },
  };

case "resources/read": {
  const uri = (params || {}).uri || "";
  let data;
  if (uri === "bc://companies")     data = await toolListCompanies();
  else if (uri === "bc://message-types") data = await toolListMessageTypes();
  else if (uri === "bc://tables")   data = await toolListTables({});
  else if (uri.startsWith("bc://tables/")) {
    const tableName = decodeURIComponent(uri.slice("bc://tables/".length));
    data = await toolGetTableFields({ table: tableName });
  } else {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } };
  }
  return {
    jsonrpc: "2.0", id,
    result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] },
  };
}
```

**Update `initialize` response:**
```js
capabilities: { tools: {}, resources: {} },
```

---

### 10. MCP Prompts
**Status:** ✅ Implemented  
**Priority:** 🟢 Low  
**File:** `api/mcp/index.js` — `handleMessage()` switch

**Description:** MCP Prompts expose reusable prompt templates. The server generates the full prompt content server-side (fetching live BC data) so the LLM receives a ready-to-use context block.

**Prompts to implement:**

| Name | Arguments | Description |
|---|---|---|
| `describe_table` | `table` (required), `lcid` | Full field schema as a structured prompt |
| `find_tables_for_entity` | `entity` (required) | Filters the table list to match a business concept |
| `data_model_overview` | — | Groups all tables by functional namespace |
| `sales_order_creation_workflow` | `lcid` (optional) | 3-step sales order creation recipe with live Sales Header / Sales Line field names |
| `customer_lookup_pattern` | — | Customer lookup guide with live Customer field table for this BC instance |
| `item_lookup_pattern` | — | Item lookup guide with live Item field table for this BC instance |

**Implementation — add to `handleMessage()` switch:**
```js
case "prompts/list":
  return {
    jsonrpc: "2.0", id,
    result: {
      prompts: [
        {
          name: "describe_table",
          description: "Generates a complete description of a BC table including all fields, types, and enums.",
          arguments: [
            { name: "table", description: "Table name or number", required: true },
            { name: "lcid",  description: "Language LCID (default 1033)", required: false },
          ],
        },
        {
          name: "find_tables_for_entity",
          description: "Lists BC tables related to a given business entity name (e.g. 'sales', 'vendor').",
          arguments: [{ name: "entity", description: "Business concept to search for", required: true }],
        },
        {
          name: "data_model_overview",
          description: "Provides a high-level overview of BC tables grouped by namespace.",
          arguments: [],
        },
        {
          name: "sales_order_creation_workflow",
          description: "Returns a step-by-step sales order creation recipe pre-populated with the live Sales Header and Sales Line field names for this BC instance.",
          arguments: [
            { name: "lcid", description: "Language LCID for field captions (default 1033)", required: false },
          ],
        },
        {
          name: "customer_lookup_pattern",
          description: "Returns a customer lookup guide with the complete live Customer field table for this BC instance.",
          arguments: [],
        },
        {
          name: "item_lookup_pattern",
          description: "Returns an item lookup guide with the complete live Item field table for this BC instance.",
          arguments: [],
        },
      ],
    },
  };

case "prompts/get": {
  const promptName = (params || {}).name;
  const promptArgs = (params || {}).arguments || {};
  let text;
  if (promptName === "describe_table") {
    const data = await toolGetTableFields({ table: promptArgs.table, lcid: promptArgs.lcid, format: "markdown" });
    text = `## Business Central Table: ${promptArgs.table}\n\n**Company:** ${data.company}\n**Fields:** ${data.fieldCount}\n**Permissions:** read=${data.permissions?.read}, write=${data.permissions?.write}\n\n${data.markdown}`;
  } else if (promptName === "find_tables_for_entity") {
    const data = await toolListTables({ filter: promptArgs.entity });
    text = `## BC Tables matching "${promptArgs.entity}"\n\n` + data.tables.map(t => `- **${t.name}** (#${t.id}): ${t.caption || ""}`).join("\n");
  } else if (promptName === "data_model_overview") {
    const data = await toolListTables({});
    const groups = {};
    for (const t of data.tables) {
      const ns = t.name.split(" ")[0];
      (groups[ns] = groups[ns] || []).push(t.name);
    }
    text = "## BC Data Model Overview\n\n" + Object.entries(groups).map(([ns, names]) => `### ${ns}\n${names.join(", ")}`).join("\n\n");
  } else if (promptName === "sales_order_creation_workflow") {
    const lcid = Number(promptArgs.lcid) || 1033;
    const [headerData, lineData] = await Promise.all([
      toolGetTableFields({ table: "Sales Header", lcid, format: "markdown" }),
      toolGetTableFields({ table: "Sales Line",   lcid, format: "markdown" }),
    ]);
    text = `## Sales Order Creation Workflow\n\n` +
      `Company: **${headerData.company}**\n\n` +
      `This requires three \`Data.Records.Set\` calls via the Cloud Events API.\n\n` +
      `### Step 1 — Create the Sales Header\n` +
      `Send \`Data.Records.Set\` with \`tableName: "Sales Header"\` and \`mode: "insert"\`.\n` +
      `Key fields: \`sellToCustomerNo\` (customer No.), \`orderDate\`, \`documentType\` = \`"Order"\`.\n\n` +
      `**All Sales Header fields (${headerData.company}):**\n${headerData.markdown}\n\n` +
      `### Step 2 — Read back the assigned No.\n` +
      `The response record contains the full header. Read \`fields.no\` — this is the document number used in steps 3+.\n\n` +
      `### Step 3 — Create Sales Lines\n` +
      `For each product line, send \`Data.Records.Set\` with \`tableName: "Sales Line"\`, \`mode: "insert"\`.\n` +
      `Key fields: \`documentType\` = \`"Order"\`, \`documentNo\` (from step 2), \`lineNo\` (10000, 20000, …), \`type\` = \`"Item"\`, \`no\` (item No.), \`quantity\`.\n\n` +
      `**All Sales Line fields (${headerData.company}):**\n${lineData.markdown}`;
  } else if (promptName === "customer_lookup_pattern") {
    const data = await toolGetTableFields({ table: "Customer", format: "markdown" });
    text = `## Customer Lookup Pattern\n\n` +
      `Company: **${data.company}**\n\n` +
      `Use \`Data.Records.Get\` with \`tableName: "Customer"\`.\n\n` +
      `**tableView filter examples:**\n` +
      `- By No. (exact): \`WHERE(No.=FILTER(C00001))\`\n` +
      `- By name (wildcard): \`WHERE(Name=FILTER(*Cannon*))\`\n` +
      `- Either: \`WHERE(No.=FILTER(C*)|Name=FILTER(*Cannon*))\`\n` +
      `- Unblocked only: \`WHERE(Blocked=CONST( ))\`\n\n` +
      `To limit fields returned, pass a \`fieldNumbers\` array (e.g. \`[1,2,5,8,23,35]\` for No., Name, Address, Phone, Contact, Country).\n\n` +
      `**All Customer fields in this BC instance:**\n${data.markdown}`;
  } else if (promptName === "item_lookup_pattern") {
    const data = await toolGetTableFields({ table: "Item", format: "markdown" });
    text = `## Item Lookup Pattern\n\n` +
      `Company: **${data.company}**\n\n` +
      `Use \`Data.Records.Get\` with \`tableName: "Item"\`.\n\n` +
      `**tableView filter examples:**\n` +
      `- By No. (exact): \`WHERE(No.=FILTER(70000))\`\n` +
      `- By description (wildcard): \`WHERE(Description=FILTER(*chair*))\`\n` +
      `- Either: \`WHERE(No.=FILTER(7*)|Description=FILTER(*chair*))\`\n` +
      `- In stock only: \`WHERE(Inventory=FILTER(>0))\`\n\n` +
      `To limit fields returned, pass \`fieldNumbers\` (e.g. \`[1,3,8,18,21,54]\` for No., Description, Base Unit of Measure, Unit Price, Inventory, Blocked).\n\n` +
      `**All Item fields in this BC instance:**\n${data.markdown}`;
  } else {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown prompt: ${promptName}` } };
  }
  return {
    jsonrpc: "2.0", id,
    result: { messages: [{ role: "user", content: { type: "text", text } }] },
  };
}
```

**Update `initialize` response:**
```js
capabilities: { tools: {}, resources: {}, prompts: {} },
```

---

### 11a. Optional API key authentication
**Status:** ❌ Not Implemented  
**Priority:** 🟢 Low  
**File:** `api/mcp/index.js` — Azure Function entry point (top of `module.exports`)

**Description:** When `MCP_API_KEY` env var is set, all requests must include `Authorization: Bearer {key}`. If the env var is absent the server remains open (current behaviour). The check runs before JSON-RPC parsing so unauthenticated clients never reach tool logic.

**Implementation — add near the top of `module.exports`:**
```js
// Optional bearer-token auth
const requiredKey = process.env.MCP_API_KEY;
if (requiredKey) {
  const authHeader = req.headers["authorization"] || "";
  const provided   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (provided !== requiredKey) {
    context.res = {
      status:  401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
      body:    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Unauthorized" } }),
    };
    return;
  }
}
```

**Azure Function application setting:**
```
MCP_API_KEY = <a-random-secret-token>
```

---

### 11b. Table parameter input validation
**Status:** ✅ Implemented  
**Priority:** 🔴 High  
**File:** `api/mcp/index.js`

**Description:** The `table` parameter is embedded into Cloud Event `subject` and `data.tableName` fields. Malicious input containing JSON control characters, braces, or quotes could corrupt the envelope body. Add a validation helper called before every `bcTask` that takes a table name.

**Implementation — add helper function:**
```js
const TABLE_NAME_RE = /^[\w\s.\-]{1,80}$/;

function validateTableName(table) {
  if (!TABLE_NAME_RE.test(String(table))) {
    throw new Error(
      `Invalid table name '${table}'. Table names must be 1–80 characters and contain only ` +
      `letters, digits, spaces, dots, underscores, or hyphens.`
    );
  }
}
```

**Call site — add at the start of each tool that accepts a `table` param:**
```js
// In toolGetTableInfo, toolGetTableFields, toolGetRecords:
validateTableName(table);
```

---

### 11c. Take / skip upper bound enforcement
**Status:** ✅ Implemented  
**Priority:** 🔴 High  
**File:** `api/mcp/index.js` — each relevant tool function

**Description:** LLM clients can pass arbitrary integers. Without server-side caps a client could request thousands of records and exhaust memory or hit BC timeouts.

**Implementation — add to each tool:**
```js
// toolGetRecords
take = Math.min(Number(take) || 50, 200);
skip = Math.max(Number(skip) || 0, 0);

// toolListTables
take = Math.min(Number(take) || 200, 500);
skip = Math.max(Number(skip) || 0, 0);

// toolSearchCustomers / toolSearchItems
take = Math.min(Number(take) || 10, 50);
```

---

### 12. Token and company cache hardening
**Status:** ❌ Not Implemented  
**Priority:** 🟢 Low  
**File:** `api/mcp/index.js` — module-level cache variables and `getCompany()`

**Problem:** The cached `_companyId` was resolved against a specific `BC_TENANT_ID` + `BC_ENVIRONMENT` combination. If those env vars change between warm invocations (e.g. slot swap), the cached company GUID is stale.

**Implementation — add cache key tracking:**
```js
// Module-level — replace the existing two variables with:
let _companyId        = null;
let _companyName      = null;
let _companyCacheKey  = "";   // invalidate if env vars change

async function getCompany() {
  const cacheKey = `${process.env.BC_TENANT_ID}|${process.env.BC_ENVIRONMENT || "production"}|${process.env.BC_COMPANY_ID || ""}`;
  if (_companyId && _companyCacheKey === cacheKey) return { id: _companyId, name: _companyName };

  // ... existing resolution logic ...

  _companyCacheKey = cacheKey;
  _companyId       = company.id;
  _companyName     = company.name;
  return { id: _companyId, name: _companyName };
}
```

---

### 13. Well-known discovery document improvements
**Status:** ❌ Not Implemented  
**Priority:** 🟢 Low  
**File:** `.well-known/mcp.json`

**Description:** The current discovery document only lists the endpoint. Expand it to include the full tool list, authentication note, and the planned additions so MCP-aware clients can present accurate capability information.

**Replace `/.well-known/mcp.json` with:**
```jsonc
{
  "mcpVersion": "2024-11-05",
  "name": "BC Metadata MCP Server",
  "description": "Exposes Business Central table metadata, field definitions, Cloud Event message types, and live data records via the Cloud Events API.",
  "endpoint": "https://dynamics.is/api/mcp",
  "transport": "http",
  "authentication": {
    "type": "bearer",
    "required": false,
    "note": "Include 'Authorization: Bearer {key}' if the server is configured with MCP_API_KEY."
  },
  "tools": [
    "list_tables",
    "get_table_info",
    "get_table_fields",
    "list_companies",
    "list_message_types",
    "get_records",
    "search_customers",
    "search_items",
    "list_translations",
    "set_translations"
  ],
  "prompts": [
    "describe_table",
    "find_tables_for_entity",
    "data_model_overview",
    "sales_order_creation_workflow",
    "customer_lookup_pattern",
    "item_lookup_pattern"
  ]
}
```

---

### 14. Translation tools: `list_translations` and `set_translations`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Background:** Business Central stores UI translations in a table called **Cloud Event Translation**
with a three-field primary key:

| Primary key field | Value |
|---|---|
| `Source` | Application name that owns the string (e.g. `"BC Portal"`) |
| `WindowsLanguageID` | LCID as a string (e.g. `"1039"` for Icelandic) |
| `SourceText` | The English source string |

A single non-key field `TargetText` holds the translation. Records with a blank `TargetText`
are placeholder rows that exist in BC but have not been translated yet.

---

#### `list_translations`

**Description:** Returns all translation records for a given source application and language.
Pass `missingOnly: true` to return only records where `TargetText` is blank — the rows an AI
assistant should fill in.

**Implementation — add tool function:**
```js
async function toolListTranslations({ source, lcid, missingOnly = false } = {}) {
  if (!source) throw new Error("Parameter 'source' is required");
  if (!lcid)   throw new Error("Parameter 'lcid' is required");

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const tableView = `WHERE(Windows Language ID=CONST(${Number(lcid)}),Source=CONST(${source}))`;
  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     "Cloud Event Translation",
    data:        JSON.stringify({ tableView, take: 500 }),
  });

  let records = (result.result || []).map(r => ({
    sourceText: (r.primaryKey || {}).SourceText || "",
    targetText: (r.fields    || {}).TargetText  || "",
  }));

  if (missingOnly) records = records.filter(r => !r.targetText.trim());

  return {
    company:     company.name,
    source,
    lcid:        Number(lcid),
    total:       records.length,
    missing:     records.filter(r => !r.targetText.trim()).length,
    translations: records,
  };
}
```

**Add to `TOOLS` array:**
```js
{
  name:        "list_translations",
  description: "Lists Cloud Event Translation records for a given source application and language LCID. Pass missingOnly=true to return only untranslated (blank) entries.",
  inputSchema: {
    type:       "object",
    properties: {
      source:      { type: "string",  description: "Translation source name (e.g. 'BC Portal')." },
      lcid:        { type: "integer", description: "Windows Language ID / LCID (e.g. 1039 for Icelandic, 1030 for Danish)." },
      missingOnly: { type: "boolean", description: "When true, returns only records where TargetText is blank (default false)." },
    },
    required: ["source", "lcid"],
  },
},
```

**Returns:**
```jsonc
{
  "company": "CRONUS",
  "source": "BC Portal",
  "lcid": 1039,
  "total": 42,
  "missing": 5,
  "translations": [
    { "sourceText": "Customers",  "targetText": "Viðskiptamenn" },
    { "sourceText": "Loading...", "targetText": "" }
  ]
}
```

---

#### `set_translations`

**Description:** Creates or updates translation records in the Cloud Event Translation table.
Each item in the `translations` array is an `{sourceText, targetText}` pair. Uses
`Data.Records.Set` with the full primary key — BC treats this as an upsert: insert if the
record does not exist, modify if it does.

**Implementation — add tool function:**
```js
async function toolSetTranslations({ source, lcid, translations } = {}) {
  if (!source)       throw new Error("Parameter 'source' is required");
  if (!lcid)         throw new Error("Parameter 'lcid' is required");
  if (!Array.isArray(translations) || !translations.length)
    throw new Error("Parameter 'translations' must be a non-empty array");

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const data = translations.map(t => ({
    primaryKey: {
      Source:            source,
      WindowsLanguageID: String(Number(lcid)),
      SourceText:        String(t.sourceText),
    },
    fields: { TargetText: String(t.targetText || "") },
  }));

  await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     "Cloud Event Translation",
    data:        JSON.stringify({ data }),
  });

  return { company: company.name, source, lcid: Number(lcid), written: translations.length };
}
```

**Add to `TOOLS` array:**
```js
{
  name:        "set_translations",
  description: "Creates or updates Cloud Event Translation records. Each item is a {sourceText, targetText} pair. Uses upsert semantics — inserts new rows and updates existing ones.",
  inputSchema: {
    type:       "object",
    properties: {
      source:       { type: "string",  description: "Translation source name (e.g. 'BC Portal')." },
      lcid:         { type: "integer", description: "Windows Language ID / LCID." },
      translations: {
        type:  "array",
        items: {
          type:       "object",
          properties: {
            sourceText: { type: "string", description: "The English source string." },
            targetText: { type: "string", description: "The translated string." },
          },
          required: ["sourceText", "targetText"],
        },
        description: "Array of translation pairs to write.",
      },
    },
    required: ["source", "lcid", "translations"],
  },
},
```

**Add to `tools/call` switch:**
```js
case "list_translations": content = await toolListTranslations(args); break;
case "set_translations":  content = await toolSetTranslations(args);  break;
```

**Returns:**
```jsonc
{ "company": "CRONUS", "source": "BC Portal", "lcid": 1039, "written": 5 }
```

**Typical AI workflow:**
1. Call `list_translations({ source: "BC Portal", lcid: 1039, missingOnly: true })` to get untranslated strings
2. Translate each `sourceText` into the target language
3. Call `set_translations({ source: "BC Portal", lcid: 1039, translations: [{sourceText, targetText}, ...] })` to write them back

---

## Implementation Order (recommended)

| Priority | Item | Effort |
|---|---|---|
| 🔴 High | §11b — table name validation | < 30 min |
| 🔴 High | §11c — take/skip upper bounds | < 30 min |
| 🔴 High | §1 — BC_COMPANY_ID / BC_COMPANY_NAME env vars | ~1 h |
| 🟡 Medium | §2 — `list_companies` tool | ~30 min |
| 🟡 Medium | §3 — `list_message_types` tool | ~1 h |
| 🟡 Medium | §4 — `get_records` tool | ~2 h |
| 🟡 Medium | §5 — `search_customers` tool | ~1 h |
| 🟡 Medium | §6 — `search_items` tool | ~30 min |
| 🟡 Medium | §7 — filter/paging on `list_tables` | ~30 min |
| 🟢 Low | §8 — markdown output format | ~1 h |
| 🟢 Low | §9 — MCP Resources | ~2 h |
| 🟢 Low | §10 — MCP Prompts (`describe_table`, `find_tables_for_entity`, `data_model_overview`, `sales_order_creation_workflow`, `customer_lookup_pattern`, `item_lookup_pattern`, `implement_message_type`) | ~2 h |
| 🟡 Medium | §14 — translation tools (`list_translations`, `set_translations`) | ~1 h |
| 🟡 Medium | §15 — `get_message_type_help` tool + `implement_message_type` prompt | ~1 h |
| 🟡 Medium | §16 — `set_records` tool — generic table write | ~1 h |
| 🟡 Medium | §17 — `call_message_type` tool — generic Cloud Event caller | ~30 min |
| ✅ Done | §18 — `x-encrypted-conn` header — workspace-level encrypted credentials | Done |
| ✅ Done | §19 — `set_config` / `get_config` — BC-hosted JSON config via Cloud Events Storage | Done |
| ✅ Done | §20 — `get_next_line_no` tool — next available Line No. via Help.NextLineNo.Get | Done |
| ✅ Done | §21 — `batch_records` tool — multi-table parallel read | Done |
| ✅ Done | §22 — `get_document_lines` tool — convenience document line reader | Done |
| ✅ Done | §23 — Enhanced `get_decimal_total` — multi-field support | Done |
| ✅ Done | §24 — `vendor_lookup_pattern` prompt | Done |
| ✅ Done | §24b — `gl_account_lookup_pattern` prompt | Done |
| ✅ Done | §24c — `bank_account_lookup_pattern` prompt | Done |
| ✅ Done | §24d — `resource_lookup_pattern` prompt | Done |
| ✅ Done | §24e — `employee_lookup_pattern` prompt | Done |
| ✅ Done | §25 — `purchase_order_creation_workflow` prompt | Done |
| ✅ Done | §26 — `general_journal_creation_workflow` prompt | Done |
| ✅ Done | §27 — Resource templates for `bc://tables/{name}` and `bc://message-types/{name}` | Done |
| ✅ Done | §28 — Multi-field search engine + 7 new search tools (Tier 1 + Tier 2) | Done |

---

### 18. Workspace-level encrypted connection via `x-encrypted-conn` header
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**Files:** `api/mcp/index.js`, `.vscode/mcp.json`

**Background:**  
All MCP tools accept per-call credential parameters (`tenantId`, `clientId`, `clientSecret`, `environment`). Typing these on every call is impractical. This feature lets you encrypt the credentials once into a single Base64 ciphertext and store it in the MCP client configuration. The server reads the ciphertext from the `x-encrypted-conn` HTTP request header and automatically injects it as the `encryptedConn` default for every tool call in that session.

---

#### Prerequisites

`MCP_ENCRYPTION_KEY` must be set as an Azure Function application setting — a 64-character hex string (32 bytes, AES-256-GCM key).

Generate a cryptographically strong key in PowerShell:
```powershell
[System.BitConverter]::ToString(
  [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).Replace('-','').ToLower()
```
Paste the output as the value of `MCP_ENCRYPTION_KEY` in the Azure Function → Configuration → Application settings.

---

#### Step 1 — Encrypt your connection JSON

Build a JSON object with your BC credentials:
```json
{
  "tenantId": "<Entra tenant GUID>",
  "clientId": "<app registration client ID>",
  "clientSecret": "<client secret>",
  "environment": "production"
}
```

Send it to the `encrypt_data` tool:
```powershell
$conn = '{"tenantId":"<guid>","clientId":"<guid>","clientSecret":"<secret>","environment":"production"}'

$body = @{
  jsonrpc = "2.0"; id = 1; method = "tools/call"
  params  = @{ name = "encrypt_data"; arguments = @{ plaintext = $conn } }
} | ConvertTo-Json -Depth 5 -Compress

$ciphertext = (Invoke-RestMethod -Uri "https://dynamics.is/api/mcp" `
  -Method POST -ContentType "application/json" -Body $body
).result.content[0].text | ConvertFrom-Json | Select-Object -ExpandProperty ciphertext

$ciphertext   # copy this value
```

The returned ciphertext is a Base64 string, for example:
```
YY4Kg63+WJFy4IAiks3SVk5FC7dxMKW0hGWwzVJ...
```

The plaintext credentials are never stored — only the encrypted blob.

---

#### Step 2 — Store the ciphertext in `.vscode/mcp.json`

Edit `.vscode/mcp.json` to add a `headers` block:
```json
{
  "servers": {
    "bc-metadata": {
      "type": "http",
      "url": "https://dynamics.is/api/mcp",
      "headers": {
        "x-encrypted-conn": "<paste ciphertext here>"
      }
    }
  }
}
```

This header is sent automatically by VS Code / GitHub Copilot on every MCP request. Other clients (Claude Desktop, Cursor) support the same `headers` configuration key.

---

#### How the server handles the header

1. The Azure Function reads `req.headers["x-encrypted-conn"]`.
2. For every `tools/call` request, if `args.encryptedConn` is **not** already set by the caller, the header value is injected as the default.
3. `resolveConn()` decrypts the blob via AES-256-GCM using `MCP_ENCRYPTION_KEY`, parses the resulting JSON, and fills in `tenantId`, `clientId`, `clientSecret`, `environment`.
4. Explicit per-call parameters always override the header — so a caller can still target a different tenant by passing `tenantId` / `clientSecret` directly.

**Priority order (highest to lowest):**
```
explicit argument param  >  encryptedConn arg  >  x-encrypted-conn header  >  server env var
```

---

#### Server implementation details

**`resolveConn()` — credential resolution function:**
```js
function resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (encryptedConn) {
    const parsed = JSON.parse(toolDecryptData({ ciphertext: String(encryptedConn) }).plaintext);
    tenantId     = tenantId     || parsed.tenantId;
    clientId     = clientId     || parsed.clientId;
    clientSecret = clientSecret || parsed.clientSecret;
    environment  = environment  || parsed.environment;
  }
  return {
    tenantId:     tenantId     || process.env.BC_TENANT_ID,
    clientId:     clientId     || process.env.BC_CLIENT_ID,
    clientSecret: clientSecret || process.env.BC_CLIENT_SECRET,
    environment:  environment  || process.env.BC_ENVIRONMENT || "production",
  };
}
```

**Header injection in Azure Function entry point (`module.exports`):**
```js
// Read per-workspace encrypted connection from the x-encrypted-conn header
const headerEncryptedConn = req.headers["x-encrypted-conn"] || "";
```

**Injection into `tools/call` dispatcher:**
```js
case "tools/call": {
  const toolName = (params || {}).name;
  const args     = (params || {}).arguments || {};
  // Inject header value as workspace-level default (per-call arg takes priority)
  if (headerEncryptedConn && !args.encryptedConn) args.encryptedConn = headerEncryptedConn;
  // ...
}
```

---

### 19. BC-hosted JSON config — `set_config` / `get_config`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**Files:** `api/mcp/index.js`

**Background:**  
Persistent configuration objects (connection strings, feature flags, user preferences, cached data, etc.) can be stored server-side in the `Cloud Events Storage` table in BC. The table has a two-field primary key (`Source` Text + `Id` GUID/Text) and a BLOB `Data` field. The tools handle the necessary Base64 encoding/decoding transparently and can optionally apply AES-256-GCM encryption via the server-side `MCP_ENCRYPTION_KEY`.

---

#### `set_config` — Upsert a config record

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source` | string | ✅ | Logical namespace / app name, e.g. `"BC Portal"` |
| `id` | string | ✅ | Record identifier — any string or GUID |
| `data` | any | ✅ | JSON object or plain string to persist |
| `encrypt` | boolean | — | Encrypt with server-side key before storing (default `false`) |

Returns `{ company, source, id, encrypted, written: 1 }`.

The `data` argument is JSON-serialised if it is not already a string, then optionally encrypted, then Base64-encoded before being stored in the BLOB field. Upsert semantics: inserts a new row or replaces an existing one.

#### `get_config` — Read a config record

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source` | string | ✅ | Logical namespace / app name |
| `id` | string | ✅ | Record identifier |
| `decrypt` | boolean | — | Decrypt the stored value (default `false`) |

Returns `{ company, source, id, found: true, encrypted, data }` when the record exists, or `{ …, found: false }` when it does not.

The BLOB is Base64-decoded, optionally decrypted, then JSON-parsed. If parsing fails the raw string is returned as `data`.

---

#### Internal design

```js
const CS_TABLE = "Cloud Events Storage";

async function toolSetConfig({ source, id, data, encrypt = false, ... }) {
  let dataString = typeof data === "string" ? data : JSON.stringify(data);
  if (encrypt) dataString = toolEncryptData({ plaintext: dataString }).ciphertext;
  const blobValue = Buffer.from(dataString).toString("base64");

  await bcTask(conn, company.id, {
    type:    "Data.Records.Set",
    subject: CS_TABLE,
    data:    JSON.stringify({
      mode: "upsert",
      data: [{ primaryKey: { Source: source, Id: id }, fields: { Data: blobValue } }],
    }),
  });
}

async function toolGetConfig({ source, id, decrypt = false, ... }) {
  const result  = await bcTask(conn, company.id, { type: "Data.Records.Get", ... });
  const records = result.result || [];
  if (!records.length) return { found: false };
  let rawString = Buffer.from(records[0].fields.Data, "base64").toString("utf8");
  if (decrypt) rawString = toolDecryptData({ ciphertext: rawString }).plaintext;
  return { found: true, data: JSON.parse(rawString) };
}
```

#### End-to-end encrypted config example

```powershell
# Write encrypted config
$body = @{
  jsonrpc = "2.0"; id = 1; method = "tools/call"
  params  = @{
    name      = "set_config"
    arguments = @{
      source  = "BC Portal"
      id      = "connection-settings"
      data    = @{ apiUrl = "https://example.com"; timeout = 30 }
      encrypt = $true
    }
  }
} | ConvertTo-Json -Depth 10 -Compress
Invoke-WebRequest -Uri "https://dynamics.is/api/mcp" -Method POST `
  -ContentType "application/json" -Body $body -UseBasicParsing

# Read and decrypt
$body = @{
  jsonrpc = "2.0"; id = 1; method = "tools/call"
  params  = @{
    name      = "get_config"
    arguments = @{ source = "BC Portal"; id = "connection-settings"; decrypt = $true }
  }
} | ConvertTo-Json -Depth 10 -Compress
Invoke-WebRequest -Uri "https://dynamics.is/api/mcp" -Method POST `
  -ContentType "application/json" -Body $body -UseBasicParsing
```

**CORS — `x-encrypted-conn` is allowed:**
```js
"Access-Control-Allow-Headers": "Content-Type, x-encrypted-conn"
```

---

#### Ciphertext format

The ciphertext produced by `encrypt_data` is a single Base64 string encoding:
```
base64( iv[12 bytes] | authTag[16 bytes] | ciphertext[n bytes] )
```

- **AES-256-GCM** — authenticated encryption; any tampering causes decryption to fail with an error
- **Unique IV per call** — encrypting the same plaintext twice produces different ciphertexts
- **Key** — `MCP_ENCRYPTION_KEY` (64 hex chars = 32 bytes), stored only on the server

---

#### Rotating the ciphertext

If credentials change (secret rotation, new app registration), generate a new ciphertext and update `.vscode/mcp.json`:
1. Re-run the `encrypt_data` PowerShell snippet (Step 1) with the new credentials.
2. Paste the new ciphertext into `.vscode/mcp.json` → `headers.x-encrypted-conn`.

To rotate the encryption key itself, set a new `MCP_ENCRYPTION_KEY` in Azure Function settings and re-encrypt all stored blobs.

---

#### Security notes

- The ciphertext is safe to store in a repository — without the server-side key it is opaque.
- The key (`MCP_ENCRYPTION_KEY`) must never be committed to the repository; it lives only in Azure Function application settings.
- If `.vscode/mcp.json` is in `.gitignore` and contains real credentials as plaintext, move them to this encrypted form so the file can be committed safely.
- GCM authentication guarantees integrity: a truncated, flipped, or forged ciphertext is rejected before any BC call is made.

---

### 17. New Tool: `call_message_type`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Generic caller that can invoke **any** Cloud Event message type supported by the BC environment. The agent should first call `list_message_types` to discover available types and `get_message_type_help` to understand the required request shape and interpret the response — then use this tool to execute the call.

This makes the MCP server self-describing: new message types added to BC are immediately callable without any server-side changes.

**AI workflow:**
1. `list_message_types` — discover available types
2. `get_message_type_help({ type })` — read request schema, required fields, response format
3. `call_message_type({ type, subject, data })` — execute the call with the correct parameters
4. Interpret the response using the knowledge from step 2

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | Message type name (e.g. `'Sales.Order.Statistics'`, `'Customer.Create'`) |
| `subject` | string | — | Cloud Event subject — typically the document/customer/item number. See `get_message_type_help` for what each type uses. |
| `data` | object | — | Optional data payload as a JSON object. Structure varies by message type. |
| `lcid` | integer | — | Language LCID (default 1033 = English) |
| `companyId` | string | — | Target company GUID or name (defaults to server default) |

**Implementation:**
```js
async function toolCallMessageType({ type, subject, data, lcid = 1033, companyId } = {}) {
  // Builds Cloud Event envelope from params
  // Sends via bcTask()
  // Returns { company, type, result }
}
```

**Example — call Sales.Order.Statistics:**
```jsonc
// 1. Discover
{ "name": "list_message_types", "arguments": {} }

// 2. Read schema
{ "name": "get_message_type_help", "arguments": { "type": "Sales.Order.Statistics" } }

// 3. Execute
{ "name": "call_message_type", "arguments": { "type": "Sales.Order.Statistics", "subject": "101016" } }
```

**Returns:**
```jsonc
{
  "company": "CRONUS IS",
  "type": "Sales.Order.Statistics",
  "result": {
    "status": "Success",
    "orderNo": "101016",
    "order": { "totalInclVAT": 699790, ... }
  }
}
```

---

### 16. New Tool: `set_records`  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Writes records to any Business Central table via `Data.Records.Set`. Supports four modes: `insert`, `modify`, `delete`, and `upsert` (default). Each record in the `data` array must supply a `primaryKey` object (the BC primary-key fields) and a `fields` object (non-key fields to write — not required for `delete`). The table name is validated with `validateTableName()` before the BC call. Returns the written record count and any result records BC sends back.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `table` | string | ✅ | BC table name (e.g. `'Customer'`, `'Sales Header'`) |
| `mode` | string | — | `"insert"` \| `"modify"` \| `"delete"` \| `"upsert"` (default) |
| `data` | array | ✅ | Array of `{ primaryKey, fields }` objects |

**Example — upsert a customer:**
```jsonc
{
  "table": "Customer",
  "data": [{
    "primaryKey": { "No.": "C99999" },
    "fields": { "Name": "Test Corp", "Address": "123 Main St", "Country/Region Code": "IS" }
  }]
}
```

**Returns:**
```jsonc
{ "company": "CRONUS IS", "table": "Customer", "mode": "upsert", "written": 1, "records": [...] }
```

---

### 15. New Tool: `get_message_type_help` + Prompt: `implement_message_type`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Fetches the full implementation guide for a specific Cloud Event message type via `Help.Implementation.Get`. The BC server returns markdown documentation for the message type containing the JSON schema, required fields, examples, and business rules needed to implement it. Combined with `implement_message_type` prompt that bundles the guide with the full type catalogue.

**Tool: `get_message_type_help`**
```js
async function toolGetMessageTypeHelp({ type, lcid = 1033 } = {}) {
  // calls Help.Implementation.Get with subject = message type name
  // returns { company, type, markdown }
}
```

**Input parameters:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | Message type name (e.g. `'Customer.Create'`) |
| `lcid` | integer | — | Language LCID (default 1033) |

**Resource:** `bc://message-types/{name}` — reads the help markdown for a given type.

**Prompt: `implement_message_type`**

Arguments: `type` (required), `lcid` (optional). Fetches `Help.Implementation.Get` for the given type and `Help.MessageTypes.Get` for the full catalogue in parallel, then composes a ready-to-use context block:

```
## Implementation Guide: Customer.Create

**Company:** CRONUS IS

---

{full markdown help from Help.Implementation.Get}

---

## All available message types in this BC instance

- **Customer.Create** (Inbound) — Creates a new customer
- …
```

This gives an AI assistant everything it needs to implement the message type without any further BC lookups.

---

### 20. New Tool: `get_next_line_no` — Next available Line No.
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Returns the next available Line No. for a BC table that uses an integer last primary key field (e.g. Sales Line, Purchase Line, Gen. Journal Line). Wraps the `Help.NextLineNo.Get` Cloud Event message type. The `increment` parameter controls the step size between line numbers (default 10000, matching BC standard).

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `table` | string | ✅ | BC table name (e.g. `'Sales Line'`, `'Purchase Line'`, `'Gen. Journal Line'`) |
| `primaryKey` | object | — | Partial primary key values to scope the line number (e.g. `{"Document Type": "Order", "Document No.": "S-ORD101001"}`) |
| `id` | string | — | Record GUID (SystemId) — alternative to primaryKey for scoping |
| `increment` | integer | — | Step size for Line No. (default 10000) |

**Returns:**
```jsonc
{
  "company": "CRONUS IS",
  "table": "Sales Line",
  "primaryKey": { "Document Type": "Order", "Document No.": "S-ORD101001" },
  "id": null,
  "increment": 10000,
  "nextLineNo": 40000
}
```

**AI workflow for creating document lines:**
1. `get_next_line_no({ table: "Sales Line", primaryKey: { "Document Type": "Order", "Document No.": "S-ORD101001" } })` → `nextLineNo: 40000`
2. Use 40000 as `lineNo` for a new `Data.Records.Set` call on Sales Line

---

### 21. New Tool: `batch_records` — Multi-table parallel read
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Reads records from multiple Business Central tables in a single call. Each request in the array specifies its own table, filter, and field selection. All requests execute in parallel against BC, reducing round trips. Max 10 requests per batch. Errors on individual requests are captured (not thrown) so other requests still succeed.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `requests` | array | ✅ | Array of record-read requests (max 10) |
| `requests[].table` | string | ✅ | BC table name |
| `requests[].filter` | string | — | BC tableView filter |
| `requests[].fieldNumbers` | integer[] | — | Field numbers to return |
| `requests[].take` | integer | — | Max records (default 50, max 200) |

**Returns:**
```jsonc
{
  "company": "CRONUS IS",
  "results": [
    { "table": "Customer", "count": 5, "records": [...] },
    { "table": "Item", "count": 10, "records": [...] },
    { "table": "Bad Table", "error": "Invalid table name..." }
  ]
}
```

**Use case:** An AI assistant collecting context for a sales order can fetch customers, items, and sales header data in a single round trip instead of three sequential `get_records` calls.

---

### 22. New Tool: `get_document_lines` — Convenience document line reader
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Convenience tool that reads document lines for a given document number. Automatically resolves the correct line table (Sales Line / Purchase Line) and applies Document Type + Document No. filters. Supports field selection, format (JSON or markdown), and language LCID for field name resolution. Delegates to `get_records` internally.

**Supported document types:**

| documentType | Resolved table | Document Type filter |
|---|---|---|
| `sales order` | Sales Line | Order |
| `sales invoice` | Sales Line | Invoice |
| `sales quote` | Sales Line | Quote |
| `sales credit memo` | Sales Line | Credit Memo |
| `purchase order` | Purchase Line | Order |
| `purchase invoice` | Purchase Line | Invoice |
| `purchase quote` | Purchase Line | Quote |
| `purchase credit memo` | Purchase Line | Credit Memo |

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `documentNo` | string | ✅ | Document number |
| `documentType` | string | — | Document type (see table above). Not needed if `table` is provided. |
| `table` | string | — | Explicit line table name — overrides documentType. |
| `fields` | integer[] | — | Field numbers to return |
| `take` | integer | — | Max lines (default 200) |
| `lcid` | integer | — | Language LCID (default 1033) |
| `format` | string | — | `"json"` (default) or `"markdown"` |

**Returns:** Same shape as `get_records`.

---

### 23. Enhanced `get_decimal_total` — Multi-field support
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** The `get_decimal_total` tool now accepts an optional `decimalFields` array parameter in addition to the existing `decimalField` string. When `decimalFields` is provided, all specified fields are totalled in a single call using `Data.Totals.Get` with a `fieldNumbers` array. This halves round trips when an AI assistant needs sums for multiple fields (e.g. Amount + "Amount Including VAT").

**Changes:**
- New optional parameter: `decimalFields` (array of strings — field names or numbers)
- `decimalField` remains supported for backwards compatibility
- Either `decimalField` or `decimalFields` must be provided (not both)
- `table` is now the only required parameter

**Multi-field response shape:**
```jsonc
{
  "company": "CRONUS IS",
  "table": "G/L Entry",
  "decimalFields": ["Amount", "Debit Amount"],
  "filter": "WHERE(Posting Date=FILTER(>=2026-01-01))",
  "totals": { "Amount": 1234567.89, "Debit Amount": 9876543.21 }
}
```

**Single-field response (unchanged):**
```jsonc
{ "company": "CRONUS IS", "table": "G/L Entry", "decimalField": "Amount", "filter": null, "total": 1234567.89 }
```

---

### 24. New Prompt: `vendor_lookup_pattern`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Analogous to `customer_lookup_pattern` but for the Vendor table. Returns a vendor lookup guide with tableView filter examples and the complete live Vendor field table for the connected BC instance. No parameters required.

---

### 24b. New Prompt: `gl_account_lookup_pattern`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** G/L Account lookup guide with filter examples for No. ranges, Income/Balance classification, Account Type (Posting vs Heading/Total), and Blocked status. Returns the complete live G/L Account field table.

---

### 24c. New Prompt: `bank_account_lookup_pattern`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Bank Account lookup guide with filter examples for No., Name, Currency Code, and Blocked status. Returns the complete live Bank Account field table.

---

### 24d. New Prompt: `resource_lookup_pattern`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Resource lookup guide with filter examples for No., Name, Type (Person/Machine), and Blocked status. Returns the complete live Resource field table.

---

### 24e. New Prompt: `employee_lookup_pattern`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Employee lookup guide with filter examples for No., First Name, Last Name, Status (Active/Inactive), and Department Code. Returns the complete live Employee field table.

---

### 25. New Prompt: `purchase_order_creation_workflow`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Analogous to `sales_order_creation_workflow` but for purchase orders. Fetches Purchase Header and Purchase Line field schemas in parallel and returns a 3-step creation recipe. References `get_next_line_no` tool for determining line numbers on existing orders.

**Arguments:** `lcid` (optional, default 1033)

---

### 26. New Prompt: `general_journal_creation_workflow`
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Returns a step-by-step guide for creating general journal lines in BC. Fetches the Gen. Journal Line field schema and explains template/batch scoping, balanced entries, and the validate → post workflow using `check_general_journal` and `post_general_journal` tools.

**Arguments:** `lcid` (optional, default 1033)

---

### 27. Resource Templates: `bc://tables/{tableName}` and `bc://message-types/{typeName}`
**Status:** ✅ Implemented  
**Priority:** 🟢 Low  
**File:** `api/mcp/index.js`

**Description:** The `resources/list` response now includes `resourceTemplates` in addition to static resources. This exposes the parametric resources `bc://tables/{tableName}` and `bc://message-types/{typeName}` that were already handled by `resources/read` but were not discoverable by MCP clients.

**Updated resources/list response:**
```jsonc
{
  "resources": [
    { "uri": "bc://companies", "name": "Companies", "mimeType": "application/json" },
    { "uri": "bc://message-types", "name": "Message Types", "mimeType": "application/json" },
    { "uri": "bc://tables", "name": "Tables", "mimeType": "application/json" }
  ],
  "resourceTemplates": [
    { "uriTemplate": "bc://tables/{tableName}", "name": "Table Fields", "mimeType": "application/json" },
    { "uriTemplate": "bc://message-types/{typeName}", "name": "Message Type Help", "mimeType": "application/json" }
  ]
}
```

---

### 28. Multi-field search engine and 7 new search tools
**Status:** ✅ Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Shared `multiFieldSearch` engine function inspired by the employee phonebook pattern. Searches N fields in parallel using `Data.RecordIds.Get`, deduplicates SystemIds (capped at 100), then fetches full records in a single `Data.Records.Get` call. BC filter special characters in the query are escaped to `?` wildcards.

**Shared engine: `multiFieldSearch()`**
```
Parameters:
  tableName    — BC table to search
  query        — user search string
  searchFields — array of BC field names to search in parallel
  fieldNumbers — optional array of field numbers for the final record fetch
  baseFilter   — optional extra WHERE clause (e.g. "Status=CONST(Active)")
  conn         — resolved connection
  companyId    — target company

Flow:
  1. escapeBcFilter(query) → replace *|&<>='"\()@ with ?
  2. For each searchField, fire Data.RecordIds.Get with WHERE({field}=FILTER(@*escaped*))
  3. Promise.all() — all requests run in parallel
  4. Collect SystemIds into a Set (dedup), stop at 100
  5. Single Data.Records.Get with WHERE(System Id=FILTER(id1|id2|...))
  6. Return records array
```

#### Tier 1 tools (high-value master data)

| Tool | Table | Search fields | Default take |
|------|-------|---------------|-------------|
| `search_customers` | Customer | No., Name, Address, Post Code, City, Registration No., Contact, Phone No., E-Mail | 50 |
| `search_items` | Item | No., Description, Description 2, Vendor Item No., Base Unit of Measure, Item Category Code | 50 |
| `search_vendors` | Vendor | No., Name, Address, Post Code, City, Phone No., Contact, VAT Registration No. | 50 |
| `search_contacts` | Contact | No., Name, Company Name, Phone No., Mobile Phone No., E-Mail, City, Post Code | 50 |
| `search_employees` | Employee | First Name, Middle Name, Last Name, Job Title, Phone No., Mobile Phone No., E-Mail, Company E-Mail | 50 |

> `search_employees` adds `baseFilter: "Status=CONST(Active)"` so only active employees are searched.

#### Tier 2 tools (commonly looked up)

| Tool | Table | Search fields | Default take |
|------|-------|---------------|-------------|
| `search_gl_accounts` | G/L Account | No., Name, Search Name, Account Category | 50 |
| `search_bank_accounts` | Bank Account | No., Name, Bank Account No., IBAN, Bank Branch No. | 50 |
| `search_resources` | Resource | No., Name, Type, Resource Group No., Base Unit of Measure | 50 |
| `search_fixed_assets` | Fixed Asset | No., Description, Serial No., FA Class Code, FA Subclass Code, FA Location Code | 50 |

#### Enhanced `search_records` — generic multi-field search

The generic `search_records` tool now supports a `searchFields` array parameter. When provided, it uses the `multiFieldSearch` engine instead of the legacy 2-field approach. The old `nameField`/`codeField` parameters still work as a fallback.

**New parameters:**
- `searchFields` (array of strings) — field names to search in parallel (preferred)
- `nameField` (string) — legacy: single field for substring match
- `codeField` (string) — legacy: optional prefix field
- `table` and `query` are always required; `nameField` is only required in legacy mode

**ID cap:** All multi-field search tools cap unique SystemIds at 100 to avoid oversized filter strings.

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
- [ ] `search_customers` with "Adatum" returns matching customers (multi-field)
- [ ] `search_customers` with partial address returns matches
- [ ] `search_items` with "bicycle" returns matching items (multi-field)
- [ ] `search_vendors` with partial name returns matching vendors
- [ ] `search_contacts` with email domain returns matching contacts
- [ ] `search_employees` with first name returns matching active employees
- [ ] `search_employees` does not return inactive employees
- [ ] `search_gl_accounts` with account name returns matching G/L accounts
- [ ] `search_bank_accounts` with IBAN fragment returns matching bank accounts
- [ ] `search_resources` with name returns matching resources
- [ ] `search_fixed_assets` with description returns matching fixed assets
- [ ] `search_records` with `searchFields` array uses multi-field engine
- [ ] `search_records` with `nameField` (no searchFields) uses legacy 2-field mode
- [ ] Multi-field search caps SystemIds at 100 (no oversized filter strings)
- [ ] Table parameter with injection characters (`{`, `"`) returns validation error
- [ ] Batch request `[msg1, msg2]` returns two responses
- [ ] `notifications/initialized` returns HTTP 202 with no body
- [ ] Cold start (fresh function instance) completes first call successfully
- [ ] `/.well-known/mcp.json` is reachable and returns valid JSON
- [ ] `get_next_line_no` on "Sales Line" with valid primary key returns a numeric `nextLineNo`
- [ ] `batch_records` with 2 requests returns 2 result entries
- [ ] `batch_records` with >10 requests returns validation error
- [ ] `get_document_lines` with `documentType: "sales order"` resolves to Sales Line table
- [ ] `get_document_lines` with unknown `documentType` returns descriptive error
- [ ] `get_decimal_total` with `decimalFields: ["Amount", "Debit Amount"]` returns `totals` object
- [ ] `get_decimal_total` with single `decimalField` still returns `total` (backwards compatible)
- [ ] `resources/list` includes `resourceTemplates` array with 2 entries
- [ ] `prompts/list` returns 14 prompts (7 original + 7 new)
- [ ] `prompts/get` for `vendor_lookup_pattern` returns Vendor field table
- [ ] `prompts/get` for `gl_account_lookup_pattern` returns G/L Account field table
- [ ] `prompts/get` for `bank_account_lookup_pattern` returns Bank Account field table
- [ ] `prompts/get` for `resource_lookup_pattern` returns Resource field table
- [ ] `prompts/get` for `employee_lookup_pattern` returns Employee field table
- [ ] `prompts/get` for `purchase_order_creation_workflow` returns Purchase Header + Line fields
- [ ] `prompts/get` for `general_journal_creation_workflow` returns Gen. Journal Line fields
