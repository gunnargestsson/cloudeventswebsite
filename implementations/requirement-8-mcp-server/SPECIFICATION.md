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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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

### 5. New Tool: `search_customers`
**Status:** ❌ Not Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Convenience wrapper for AI assistants to find customers by name or number without needing to know BC filter syntax. If the query looks like a customer number (all digits or typical BC format), an exact `No.` match is attempted first; otherwise a wildcard `Name` filter is used.

**Fields returned:** No. (1), Name (2), Address (5), Phone No. (8), Contact (23), Country/Region Code (35).

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

### 6. New Tool: `search_items`
**Status:** ❌ Not Implemented  
**Priority:** 🟡 Medium  
**File:** `api/mcp/index.js`

**Description:** Same pattern as `search_customers` for the Item table. Useful for AI assistants composing sales orders.

**Fields returned:** No. (1), Description (3), Base Unit of Measure (8), Unit Price (18), Inventory (21), Blocked (54).

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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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
**Status:** ❌ Not Implemented  
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
| 🟢 Low | §10 — MCP Prompts (`describe_table`, `find_tables_for_entity`, `data_model_overview`, `sales_order_creation_workflow`, `customer_lookup_pattern`, `item_lookup_pattern`) | ~2 h |
| 🟡 Medium | §14 — translation tools (`list_translations`, `set_translations`) | ~1 h |

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
