/**
 * BC Metadata MCP Server — Azure Function (Streamable HTTP transport)
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0, protocol version 2024-11-05)
 * over a single HTTP POST endpoint at /api/mcp.
 *
 * Company resolution: honours BC_COMPANY_ID and BC_COMPANY_NAME env vars; falls
 * back to the first company returned by BC when neither is set.
 *
 * Tools exposed:
 *   list_tables        — Help.Tables.Get  — all tables (filter / paging supported)
 *   get_table_info     — Help.Tables.Get  — details for one table (by name or number)
 *   get_table_fields   — Help.Fields.Get + Help.Permissions.Get — fields for one table (json or markdown)
 *   list_companies     — /api/v2.0/companies — all companies in the BC environment
 *   list_message_types — Help.MessageTypes.Get — all Cloud Event message types
 *   get_message_type_help — Help.Implementation.Get — full implementation guide (markdown) for one message type
 *   get_records        — Data.Records.Get — records from any table with filter/paging
 *   set_records        — Data.Records.Set — create / modify / delete / upsert records in any table
 *   search_customers   — Data.Records.Get — customer lookup by name or number
 *   search_items       — Data.Records.Get — item lookup by description or number
 *   list_translations  — Cloud Event Translation — list UI translations (filter by source/lcid)
 *   set_translations   — Cloud Event Translation — upsert UI translation pairs
 *
 * Resources: bc://companies, bc://message-types, bc://tables, bc://tables/{name}
 * Prompts:   describe_table, find_tables_for_entity, data_model_overview,
 *            sales_order_creation_workflow, customer_lookup_pattern, item_lookup_pattern,
 *            implement_message_type
 *
 * Required env vars: BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET
 * Optional env vars: BC_ENVIRONMENT  (default "production")
 *                    BC_COMPANY_ID   (GUID — pin a specific company)
 *                    BC_COMPANY_NAME (display name fallback)
 */
"use strict";

// ── Input validation ───────────────────────────────────────────────────────────

const TABLE_NAME_RE = /^[\w\s.\-]{1,80}$/;

function validateTableName(table) {
  if (!TABLE_NAME_RE.test(String(table))) {
    throw new Error(
      `Invalid table name '${table}'. Table names must be 1–80 characters and contain only ` +
      `letters, digits, spaces, dots, underscores, or hyphens.`
    );
  }
}

const https = require("https");

const BC_HOST   = "api.businesscentral.dynamics.com";
const MSFT_HOST = "login.microsoftonline.com";

// ── HTTPS helper ───────────────────────────────────────────────────────────────

function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body != null ? Buffer.from(body, "utf8") : null;
    const reqHeaders = {
      Accept: "application/json",
      ...headers,
      ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}),
    };
    const req = https.request({ hostname, path, method, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Token (module-level cache) ─────────────────────────────────────────────────

let _token       = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;

  const tenantId     = process.env.BC_TENANT_ID;
  const clientId     = process.env.BC_CLIENT_ID;
  const clientSecret = process.env.BC_CLIENT_SECRET;

  const form = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         "https://api.businesscentral.dynamics.com/.default",
  }).toString();

  const { body: raw } = await httpsRequest(
    MSFT_HOST,
    `/${tenantId}/oauth2/v2.0/token`,
    "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    form,
  );

  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`Token error (${parsed.error}): ${parsed.error_description || ""}`);
  if (!parsed.access_token) throw new Error("Microsoft identity platform returned no access_token");

  _token       = parsed.access_token;
  _tokenExpiry = Date.now() + parsed.expires_in * 1_000;
  return _token;
}

// ── BC standard REST (for company list) ────────────────────────────────────────

async function bcGet(path) {
  const token = await getToken();
  const { statusCode, body } = await httpsRequest(
    BC_HOST, path, "GET",
    { Authorization: `Bearer ${token}` },
    null,
  );
  if (statusCode >= 400) throw new Error(`BC API HTTP ${statusCode}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ── CloudEvents task (two-step POST → GET) ─────────────────────────────────────

async function bcTask(tenantId, env, companyId, envelope) {
  const token    = await getToken();
  const auth     = `Bearer ${token}`;
  const taskPath = `/v2.0/${tenantId}/${env}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
  const bodyStr  = JSON.stringify(envelope);

  const { body: taskRaw } = await httpsRequest(
    BC_HOST, taskPath, "POST",
    { Authorization: auth, "Content-Type": "application/json" },
    bodyStr,
  );
  const task = JSON.parse(taskRaw);
  if (task.status === "Error") throw new Error(task.error || JSON.stringify(task));

  if (!task.data || !String(task.data).startsWith("https://api.businesscentral.dynamics.com/")) {
    return task;
  }

  const url = new URL(task.data);
  const { body: resultRaw } = await httpsRequest(
    url.hostname, url.pathname + url.search, "GET",
    { Authorization: auth },
    null,
  );
  const result = JSON.parse(resultRaw);
  if (result.status === "Error") throw new Error(result.error || JSON.stringify(result));
  return result;
}

// ── Company resolution (module-level cache) ────────────────────────────────────

let _companyId   = null;
let _companyName = null;

async function getCompany() {
  if (_companyId) return { id: _companyId, name: _companyName };

  const tenantId   = process.env.BC_TENANT_ID;
  const env        = process.env.BC_ENVIRONMENT || "production";
  const targetId   = process.env.BC_COMPANY_ID;
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

// ── Markdown helper ────────────────────────────────────────────────────────────

function toMarkdownTable(headers, rows) {
  const sep = headers.map(() => "---");
  const lines = [
    "| " + headers.join(" | ") + " |",
    "| " + sep.join(" | ") + " |",
    ...rows.map(r => "| " + r.map(v => String(v ?? "").replace(/\|/g, "\\|")).join(" | ") + " |"),
  ];
  return lines.join("\n");
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function toolListTables({ lcid = 1033, filter, skip = 0, take = 200 } = {}) {
  take = Math.min(Number(take) || 200, 500);
  skip = Math.max(Number(skip) || 0, 0);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Help.Tables.Get",
    source:      "BC Metadata MCP v1.0",
    lcid,
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

async function toolGetTableInfo({ table, lcid = 1033 } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");
  validateTableName(table);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Help.Tables.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
    lcid,
  });

  const tableData = (result.result && result.result[0]) || result;
  return { company: company.name, table: tableData };
}

async function toolGetTableFields({ table, lcid = 1033, format = "json" } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");
  validateTableName(table);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const [fieldsResult, permsResult] = await Promise.all([
    bcTask(tenantId, env, company.id, {
      specversion: "1.0",
      type:        "Help.Fields.Get",
      source:      "BC Metadata MCP v1.0",
      data:        JSON.stringify({ tableName: String(table) }),
      lcid,
    }),
    bcTask(tenantId, env, company.id, {
      specversion: "1.0",
      type:        "Help.Permissions.Get",
      source:      "BC Metadata MCP v1.0",
      subject:     String(table),
    }).catch(() => null),
  ]);

  const fields = fieldsResult.result || fieldsResult.value || fieldsResult.fields || (Array.isArray(fieldsResult) ? fieldsResult : []);

  const rawPerms = permsResult ? (permsResult.permissions || permsResult) : null;
  const permissions = rawPerms
    ? { read: !!(rawPerms.read ?? rawPerms.readPermission), write: !!(rawPerms.write ?? rawPerms.writePermission) }
    : null;

  if (format === "markdown") {
    const md = toMarkdownTable(
      ["#", "Name", "JSON Key", "Caption", "Type", "Len", "Class", "PK"],
      fields.map(f => [f.number, f.name, f.jsonName, f.caption, f.type, f.length || "", f.class || "", f.isPartOfPrimaryKey ? "✓" : ""]),
    );
    return { company: company.name, table: String(table), permissions, fieldCount: fields.length, markdown: md };
  }

  return { company: company.name, table: String(table), permissions, fieldCount: fields.length, fields };
}

async function toolListCompanies() {
  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const result    = await bcGet(`/v2.0/${tenantId}/${env}/api/v2.0/companies`);
  const companies = (Array.isArray(result) ? result : (result.value || []))
    .map(c => ({ id: c.id, name: c.name, displayName: c.displayName }));
  return { companies };
}

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

async function toolGetMessageTypeHelp({ type, lcid = 1033 } = {}) {
  if (!type) throw new Error("Parameter 'type' is required (message type name, e.g. 'Customer.Create')");

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Help.Implementation.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(type),
    lcid,
  });

  // The result may be a string (raw markdown) or an object with a result/value/content field
  let markdown = result.result ?? result.value ?? result.content ?? result.markdown;
  if (markdown == null) {
    markdown = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }
  if (typeof markdown !== "string") {
    markdown = JSON.stringify(markdown, null, 2);
  }

  return { company: company.name, type: String(type), markdown };
}

async function toolGetRecords({ table, filter, fields, skip = 0, take = 50, lcid = 1033, format = "json" } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);
  take = Math.min(Number(take) || 50, 200);
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

  if (format === "markdown") {
    // Flatten each record: merge primaryKey + fields into a single object
    const flat = records.map(r => {
      if (r && (r.primaryKey || r.fields)) {
        return { ...(r.primaryKey || {}), ...(r.fields || {}) };
      }
      return r || {};
    });
    const headers = flat.length ? [...new Set(flat.flatMap(r => Object.keys(r)))] : [];
    const md = toMarkdownTable(headers, flat.map(r => headers.map(h => r[h])));
    return { company: company.name, table: String(table), skip, take, count: records.length, markdown: md };
  }

  return { company: company.name, table: String(table), skip, take, count: records.length, records };
}

async function toolSetRecords({ table, data, mode = "upsert" } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  if (!Array.isArray(data) || !data.length) throw new Error("Parameter 'data' must be a non-empty array");
  validateTableName(table);

  const VALID_MODES = ["insert", "modify", "delete", "upsert"];
  if (!VALID_MODES.includes(mode)) throw new Error(`Invalid mode '${mode}'. Valid values: ${VALID_MODES.join(", ")}`);

  // Each record must have at least a primaryKey object
  for (let i = 0; i < data.length; i++) {
    const rec = data[i];
    if (!rec || typeof rec !== "object") throw new Error(`data[${i}] must be an object`);
    if (!rec.primaryKey || typeof rec.primaryKey !== "object") throw new Error(`data[${i}].primaryKey is required`);
    if (mode !== "delete" && (!rec.fields || typeof rec.fields !== "object")) throw new Error(`data[${i}].fields is required for mode '${mode}'`);
  }

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const payload = mode === "upsert" ? { data } : { mode, data };

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
    data:        JSON.stringify(payload),
  });

  const records = result.result || result.value || (Array.isArray(result) ? result : []);
  return { company: company.name, table: String(table), mode, written: data.length, records };
}

async function toolSearchCustomers({ query, take = 10 } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 10, 50);

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const isNo   = /^[\w\-]+$/.test(String(query).trim()) && query.length <= 20;
  const filter = isNo
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
    company:      company.name,
    source,
    lcid:         Number(lcid),
    total:        records.length,
    missing:      records.filter(r => !r.targetText.trim()).length,
    translations: records,
  };
}

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

// ── MCP Tool definitions (JSON Schema) ────────────────────────────────────────

const TOOLS = [
  {
    name:        "list_tables",
    description: "Lists tables available in the Business Central company with their numbers, names, and captions. Supports substring filter and paging.",
    inputSchema: {
      type:       "object",
      properties: {
        lcid:   { type: "integer", description: "Language LCID for captions (default 1033 = English, 1039 = Icelandic, 1030 = Danish)." },
        filter: { type: "string",  description: "Substring filter on table name or caption (case-insensitive)." },
        take:   { type: "integer", description: "Max tables to return (default 200, max 500)." },
        skip:   { type: "integer", description: "Number of tables to skip for paging (default 0)." },
      },
    },
  },
  {
    name:        "get_table_info",
    description: "Gets summary information about a specific Business Central table (number, name, caption).",
    inputSchema: {
      type:       "object",
      properties: {
        table: { type: "string",  description: "Table name (e.g. 'Customer') or table number as string (e.g. '18')." },
        lcid:  { type: "integer", description: "Language LCID for captions (default 1033 = English)." },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_table_fields",
    description: "Gets all fields for a Business Central table — field names, JSON keys, captions, data types, lengths, class, primary key membership, enum values, and read/write permissions.",
    inputSchema: {
      type:       "object",
      properties: {
        table:  { type: "string",  description: "Table name (e.g. 'Customer') or table number as string (e.g. '18')." },
        lcid:   { type: "integer", description: "Language LCID for captions (default 1033 = English)." },
        format: { type: "string",  enum: ["json", "markdown"], description: "Output format: 'json' (default) or 'markdown' for LLM-friendly table output." },
      },
      required: ["table"],
    },
  },
  {
    name:        "list_companies",
    description: "Lists all companies available in the Business Central environment.",
    inputSchema: { type: "object", properties: {} },
  },
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
  {
    name:        "get_message_type_help",
    description: "Returns the full implementation guide (markdown) for a specific Cloud Event message type from Business Central via Help.Implementation.Get. Contains the JSON schema, required fields, examples, and any business rules needed to implement the message type.",
    inputSchema: {
      type:       "object",
      properties: {
        type: { type: "string",  description: "Message type name (e.g. 'Customer.Create', 'SalesOrder.Post')." },
        lcid: { type: "integer", description: "Language LCID for the help content (default 1033 = English)." },
      },
      required: ["type"],
    },
  },
  {
    name:        "get_records",
    description: "Reads records from a Business Central table with optional filter, field selection, and paging. Returns up to 50 records by default (max 200).",
    inputSchema: {
      type:       "object",
      properties: {
        table:  { type: "string",  description: "BC table name (e.g. 'Customer', 'Item', 'Sales Header')." },
        filter: { type: "string",  description: "BC-style tableView filter, e.g. \"WHERE(Blocked=CONST( ))\"." },
        fields: { type: "array",   items: { type: "integer" }, description: "Field numbers to return (omit for all)." },
        skip:   { type: "integer", description: "Records to skip for paging (default 0)." },
        take:   { type: "integer", description: "Max records to return (default 50, max 200)." },
        lcid:   { type: "integer", description: "Language LCID for enum captions (default 1033)." },
        format: { type: "string",  enum: ["json", "markdown"], description: "Output format: 'json' (default) or 'markdown' for LLM-friendly table output." },
      },
      required: ["table"],
    },
  },
  {
    name:        "set_records",
    description: "Creates, modifies, deletes, or upserts records in any Business Central table via Data.Records.Set. Each record must supply a primaryKey object (the BC primary key fields) and a fields object (the non-key fields to write). Mode 'upsert' (default) inserts if the record does not exist, otherwise modifies it.",
    inputSchema: {
      type:     "object",
      properties: {
        table: { type: "string", description: "BC table name (e.g. 'Customer', 'Sales Header')." },
        mode:  { type: "string", enum: ["insert", "modify", "delete", "upsert"], description: "Write mode (default 'upsert')." },
        data: {
          type:  "array",
          description: "Array of records to write. Each item must have a 'primaryKey' object and (except for delete) a 'fields' object.",
          items: {
            type:       "object",
            properties: {
              primaryKey: {
                type:        "object",
                description: "Key fields that identify the record (e.g. { DocumentType: 'Order', No_: 'SO-001' }).",
              },
              fields: {
                type:        "object",
                description: "Non-key field values to write (not required for mode 'delete').",
              },
            },
            required: ["primaryKey"],
          },
        },
      },
      required: ["table", "data"],
    },
  },
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
];

// ── JSON-RPC 2.0 dispatcher ────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities:    { tools: {}, resources: {}, prompts: {} },
            serverInfo:      { name: "BC Metadata MCP Server", version: "1.0.0" },
          },
        };

      case "notifications/initialized":
        return null; // notification — no response

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const toolName = (params || {}).name;
        const args     = (params || {}).arguments || {};
        let content;

        switch (toolName) {
          case "list_tables":        content = await toolListTables(args);        break;
          case "get_table_info":     content = await toolGetTableInfo(args);      break;
          case "get_table_fields":   content = await toolGetTableFields(args);    break;
          case "list_companies":        content = await toolListCompanies();              break;
          case "list_message_types":    content = await toolListMessageTypes(args);       break;
          case "get_message_type_help": content = await toolGetMessageTypeHelp(args);     break;
          case "get_records":           content = await toolGetRecords(args);              break;
          case "set_records":           content = await toolSetRecords(args);              break;
          case "search_customers":      content = await toolSearchCustomers(args);        break;
          case "search_items":       content = await toolSearchItems(args);       break;
          case "list_translations":  content = await toolListTranslations(args);  break;
          case "set_translations":   content = await toolSetTranslations(args);   break;
          default:
            return {
              jsonrpc: "2.0", id,
              error: { code: -32602, message: `Unknown tool: ${toolName}` },
            };
        }

        return {
          jsonrpc: "2.0", id,
          result: {
            content:  [{ type: "text", text: JSON.stringify(content, null, 2) }],
            isError:  false,
          },
        };
      }

      case "resources/list":
        return {
          jsonrpc: "2.0", id,
          result: {
            resources: [
              { uri: "bc://companies",     name: "Companies",     mimeType: "application/json" },
              { uri: "bc://message-types", name: "Message Types", mimeType: "application/json" },
              { uri: "bc://tables",        name: "Tables",        mimeType: "application/json" },
            ],
          },
        };

      case "resources/read": {
        const uri = (params || {}).uri || "";
        let data;
        if (uri === "bc://companies")          data = await toolListCompanies();
        else if (uri === "bc://message-types") data = await toolListMessageTypes();
        else if (uri.startsWith("bc://message-types/")) {
          const msgType = decodeURIComponent(uri.slice("bc://message-types/".length));
          data = await toolGetMessageTypeHelp({ type: msgType });
        }
        else if (uri === "bc://tables")        data = await toolListTables({});
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
              {
                name: "implement_message_type",
                description: "Returns the full implementation guide for a Cloud Event message type: the BC help documentation plus the list of all available message types for context.",
                arguments: [
                  { name: "type", description: "Message type name (e.g. 'Customer.Create')", required: true },
                  { name: "lcid", description: "Language LCID for content (default 1033)",    required: false },
                ],
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
          text = `## BC Tables matching "${promptArgs.entity}"\n\n` +
            data.tables.map(t => `- **${t.name}** (#${t.id}): ${t.caption || ""}`).join("\n");
        } else if (promptName === "data_model_overview") {
          const data = await toolListTables({});
          const groups = {};
          for (const t of data.tables) {
            const ns = t.name.split(" ")[0];
            (groups[ns] = groups[ns] || []).push(t.name);
          }
          text = "## BC Data Model Overview\n\n" +
            Object.entries(groups).map(([ns, names]) => `### ${ns}\n${names.join(", ")}`).join("\n\n");
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
        } else if (promptName === "implement_message_type") {
          if (!promptArgs.type) throw new Error("Argument 'type' is required for the implement_message_type prompt");
          const lcid = Number(promptArgs.lcid) || 1033;
          const [helpData, typesData] = await Promise.all([
            toolGetMessageTypeHelp({ type: promptArgs.type, lcid }),
            toolListMessageTypes({}),
          ]);
          text = `## Implementation Guide: ${promptArgs.type}\n\n` +
            `**Company:** ${helpData.company}\n\n` +
            `---\n\n` +
            `${helpData.markdown}\n\n` +
            `---\n\n` +
            `## All available message types in this BC instance\n\n` +
            typesData.types.map(t => `- **${t.name}** (${t.direction || ""})${t.description ? " — " + t.description : ""}`).join("\n");
        } else {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown prompt: ${promptName}` } };
        }

        return {
          jsonrpc: "2.0", id,
          result: { messages: [{ role: "user", content: { type: "text", text } }] },
        };
      }

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err) {
    // Return tool error in MCP result format (not JSON-RPC error) so the LLM can read the message
    return {
      jsonrpc: "2.0", id,
      result: {
        content:  [{ type: "text", text: `Error: ${err.message}` }],
        isError:  true,
      },
    };
  }
}

// ── Azure Function entry point ─────────────────────────────────────────────────

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    context.res = {
      status:  204,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
    return;
  }

  // Require server-side credentials
  if (!process.env.BC_TENANT_ID || !process.env.BC_CLIENT_ID || !process.env.BC_CLIENT_SECRET) {
    context.res = {
      status:  500,
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0", id: null,
        error: { code: -32603, message: "Server configuration incomplete — BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET must be set." },
      }),
    };
    return;
  }

  const body = req.body;
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  // Batch request (array of messages)
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handleMessage))).filter((r) => r !== null);
    context.res = { status: 200, headers: corsHeaders, body: JSON.stringify(responses) };
    return;
  }

  const response = await handleMessage(body);
  if (response === null) {
    // Notification — acknowledge with 202, no body
    context.res = { status: 202, headers: { "Access-Control-Allow-Origin": "*" } };
    return;
  }

  context.res = { status: 200, headers: corsHeaders, body: JSON.stringify(response) };
};
