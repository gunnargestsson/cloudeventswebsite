/**
 * BC Metadata MCP Server — Azure Function (Streamable HTTP transport)
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0, protocol version 2024-11-05)
 * over a single HTTP POST endpoint at /api/mcp.
 *
 * On first tool call the function resolves the company by fetching
 * GET /v2.0/{tenant}/{env}/api/v2.0/companies and caching the first result.
 *
 * Tools exposed:
 *   list_tables       — Help.Tables.Get  — all tables in the BC company
 *   get_table_info    — Help.Tables.Get  — details for one table (by name or number)
 *   get_table_fields  — Help.Fields.Get + Help.Permissions.Get — fields for one table
 *
 * Required env vars: BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET
 * Optional env var:  BC_ENVIRONMENT (default "production")
 */
"use strict";

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

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";

  const result  = await bcGet(`/v2.0/${tenantId}/${env}/api/v2.0/companies`);
  const company = Array.isArray(result) ? result[0] : (result.value || [])[0];
  if (!company) throw new Error("No companies found in Business Central");

  _companyId   = company.id;
  _companyName = company.name;
  return { id: _companyId, name: _companyName };
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function toolListTables({ lcid = 1033 } = {}) {
  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const result = await bcTask(tenantId, env, company.id, {
    specversion: "1.0",
    type:        "Help.Tables.Get",
    source:      "BC Metadata MCP v1.0",
    lcid,
  });

  const tables = result.value || result.tables || (Array.isArray(result) ? result : []);
  return { company: company.name, tableCount: tables.length, tables };
}

async function toolGetTableInfo({ table, lcid = 1033 } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");

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

  return { company: company.name, table: result };
}

async function toolGetTableFields({ table, lcid = 1033 } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");

  const tenantId = process.env.BC_TENANT_ID;
  const env      = process.env.BC_ENVIRONMENT || "production";
  const company  = await getCompany();

  const [fieldsResult, permsResult] = await Promise.all([
    bcTask(tenantId, env, company.id, {
      specversion: "1.0",
      type:        "Help.Fields.Get",
      source:      "BC Metadata MCP v1.0",
      subject:     String(table),
      lcid,
    }),
    bcTask(tenantId, env, company.id, {
      specversion: "1.0",
      type:        "Help.Permissions.Get",
      source:      "BC Metadata MCP v1.0",
      subject:     String(table),
    }).catch(() => null),
  ]);

  const fields = fieldsResult.value || fieldsResult.fields || (Array.isArray(fieldsResult) ? fieldsResult : []);
  return {
    company:     company.name,
    table:       String(table),
    permissions: permsResult,
    fieldCount:  fields.length,
    fields,
  };
}

// ── MCP Tool definitions (JSON Schema) ────────────────────────────────────────

const TOOLS = [
  {
    name:        "list_tables",
    description: "Lists all tables available in the Business Central company with their numbers, names, and captions.",
    inputSchema: {
      type:       "object",
      properties: {
        lcid: {
          type:        "integer",
          description: "Language LCID for captions (default 1033 = English, 1039 = Icelandic, 1030 = Danish).",
        },
      },
    },
  },
  {
    name:        "get_table_info",
    description: "Gets summary information about a specific Business Central table (number, name, caption).",
    inputSchema: {
      type:       "object",
      properties: {
        table: {
          type:        "string",
          description: "Table name (e.g. 'Customer') or table number as string (e.g. '18').",
        },
        lcid: {
          type:        "integer",
          description: "Language LCID for captions (default 1033 = English).",
        },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_table_fields",
    description: "Gets all fields for a Business Central table — field names, JSON keys, captions, data types, lengths, class (Normal / FlowField), primary key membership, enum values, and read/write permissions.",
    inputSchema: {
      type:       "object",
      properties: {
        table: {
          type:        "string",
          description: "Table name (e.g. 'Customer') or table number as string (e.g. '18').",
        },
        lcid: {
          type:        "integer",
          description: "Language LCID for captions (default 1033 = English).",
        },
      },
      required: ["table"],
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
            capabilities:    { tools: {} },
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
          case "list_tables":      content = await toolListTables(args);      break;
          case "get_table_info":   content = await toolGetTableInfo(args);    break;
          case "get_table_fields": content = await toolGetTableFields(args);  break;
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
