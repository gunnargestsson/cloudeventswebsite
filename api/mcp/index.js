/**
 * BC Metadata MCP Server — Azure Function (Streamable HTTP transport)
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0, protocol version 2024-11-05)
 * over a single HTTP POST endpoint at /api/mcp.
 *
 * Company resolution: all tools accept an optional `companyId` parameter (GUID or
 * exact company name) to target any company per-call.  Falls back to the
 * BC_COMPANY_ID / BC_COMPANY_NAME env vars, then the first company in the environment.
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
 *   get_record_count             — Data.Records.Get (take:1, field 1 only) — total record count for any table with optional filter
 *   get_decimal_total            — Data.Totals.Get — sum one decimal field across records in any table with optional filter
 *   get_sales_order_statistics  — Sales.Order.Statistics — amounts, VAT totals, quantities for a sales order
 *   call_message_type  — any Cloud Event type — generic caller: send any message type with subject + data; use get_message_type_help first to understand the schema
 *   get_integration_timestamp   — Cloud Events Integration — latest non-reversed DateTime for source+tableId
 *   set_integration_timestamp   — Cloud Events Integration — insert a DateTime entry for source+tableId
 *   reverse_integration_timestamp — Cloud Events Integration — mark the latest non-reversed entry as reversed
 *
 * Resources: bc://companies, bc://message-types, bc://tables, bc://tables/{name}
 * Prompts:   describe_table, find_tables_for_entity, data_model_overview,
 *            sales_order_creation_workflow, customer_lookup_pattern, item_lookup_pattern,
 *            implement_message_type
 *
 *   encrypt_data   — AES-256-GCM symmetric encryption using server-side MCP_ENCRYPTION_KEY
 *   decrypt_data   — AES-256-GCM symmetric decryption using server-side MCP_ENCRYPTION_KEY
 *   check_standards_status  — full Origo BC environment check: GitHub sync + local repo, .claude, CLAUDE.md, skills junction, mcp.json, git, node
 *   update_bc_standards     — pull latest bc-dev-standards and copy CLAUDE.md to .claude
 *   setup_origo_bc_environment — one-time setup: clone repo, create .claude, copy CLAUDE.md, create skills junction
 *   save_app_range          — upsert a BC extension's app id/name/publisher/idRanges into Cloud Events Storage (source = 'Origo App Range')
 *   check_app_range         — verify a set of BC object ID ranges against all registered apps; reports conflicts and suggests a free range
 *
 * Required env vars: BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET
 *                    MCP_ENCRYPTION_KEY  (64 hex chars = 32 bytes, required for encrypt_data / decrypt_data)
 * Optional env vars: BC_ENVIRONMENT  (default "production")
 *                    BC_COMPANY_ID   (GUID — pin a specific company)
 *                    BC_COMPANY_NAME (display name fallback)
 *                    MCP_DECRYPT_ALLOWED_HOSTS (comma-separated extra allowed hosts for decrypt_data/get_config decrypt)
 *
 * All tools also accept per-call connection parameters (tenantId, clientId,
 * clientSecret, environment, companyId) that override the env vars. This lets
 * AI agents address any BC tenant/environment without redeploying the server.
 */
"use strict";

// ── Input validation ───────────────────────────────────────────────────────────

const TABLE_NAME_RE = /^[\w\s.\-\/]{1,80}$/;

function validateTableName(table) {
  if (!TABLE_NAME_RE.test(String(table))) {
    throw new Error(
      `Invalid table name '${table}'. Table names must be 1–80 characters and contain only ` +
      `letters, digits, spaces, dots, underscores, or hyphens.`
    );
  }
}

const https        = require("https");
const crypto       = require("crypto");
const { execSync } = require("child_process");
const fs           = require("fs");

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

function resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  // If an encrypted connection blob is provided, decrypt and merge it first.
  // Individual explicit params still override values from the blob.
  if (encryptedConn) {
    let parsed;
    try {
      parsed = JSON.parse(decryptCiphertext(String(encryptedConn)));
    } catch (e) {
      throw new Error(`encryptedConn could not be decrypted: ${e.message}`);
    }
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

const _tokenCache = new Map(); // key: "tenantId|clientId" → { token, expiry }

async function getToken(conn) {
  const key    = `${conn.tenantId}|${conn.clientId}`;
  const cached = _tokenCache.get(key);
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;

  const tenantId     = conn.tenantId;
  const clientId     = conn.clientId;
  const clientSecret = conn.clientSecret;

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

  _tokenCache.set(key, { token: parsed.access_token, expiry: Date.now() + parsed.expires_in * 1_000 });
  return parsed.access_token;
}

// ── BC standard REST (for company list) ────────────────────────────────────────

async function bcGet(path, conn) {
  const token = await getToken(conn);
  const { statusCode, body } = await httpsRequest(
    BC_HOST, path, "GET",
    { Authorization: `Bearer ${token}` },
    null,
  );
  if (statusCode >= 400) throw new Error(`BC API HTTP ${statusCode}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ── CloudEvents task (two-step POST → GET) ─────────────────────────────────────

async function bcTask(conn, companyId, envelope) {
  const token    = await getToken(conn);
  const auth     = `Bearer ${token}`;
  const taskPath = `/v2.0/${conn.tenantId}/${conn.environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
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
  let result;
  try {
    result = JSON.parse(resultRaw);
  } catch {
    // Response is plain text / markdown — return as-is
    return resultRaw;
  }
  if (result.status === "Error") throw new Error(result.error || JSON.stringify(result));
  return result;
}

// ── Company resolution (module-level cache) ────────────────────────────────────

const _companiesCache    = new Map(); // key: "tenantId|environment" → companies[]
const _defaultCompanyMap = new Map(); // key: "tenantId|environment|companyId|companyName" → { id, name }

async function _getCompanies(conn) {
  const key    = `${conn.tenantId}|${conn.environment}`;
  const cached = _companiesCache.get(key);
  if (cached) return cached;
  const result = await bcGet(`/v2.0/${conn.tenantId}/${conn.environment}/api/v2.0/companies`, conn);
  const list   = Array.isArray(result) ? result : (result.value || []);
  _companiesCache.set(key, list);
  return list;
}

async function getCompany(companyIdOverride, conn) {
  const companies = await _getCompanies(conn);
  if (!companies.length) throw new Error("No companies found in Business Central");

  // Explicit per-call override — match by GUID or exact name (case-insensitive)
  if (companyIdOverride) {
    const needle = String(companyIdOverride).toLowerCase();
    const found  = companies.find(
      c => c.id === companyIdOverride || (c.name || "").toLowerCase() === needle,
    );
    if (!found) throw new Error(`Company '${companyIdOverride}' not found. Use list_companies to see available companies.`);
    return { id: found.id, name: found.name };
  }

  // Cached default (keyed per tenant+environment+company env vars)
  const cacheKey = `${conn.tenantId}|${conn.environment}|${process.env.BC_COMPANY_ID || ""}|${(process.env.BC_COMPANY_NAME || "").toLowerCase()}`;
  const cached   = _defaultCompanyMap.get(cacheKey);
  if (cached) return cached;

  // Resolve from env vars
  const targetId   = process.env.BC_COMPANY_ID;
  const targetName = (process.env.BC_COMPANY_NAME || "").toLowerCase();

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

  const resolved = { id: company.id, name: company.name };
  _defaultCompanyMap.set(cacheKey, resolved);
  return resolved;
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

function parseHeaderHost(value) {
  if (!value) return "";
  const first = String(value).split(",")[0].trim();
  if (!first) return "";

  try {
    if (/^https?:\/\//i.test(first)) {
      return new URL(first).hostname.toLowerCase();
    }
  } catch {
    return "";
  }

  // Host header may include a port (example.com:443)
  return first.split(":")[0].toLowerCase();
}

function buildAllowedDecryptHosts(req) {
  const hosts = new Set();

  const requestHost =
    parseHeaderHost(req.headers["x-forwarded-host"]) ||
    parseHeaderHost(req.headers["host"]);
  if (requestHost) hosts.add(requestHost);

  const websiteHost = parseHeaderHost(process.env.WEBSITE_HOSTNAME || "");
  if (websiteHost) hosts.add(websiteHost);

  const configuredHosts = String(process.env.MCP_DECRYPT_ALLOWED_HOSTS || "")
    .split(",")
    .map(parseHeaderHost)
    .filter(Boolean);
  configuredHosts.forEach(h => hosts.add(h));

  return hosts;
}

function isTrustedDecryptCaller(req) {
  const allowedHosts = buildAllowedDecryptHosts(req);
  if (!allowedHosts.size) return false;

  const originHost  = parseHeaderHost(req.headers["origin"]);
  const refererHost = parseHeaderHost(req.headers["referer"]);

  return (originHost && allowedHosts.has(originHost)) ||
    (refererHost && allowedHosts.has(refererHost));
}

// ── Symmetric encryption (AES-256-GCM) ───────────────────────────────────────
// Key is stored as MCP_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
// Ciphertext format: base64( iv[12] | authTag[16] | ciphertext )

function getEncryptionKey() {
  const hex = process.env.MCP_ENCRYPTION_KEY;
  if (!hex) throw new Error("MCP_ENCRYPTION_KEY is not configured on this server");
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error("MCP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  return Buffer.from(hex, "hex");
}

function toolEncryptData({ plaintext } = {}) {
  if (typeof plaintext !== "string" || !plaintext)
    throw new Error("Parameter 'plaintext' is required and must be a non-empty string");
  const key    = getEncryptionKey();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, enc]);
  return { ciphertext: combined.toString("base64") };
}

function decryptCiphertext(ciphertext) {
  if (typeof ciphertext !== "string" || !ciphertext)
    throw new Error("Parameter 'ciphertext' is required and must be a non-empty string");
  const key  = getEncryptionKey();
  let buf;
  try { buf = Buffer.from(ciphertext, "base64"); } catch { throw new Error("ciphertext is not valid base64"); }
  if (buf.length < 28) throw new Error("ciphertext is too short to be a valid encrypted payload");
  const iv     = buf.subarray(0, 12);
  const tag    = buf.subarray(12, 28);
  const enc    = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new Error("Decryption failed — ciphertext is corrupted or the wrong key is in use");
  }
}

function toolDecryptData({ ciphertext } = {}, { allowExternal = false } = {}) {
  if (!allowExternal) {
    throw new Error(
      "Decryption is restricted. Only same-host website callers are allowed to decrypt via MCP tools."
    );
  }
  return { plaintext: decryptCiphertext(ciphertext) };
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function toolListTables({ lcid = 1033, filter, skip = 0, take = 200, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  take = Math.min(Number(take) || 200, 500);
  skip = Math.max(Number(skip) || 0, 0);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
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

async function toolGetTableInfo({ table, lcid = 1033, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Help.Tables.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
    lcid,
  });

  const tableData = (result.result && result.result[0]) || result;
  return { company: company.name, table: tableData };
}

async function toolGetTableFields({ table, lcid = 1033, format = "json", companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const [fieldsResult, permsResult] = await Promise.all([
    bcTask(conn, company.id, {
      specversion: "1.0",
      type:        "Help.Fields.Get",
      source:      "BC Metadata MCP v1.0",
      data:        JSON.stringify({ tableName: String(table) }),
      lcid,
    }),
    bcTask(conn, company.id, {
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

async function toolListCompanies({ tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  const conn      = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const companies = await _getCompanies(conn);
  return { companies: companies.map(c => ({ id: c.id, name: c.name, displayName: c.displayName })) };
}

async function toolListMessageTypes({ filter, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
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

async function toolGetMessageTypeHelp({ type, lcid = 1033, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!type) throw new Error("Parameter 'type' is required (message type name, e.g. 'Customer.Create')");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
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

async function toolGetRecords({ table, filter, fields, skip = 0, take = 50, lcid = 1033, format = "json", companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);
  take = Math.min(Number(take) || 50, 200);
  skip = Math.max(Number(skip) || 0, 0);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  let resolvedFieldNumbers = [];
  if (Array.isArray(fields) && fields.length) {
    // Check if any field is a name (non-numeric); if so, fetch table metadata to resolve
    const needsResolution = fields.some(f => isNaN(Number(f)));
    if (needsResolution) {
      const fieldsResult = await bcTask(conn, company.id, {
        specversion: "1.0",
        type:        "Help.Fields.Get",
        source:      "BC Metadata MCP v1.0",
        subject:     String(table),
        lcid,
      });
      const allFields = fieldsResult.result || fieldsResult.value || (Array.isArray(fieldsResult) ? fieldsResult : []);
      const nameToNo = new Map();
      for (const f of allFields) {
        const no = Number(f.number || f.fieldNo || f.no);
        const name = String(f.name || f.caption || "").trim();
        if (no >= 1 && name) nameToNo.set(name.toLowerCase(), no);
      }
      for (const f of fields) {
        const asNum = Number(f);
        if (!isNaN(asNum)) {
          resolvedFieldNumbers.push(asNum);
        } else {
          const no = nameToNo.get(String(f).toLowerCase());
          if (!no) throw new Error(`Field '${f}' not found in table '${table}'`);
          resolvedFieldNumbers.push(no);
        }
      }
    } else {
      resolvedFieldNumbers = fields.map(f => Number(f));
    }
  }

  const data = { tableName: String(table), skip, take };
  if (filter) data.tableView = String(filter);
  if (resolvedFieldNumbers.length) data.fieldNumbers = resolvedFieldNumbers;

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
    lcid,
  });

  const records = result.result || result.value || (Array.isArray(result) ? result : []);
  const noOfRecords = result.noOfRecords !== undefined ? result.noOfRecords : undefined;

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
    const ret = { company: company.name, table: String(table), skip, take, count: records.length, markdown: md };
    if (noOfRecords !== undefined) ret.noOfRecords = noOfRecords;
    return ret;
  }

  const ret = { company: company.name, table: String(table), skip, take, count: records.length, records };
  if (noOfRecords !== undefined) ret.noOfRecords = noOfRecords;
  return ret;
}

async function toolSetRecords({ table, data, mode = "upsert", companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
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

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const payload = mode === "upsert" ? { data } : { mode, data };

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
    data:        JSON.stringify(payload),
  });

  const records = result.result || result.value || (Array.isArray(result) ? result : []);
  return { company: company.name, table: String(table), mode, written: data.length, records };
}

async function toolSearchCustomers({ query, take = 10, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 10, 50);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const isNo   = /^[\w\-]+$/.test(String(query).trim()) && query.length <= 20;
  const filter = isNo
    ? `WHERE(No.=FILTER(${query}*)|Name=FILTER(*${query}*))`
    : `WHERE(Name=FILTER(*${query}*))`;

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify({ tableName: "Customer", tableView: filter, fieldNumbers: [1, 2, 5, 8, 23, 35], take }),
  });

  const records = result.result || result.value || [];
  return { company: company.name, query, count: records.length, customers: records };
}

async function toolSearchItems({ query, take = 10, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 10, 50);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const filter = /^[\w\-]+$/.test(String(query).trim()) && query.length <= 20
    ? `WHERE(No.=FILTER(${query}*)|Description=FILTER(*${query}*))`
    : `WHERE(Description=FILTER(*${query}*))`;

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify({ tableName: "Item", tableView: filter, fieldNumbers: [1, 3, 8, 18, 21, 54], take }),
  });

  const records = result.result || result.value || [];
  return { company: company.name, query, count: records.length, items: records };
}

async function toolListTranslations({ source, lcid, missingOnly = false, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!source) throw new Error("Parameter 'source' is required");
  if (!lcid)   throw new Error("Parameter 'lcid' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const tableView = `WHERE(Windows Language ID=CONST(${Number(lcid)}),Source=CONST(${source}))`;
  const result = await bcTask(conn, company.id, {
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

async function toolSetTranslations({ source, lcid, translations, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!source)       throw new Error("Parameter 'source' is required");
  if (!lcid)         throw new Error("Parameter 'lcid' is required");
  if (!Array.isArray(translations) || !translations.length)
    throw new Error("Parameter 'translations' must be a non-empty array");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = translations.map(t => ({
    primaryKey: {
      Source:            source,
      WindowsLanguageID: String(Number(lcid)),
      SourceText:        String(t.sourceText),
    },
    fields: { TargetText: String(t.targetText || "") },
  }));

  await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     "Cloud Event Translation",
    data:        JSON.stringify({ data }),
  });

  return { company: company.name, source, lcid: Number(lcid), written: translations.length };
}

// ── Cloud Events Integration helpers ─────────────────────────────────────────

const CI_TABLE = "Cloud Events Integration";

/**
 * Builds the tableView for Cloud Events Integration:
 *   SORTING(Source,Table Id,Date & Time) ORDER(Descending)
 *   WHERE(Source=CONST(<source>),Table Id=CONST(<tableId>),Reversed=CONST(false))
 * Using skip:0, take:1 returns the single most-recent non-reversed record.
 */
function ciTableView(source, tableId) {
  return `SORTING(Source,Table Id,Date & Time) ORDER(Descending) WHERE(Source=CONST(${source}),Table Id=CONST(${tableId}),Reversed=CONST(false))`;
}

async function toolGetIntegrationTimestamp({ source, tableId, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!source)  throw new Error("Parameter 'source' is required");
  if (!tableId && tableId !== 0) throw new Error("Parameter 'tableId' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify({
      tableName:  CI_TABLE,
      tableView:  ciTableView(source, Number(tableId)),
      skip:       0,
      take:       1,
    }),
  });

  const records = result.result || result.value || [];
  if (!records.length) {
    return { company: company.name, source, tableId: Number(tableId), dateTime: null };
  }

  const dateTime = (records[0].primaryKey || {}).DateTime || null;
  return { company: company.name, source, tableId: Number(tableId), dateTime };
}

async function toolSetIntegrationTimestamp({ source, tableId, dateTime, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!source)   throw new Error("Parameter 'source' is required");
  if (!tableId && tableId !== 0) throw new Error("Parameter 'tableId' is required");
  if (!dateTime) throw new Error("Parameter 'dateTime' is required (ISO 8601 string, e.g. '2026-03-17T12:00:00Z')");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     CI_TABLE,
    data:        JSON.stringify({
      data: [{
        primaryKey: { Source: String(source), TableId: Number(tableId), DateTime: String(dateTime) },
        fields:     { Reversed: "false" },
      }],
    }),
  });

  return { company: company.name, source, tableId: Number(tableId), dateTime: String(dateTime), written: 1 };
}

async function toolGetRecordCount({ table, filter, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table), skip: 0, take: 1, fieldNumbers: [1] };
  if (filter) data.tableView = String(filter);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  const noOfRecords = result.noOfRecords !== undefined ? result.noOfRecords : (result.result || []).length;
  return { company: company.name, table: String(table), filter: filter || null, count: noOfRecords };
}

function normalizeDecimalFieldRef(decimalField) {
  if (decimalField === undefined || decimalField === null || String(decimalField).trim() === "") {
    throw new Error("Parameter 'decimalField' is required (field name or field number)");
  }

  const raw = String(decimalField).trim();
  if (/^\d+$/.test(raw)) {
    const fieldNo = Number(raw);
    if (!Number.isFinite(fieldNo) || fieldNo < 1) {
      throw new Error("Parameter 'decimalField' as a number must be >= 1");
    }
    return { fieldNo, fieldName: null, normalized: fieldNo };
  }

  return { fieldNo: null, fieldName: raw, normalized: raw };
}

function extractTotalNumber(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  const tryRead = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    const keys = ["total", "sum", "value", "amount", "result"];
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
      if (value && typeof value === "object") {
        const nested = tryRead(value);
        if (nested !== null) return nested;
      }
    }
    return null;
  };

  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const value = extractTotalNumber(item);
      if (value !== null) return value;
    }
    return null;
  }
  return tryRead(raw);
}

async function toolGetDecimalTotal({ table, decimalField, filter, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);

  const { fieldNo, fieldName, normalized } = normalizeDecimalFieldRef(decimalField);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = {
    tableName: String(table),
    // Keep both aliases for compatibility with implementations that expect one naming style.
    field: fieldNo !== null ? fieldNo : fieldName,
  };
  if (fieldNo !== null) {
    data.fieldNo = fieldNo;
    data.fieldNumber = fieldNo;
  }
  if (fieldName) {
    data.fieldName = fieldName;
  }
  if (filter) data.tableView = String(filter);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Totals.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  const total = extractTotalNumber(result);
  if (total === null) {
    throw new Error("Data.Totals.Get did not return a numeric total");
  }

  return {
    company: company.name,
    table: String(table),
    decimalField: normalized,
    filter: filter || null,
    total,
  };
}

async function toolGetSalesOrderStatistics({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Sales.Order.Statistics",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  // bcTask returns parsed JSON or a raw string; normalise
  if (typeof result === "string") {
    try { return JSON.parse(result); } catch { return { raw: result }; }
  }
  return result;
}

async function toolCallMessageType({ type, subject, data, lcid = 1033, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!type) throw new Error("Parameter 'type' is required (e.g. 'Customer.Create', 'Sales.Order.Statistics')");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const envelope = {
    specversion: "1.0",
    type:        String(type),
    source:      "BC Metadata MCP v1.0",
    lcid,
  };
  if (subject !== undefined && subject !== null && subject !== "") {
    envelope.subject = String(subject);
  }
  if (data !== undefined && data !== null) {
    envelope.data = typeof data === "string" ? data : JSON.stringify(data);
  }

  const result = await bcTask(conn, company.id, envelope);

  if (typeof result === "string") {
    try { return { company: company.name, type: String(type), result: JSON.parse(result) }; }
    catch { return { company: company.name, type: String(type), result }; }
  }
  return { company: company.name, type: String(type), result };
}

async function toolReverseIntegrationTimestamp({ source, tableId, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!source)  throw new Error("Parameter 'source' is required");
  if (!tableId && tableId !== 0) throw new Error("Parameter 'tableId' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  // Step 1: find the latest non-reversed record
  const readResult = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify({
      tableName:  CI_TABLE,
      tableView:  ciTableView(source, Number(tableId)),
      skip:       0,
      take:       1,
    }),
  });

  const records = readResult.result || readResult.value || [];
  if (!records.length) {
    return { company: company.name, source, tableId: Number(tableId), reversed: false, dateTime: null,
             message: "No non-reversed record found for this source + tableId" };
  }

  const pk       = records[0].primaryKey || {};
  const dateTime = pk.DateTime;

  // Step 2: mark it reversed
  await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     CI_TABLE,
    data:        JSON.stringify({
      mode: "modify",
      data: [{
        primaryKey: { Source: String(source), TableId: Number(tableId), DateTime: String(dateTime) },
        fields:     { Reversed: "true" },
      }],
    }),
  });

  return { company: company.name, source, tableId: Number(tableId), reversed: true, dateTime };
}

const CS_TABLE = "Cloud Events Storage";

async function toolSetConfig({ source, id, data, encrypt = false, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!source) throw new Error("Parameter 'source' is required");
  if (!id)     throw new Error("Parameter 'id' is required");
  if (data === undefined || data === null) throw new Error("Parameter 'data' is required");

  let dataString = typeof data === "string" ? data : JSON.stringify(data);

  if (encrypt) {
    dataString = toolEncryptData({ plaintext: dataString }).ciphertext;
  }

  const blobValue = Buffer.from(dataString).toString("base64");
  const conn      = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company   = await getCompany(companyId, conn);

  await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     CS_TABLE,
    data:        JSON.stringify({
      mode: "upsert",
      data: [{
        primaryKey: { Source: String(source), Id: String(id) },
        fields:     { Data: blobValue },
      }],
    }),
  });

  return { company: company.name, source, id, encrypted: encrypt, written: 1 };
}

async function toolGetConfig({ source, id, decrypt = false, __allowDecrypt = false, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!source) throw new Error("Parameter 'source' is required");
  if (!id)     throw new Error("Parameter 'id' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify({
      tableName: CS_TABLE,
      tableView: `WHERE(Source=CONST(${source}),Id=CONST(${id}))`,
      skip:      0,
      take:      1,
    }),
  });

  const records = result.result || result.value || [];
  if (!records.length) {
    return { company: company.name, source, id, found: false };
  }

  const blobBase64  = (records[0].fields || {}).Data || "";
  let   rawString   = Buffer.from(blobBase64, "base64").toString("utf8");

  if (decrypt) {
    rawString = toolDecryptData({ ciphertext: rawString }, { allowExternal: __allowDecrypt }).plaintext;
  }

  let parsed;
  try   { parsed = JSON.parse(rawString); }
  catch { parsed = rawString; }

  return { company: company.name, source, id, found: true, encrypted: decrypt, data: parsed };
}

// ── Origo App Range tools ──────────────────────────────────────────────────────

const APP_RANGE_SOURCE = "Origo App Range";

async function toolSaveAppRange({ appId, appName, publisher, idRanges, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!appId)     throw new Error("Parameter 'appId' is required (app.json 'id' GUID)");
  if (!appName)   throw new Error("Parameter 'appName' is required (app.json 'name')");
  if (!publisher) throw new Error("Parameter 'publisher' is required (app.json 'publisher')");
  if (!Array.isArray(idRanges) || !idRanges.length)
    throw new Error("Parameter 'idRanges' is required (array from app.json idRanges)");

  for (const r of idRanges) {
    if (typeof r.from !== "number" || typeof r.to !== "number" || r.from > r.to)
      throw new Error(`Each idRanges entry must have numeric 'from' <= 'to'. Got: ${JSON.stringify(r)}`);
  }

  const data = { appId, appName, publisher, idRanges };
  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const blobValue = Buffer.from(JSON.stringify(data)).toString("base64");
  await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     CS_TABLE,
    data:        JSON.stringify({
      mode: "upsert",
      data: [{
        primaryKey: { Source: APP_RANGE_SOURCE, Id: appId },
        fields:     { Data: blobValue },
      }],
    }),
  });

  return { company: company.name, saved: true, appId, appName, publisher, idRanges };
}

async function toolCheckAppRange({ idRanges, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!Array.isArray(idRanges) || !idRanges.length)
    throw new Error("Parameter 'idRanges' is required (array of { from, to } objects to check)");

  for (const r of idRanges) {
    if (typeof r.from !== "number" || typeof r.to !== "number" || r.from > r.to)
      throw new Error(`Each idRanges entry must have numeric 'from' <= 'to'. Got: ${JSON.stringify(r)}`);
  }

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  // Fetch all stored app ranges
  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     CS_TABLE,
    data:        JSON.stringify({
      tableView: `WHERE(Source=CONST(${APP_RANGE_SOURCE}))`,
      take:      500,
    }),
  });

  const records = result.result || result.value || [];
  const apps = [];
  for (const rec of records) {
    const blob = (rec.fields || {}).Data || "";
    try {
      const parsed = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));
      if (parsed && parsed.idRanges) apps.push(parsed);
    } catch (_) {}
  }

  // Check overlap: two ranges [a,b] and [c,d] overlap when a <= d && c <= b
  const conflicts = [];
  for (const checkRange of idRanges) {
    for (const app of apps) {
      for (const appRange of app.idRanges) {
        if (checkRange.from <= appRange.to && appRange.from <= checkRange.to) {
          conflicts.push({
            checkedRange:  checkRange,
            conflictingApp: { appId: app.appId, appName: app.appName, publisher: app.publisher, conflictingRange: appRange },
          });
        }
      }
    }
  }

  // Build a suggested non-conflicting range if there are conflicts
  // Collect all registered ranges sorted by 'from' and find the first available gap of the same size as the first requested range
  const requestedSize = idRanges[0].to - idRanges[0].from + 1;
  const allRanges = apps.flatMap(a => a.idRanges).sort((a, b) => a.from - b.from);
  let suggestedFrom = null;

  // Start looking from 50000 (reasonable BC custom range start)
  let candidate = 50000;
  for (const r of allRanges) {
    if (candidate + requestedSize - 1 < r.from) { suggestedFrom = candidate; break; }
    candidate = Math.max(candidate, r.to + 1);
  }
  if (suggestedFrom === null) suggestedFrom = candidate;

  const suggestion = conflicts.length > 0
    ? { from: suggestedFrom, to: suggestedFrom + requestedSize - 1, size: requestedSize, note: "First available non-conflicting range of the same size" }
    : null;

  return {
    company:    company.name,
    checked:    idRanges,
    hasConflict: conflicts.length > 0,
    conflicts,
    registeredApps: apps.length,
    suggestion,
  };
}

// ── BC Dev Standards tools (local git / file-system, for local development use) ──

const BC_DEV_STANDARDS_REPO = "https://github.com/OrigoSoftwareSolutions/bc-dev-standards.git";
const GITHUB_API_HOST        = "api.github.com";
const WIN_SHELL              = process.platform === "win32" ? "powershell.exe" : "/bin/bash";

function execGit(command, cwd) {
  return execSync(command, {
    cwd,
    stdio:    "pipe",
    encoding: "utf8",
    shell:    WIN_SHELL,
  }).trim();
}

async function toolCheckStandardsStatus({ githubToken, standardsRepo, claudeDir } = {}) {
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  const appData     = process.env.APPDATA     || "";
  const sep         = process.platform === "win32" ? "\\" : "/";
  const sh          = WIN_SHELL;
  const repoPath    = standardsRepo || (userProfile ? `${userProfile}${sep}bc-dev-standards` : "");
  const claudePath  = claudeDir     || (userProfile ? `${userProfile}${sep}.claude`          : "");

  // ── 1. GitHub Sync ──────────────────────────────────────────────────────────
  let remoteSha = null, remoteMessage = "", githubReachable = false;
  try {
    const ghHeaders = {
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      "User-Agent": "BC-MCP-Server",
      Accept:       "application/vnd.github+json",
    };
    const { statusCode, body: ghBody } = await httpsRequest(
      GITHUB_API_HOST,
      "/repos/OrigoSoftwareSolutions/bc-dev-standards/commits/main",
      "GET", ghHeaders, null,
    );
    if (statusCode < 400) {
      const r      = JSON.parse(ghBody);
      remoteSha    = r.sha || null;
      remoteMessage = (r.commit && r.commit.message) ? r.commit.message.split("\n")[0] : "";
      githubReachable = true;
    }
  } catch (_) { /* unreachable */ }

  // ── 2. Standards repo ───────────────────────────────────────────────────────
  let localSha = null, localMessage = "", repoExists = false, repoIsGit = false;
  try {
    if (repoPath) repoExists = fs.existsSync(repoPath);
    if (repoExists) {
      try {
        localSha     = execGit("git rev-parse HEAD",    repoPath);
        localMessage = execGit("git log -1 --format=%s", repoPath);
        repoIsGit    = true;
      } catch (_) {}
    }
  } catch (_) {}

  const upToDate = (remoteSha && localSha) ? (localSha === remoteSha) : null;

  // ── 3. .claude folder ───────────────────────────────────────────────────────
  let claudeExists = false;
  try { if (claudePath) claudeExists = fs.existsSync(claudePath); } catch (_) {}

  // ── 4. CLAUDE.md sync ───────────────────────────────────────────────────────
  const claudeMdDest = claudePath ? `${claudePath}${sep}CLAUDE.md` : "";
  const claudeMdSrc  = repoPath   ? `${repoPath}${sep}CLAUDE.md`   : "";
  let claudeMdExists = false, claudeMdInSync = false;
  try {
    if (claudeMdDest) claudeMdExists = fs.existsSync(claudeMdDest);
    if (claudeMdExists && claudeMdSrc && fs.existsSync(claudeMdSrc)) {
      const hashA = crypto.createHash("sha256").update(fs.readFileSync(claudeMdDest)).digest("hex");
      const hashB = crypto.createHash("sha256").update(fs.readFileSync(claudeMdSrc)).digest("hex");
      claudeMdInSync = (hashA === hashB);
    }
  } catch (_) {}

  // ── 5. Skills junction ──────────────────────────────────────────────────────
  const junctionPath = claudePath ? `${claudePath}${sep}skills` : "";
  let junctionExists = false, junctionIsLink = false, skillCount = 0;
  try {
    if (junctionPath) {
      const stat = fs.lstatSync(junctionPath);
      junctionExists = true;
      junctionIsLink = stat.isSymbolicLink();
      try {
        skillCount = fs.readdirSync(junctionPath).filter(f => {
          try { return fs.statSync(`${junctionPath}${sep}${f}`).isDirectory(); } catch (_) { return false; }
        }).length;
      } catch (_) {}
    }
  } catch (_) {}

  // ── 6. mcp.json ─────────────────────────────────────────────────────────────
  const mcpJsonPath = appData ? `${appData}\\Code\\User\\mcp.json` : "";
  let mcpExists = false, mcpHasBcOrigo = false;
  let mcpHasEncConn = false, mcpHasGithubToken = false, mcpHasStdRepo = false, mcpHasClaudeDir = false;
  try {
    if (mcpJsonPath && fs.existsSync(mcpJsonPath)) {
      const mcpObj  = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
      mcpExists     = true;
      const servers = mcpObj.servers || {};
      const bcOrigo = servers["bc-origo"] || servers["bc_origo"] || null;
      if (bcOrigo) {
        mcpHasBcOrigo     = true;
        const h           = bcOrigo.headers || {};
        mcpHasEncConn     = !!(h["x-encrypted-conn"]  && String(h["x-encrypted-conn"]).trim());
        mcpHasGithubToken = !!(h["x-github-token"]    && String(h["x-github-token"]).trim());
        mcpHasStdRepo     = !!(h["x-standards-repo"]  && String(h["x-standards-repo"]).trim());
        mcpHasClaudeDir   = !!(h["x-claude-dir"]      && String(h["x-claude-dir"]).trim());
      }
    }
  } catch (_) {}

  // ── 7. Git available ────────────────────────────────────────────────────────
  let gitVersion = null;
  try { gitVersion = execSync("git --version", { stdio: "pipe", encoding: "utf8", shell: sh }).trim(); } catch (_) {}

  // ── 8. Node available ───────────────────────────────────────────────────────
  const nodeVersion = process.version || null;

  // ── Derived status ──────────────────────────────────────────────────────────
  const claudeMdOk    = claudeMdExists && claudeMdInSync;
  const junctionOk    = junctionExists && junctionIsLink;
  const mcpConfigured = mcpHasBcOrigo && mcpHasEncConn && mcpHasGithubToken && mcpHasStdRepo && mcpHasClaudeDir;
  const allGood       = repoExists && repoIsGit && claudeExists && claudeMdOk
                     && junctionOk && mcpConfigured && !!gitVersion
                     && (upToDate === true || (upToDate === null && !githubReachable && repoExists));

  const ck = (v) => v ? "\u2705" : "\u274C";  // ✅ ❌

  let syncIcon, syncStatus;
  if (!githubReachable) { syncIcon = "\u26A0\uFE0F"; syncStatus = "GitHub unreachable — cannot verify sync"; }
  else if (upToDate === null) { syncIcon = "\u26A0\uFE0F"; syncStatus = "Local repo not found — cannot compare"; }
  else if (upToDate)          { syncIcon = "\u2705";       syncStatus = "Up to date"; }
  else                        { syncIcon = "\u26A0\uFE0F"; syncStatus = "Behind — update needed"; }

  const lSha = localSha  ? localSha.slice(0, 7)  : "n/a";
  const rSha = remoteSha ? remoteSha.slice(0, 7)  : "n/a";
  const lMsg = localMessage  ? ` \u2014 ${localMessage.slice(0, 28)}`  : "";
  const rMsg = remoteMessage ? ` \u2014 ${remoteMessage.slice(0, 28)}` : "";

  const W   = 62;
  const bar = (s) => `\u2551${s.padEnd(W)}\u2551`;
  const div = `\u2560${"\u2550".repeat(W)}\u2563`;

  const overallText = allGood
    ? "\u2705 All good"
    : (mcpConfigured && repoExists && claudeExists && junctionOk && claudeMdOk
      ? "\u26A0\uFE0F Action needed"
      : "\u274C Setup required");

  const gitVer  = gitVersion  ? gitVersion.replace("git version ", "").slice(0, 20) : "not found";
  const nodeVer = nodeVersion ? nodeVersion.slice(0, 20) : "not found";

  const lines = [
    `\u2554${"\u2550".repeat(W)}\u2557`,
    bar("        Origo BC Development Environment \u2014 Status"),
    div,
    bar("  GitHub Sync"),
    div,
    bar(`  ${syncIcon}  Sync status            : ${syncStatus}`),
    bar(`  ${ck(!!localSha)}  Local SHA              : ${lSha}${lMsg}`),
    bar(`  ${ck(!!remoteSha)}  Remote SHA             : ${rSha}${rMsg}`),
    div,
    bar("  Local Environment"),
    div,
    bar(`  ${ck(repoExists && repoIsGit)}  Standards repo present`),
    bar(`  ${ck(claudeExists)}  .claude folder exists`),
    bar(`  ${ck(claudeMdOk)}  CLAUDE.md applied and in sync`),
    bar(`  ${ck(junctionOk)}  Skills junction active         : ${skillCount} skills found`),
    bar(`  ${ck(mcpConfigured)}  mcp.json configured`),
    bar(`  ${ck(!!gitVersion)}  Git available                  : ${gitVer}`),
    bar(`  ${ck(!!nodeVersion)}  Node available                 : ${nodeVer}`),
    div,
    bar(`  Overall : ${overallText}`),
    `\u255A${"\u2550".repeat(W)}\u255D`,
  ];

  // ── Next Steps ──────────────────────────────────────────────────────────────
  const nextSteps = [];
  if (!githubReachable) {
    nextSteps.push({ icon: "\u26A0\uFE0F", item: "GitHub could not be reached",
      action: "Check your internet connection and x-github-token in mcp.json" });
  } else if (upToDate === false) {
    nextSteps.push({ icon: "\u26A0\uFE0F", item: "Standards are behind GitHub",
      action: 'Ask Claude: "Update my BC standards"' });
  }
  if (!repoExists)
    nextSteps.push({ icon: "\u274C", item: `Standards repo not found at ${repoPath}`,
      action: 'Ask Claude: "Set up my Origo BC development environment"' });
  if (!claudeExists)
    nextSteps.push({ icon: "\u274C", item: ".claude folder does not exist",
      action: 'Ask Claude: "Set up my Origo BC development environment"' });
  if (claudeMdExists && !claudeMdInSync)
    nextSteps.push({ icon: "\u274C", item: "CLAUDE.md is out of sync with standards repo",
      action: 'Ask Claude: "Update my BC standards"' });
  else if (!claudeMdExists && (repoExists || claudeExists))
    nextSteps.push({ icon: "\u274C", item: "CLAUDE.md is missing from .claude folder",
      action: 'Ask Claude: "Update my BC standards"' });
  if (!junctionOk)
    nextSteps.push({ icon: "\u274C", item: "Skills junction is missing or broken",
      action: 'Ask Claude: "Set up my Origo BC development environment"' });
  if (!mcpExists)
    nextSteps.push({ icon: "\u274C", item: "mcp.json not found",
      action: 'Ask Claude: "Set up my Origo BC development environment"' });
  else if (!mcpHasBcOrigo)
    nextSteps.push({ icon: "\u274C", item: "bc-origo server entry missing from mcp.json",
      action: 'Ask Claude: "Set up my Origo BC development environment"' });
  else {
    if (!mcpHasEncConn)
      nextSteps.push({ icon: "\u274C", item: "x-encrypted-conn missing in mcp.json",
        action: "Add your encrypted connection string to mcp.json \u2192 servers \u2192 bc-origo \u2192 headers \u2192 x-encrypted-conn" });
    if (!mcpHasGithubToken)
      nextSteps.push({ icon: "\u274C", item: "x-github-token missing in mcp.json",
        action: "Add a GitHub fine-grained PAT to mcp.json \u2192 servers \u2192 bc-origo \u2192 headers \u2192 x-github-token" });
    if (!mcpHasStdRepo)
      nextSteps.push({ icon: "\u274C", item: "x-standards-repo missing in mcp.json",
        action: "Add the local path to bc-dev-standards in mcp.json \u2192 servers \u2192 bc-origo \u2192 headers \u2192 x-standards-repo" });
    if (!mcpHasClaudeDir)
      nextSteps.push({ icon: "\u274C", item: "x-claude-dir missing in mcp.json",
        action: "Add the local path to .claude folder in mcp.json \u2192 servers \u2192 bc-origo \u2192 headers \u2192 x-claude-dir" });
  }
  if (!gitVersion)
    nextSteps.push({ icon: "\u274C", item: "git is not available in PATH",
      action: "Install Git for Windows and restart your terminal/IDE" });

  let output = lines.join("\n");
  if (nextSteps.length > 0) {
    output += "\n\nNEXT STEPS";
    for (const step of nextSteps) {
      output += `\n  ${step.icon}  ${step.item}\n      \u2192 ${step.action}\n`;
    }
  } else {
    output += "\n\n  \u2705 Your Origo BC development environment is fully configured and up to date.\n     You are ready to develop BC extensions.";
  }

  return { summary: output };
}

async function toolUpdateBcStandards({ standardsRepo, claudeDir } = {}) {
  if (!standardsRepo) throw new Error("Parameter 'standardsRepo' is required (local path to bc-dev-standards repo)");
  if (!claudeDir)     throw new Error("Parameter 'claudeDir' is required (local path to .claude directory)");

  const beforeSha = execGit("git rev-parse HEAD", standardsRepo);
  execGit("git pull --ff-only", standardsRepo);
  const afterSha  = execGit("git rev-parse HEAD", standardsRepo);

  let commits = [];
  if (beforeSha !== afterSha) {
    const log = execGit(`git log --oneline ${beforeSha}..${afterSha}`, standardsRepo);
    commits = log ? log.split("\n") : [];
  }

  const claudeMdSrc  = `${standardsRepo}\\CLAUDE.md`;
  const claudeMdDest = `${claudeDir}\\CLAUDE.md`;
  fs.copyFileSync(claudeMdSrc, claudeMdDest);

  return {
    beforeSha,
    afterSha,
    updated: beforeSha !== afterSha,
    commits,
    claudeMdCopied: claudeMdDest,
    note: "Skills folder updates automatically via the existing directory junction.",
  };
}

async function toolSetupOrigoEnv({ standardsRepo, claudeDir } = {}) {
  if (!standardsRepo) throw new Error("Parameter 'standardsRepo' is required (local path where bc-dev-standards will be cloned)");
  if (!claudeDir)     throw new Error("Parameter 'claudeDir' is required (local path to .claude directory)");

  const steps = [];

  // 1. Check git
  let gitVersion;
  try {
    gitVersion = execSync("git --version", { stdio: "pipe", encoding: "utf8", shell: WIN_SHELL }).trim();
    steps.push({ step: "Check git", status: "✅", detail: gitVersion });
  } catch (e) {
    steps.push({ step: "Check git", status: "❌", detail: e.message });
    return { steps, success: false, error: "git is not available in PATH — install Git for Windows and retry." };
  }

  // 2. Clone or pull bc-dev-standards
  if (!fs.existsSync(standardsRepo)) {
    try {
      execSync(`git clone ${BC_DEV_STANDARDS_REPO} "${standardsRepo}"`, { stdio: "pipe", encoding: "utf8", shell: WIN_SHELL });
      steps.push({ step: "Clone bc-dev-standards", status: "✅", detail: `Cloned to ${standardsRepo}` });
    } catch (e) {
      steps.push({ step: "Clone bc-dev-standards", status: "❌", detail: e.message });
      return { steps, success: false };
    }
  } else {
    try {
      execGit("git pull --ff-only", standardsRepo);
      steps.push({ step: "Pull bc-dev-standards", status: "✅", detail: `Updated at ${standardsRepo}` });
    } catch (e) {
      steps.push({ step: "Pull bc-dev-standards", status: "❌", detail: e.message });
    }
  }

  // 3. Create claudeDir if absent
  if (!fs.existsSync(claudeDir)) {
    try {
      fs.mkdirSync(claudeDir, { recursive: true });
      steps.push({ step: "Create .claude directory", status: "✅", detail: `Created ${claudeDir}` });
    } catch (e) {
      steps.push({ step: "Create .claude directory", status: "❌", detail: e.message });
      return { steps, success: false };
    }
  } else {
    steps.push({ step: "Create .claude directory", status: "✅", detail: `Already exists: ${claudeDir}` });
  }

  // 4. Copy CLAUDE.md
  const claudeMdSrc  = `${standardsRepo}\\CLAUDE.md`;
  const claudeMdDest = `${claudeDir}\\CLAUDE.md`;
  try {
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
    steps.push({ step: "Copy CLAUDE.md", status: "✅", detail: `${claudeMdSrc} → ${claudeMdDest}` });
  } catch (e) {
    steps.push({ step: "Copy CLAUDE.md", status: "❌", detail: e.message });
  }

  // 5. Create junction: claudeDir\skills → standardsRepo\skills
  const junctionLink   = `${claudeDir}\\skills`;
  const junctionTarget = `${standardsRepo}\\skills`;
  try {
    if (fs.existsSync(junctionLink)) {
      if (process.platform === "win32") {
        execSync(`Remove-Item -Path "${junctionLink}" -Force -Recurse`, { stdio: "pipe", encoding: "utf8", shell: WIN_SHELL });
      } else {
        execSync(`rm -rf "${junctionLink}"`, { stdio: "pipe", encoding: "utf8", shell: WIN_SHELL });
      }
    }
    if (process.platform === "win32") {
      execSync(`New-Item -ItemType Junction -Path "${junctionLink}" -Target "${junctionTarget}"`, { stdio: "pipe", encoding: "utf8", shell: WIN_SHELL });
    } else {
      execSync(`ln -s "${junctionTarget}" "${junctionLink}"`, { stdio: "pipe", encoding: "utf8", shell: WIN_SHELL });
    }
    steps.push({ step: "Create skills junction", status: "✅", detail: `${junctionLink} → ${junctionTarget}` });
  } catch (e) {
    steps.push({ step: "Create skills junction", status: "❌", detail: e.message });
  }

  return { steps, success: steps.every(s => s.status === "✅") };
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
    name:        "call_message_type",
    description: "Calls any Cloud Event message type supported by Business Central. Use list_message_types to discover available types, and get_message_type_help to understand the request schema and interpret the response before calling this tool.",
    inputSchema: {
      type:       "object",
      properties: {
        type:    { type: "string",  description: "Message type name (e.g. 'Sales.Order.Statistics', 'Customer.Create'). Use list_message_types to find available types." },
        subject: { type: "string",  description: "Cloud Event subject field — typically the document number, customer number, or identifier. See get_message_type_help for what each type expects." },
        data:    { type: "object",  description: "Optional data payload as a JSON object. See get_message_type_help for the exact fields and structure required by each message type." },
        lcid:    { type: "integer", description: "Language LCID for captions in the response (default 1033 = English, 1039 = Icelandic)." },
      },
      required: ["type"],
    },
  },
  {
    name:        "get_record_count",
    description: "Returns the total number of records in a Business Central table (optionally filtered). Uses take:1 + fieldNumbers:[1] so only a single minimal record is fetched; the count comes from the noOfRecords field in the BC response.",
    inputSchema: {
      type:       "object",
      properties: {
        table:  { type: "string", description: "BC table name (e.g. 'Customer', 'G/L Account')." },
        filter: { type: "string", description: "Optional BC tableView filter, e.g. \"WHERE(Blocked=CONST( ))\"." },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_decimal_total",
    description: "Returns the aggregated total for a decimal field in a Business Central table using Data.Totals.Get. Supports optional tableView filtering.",
    inputSchema: {
      type:       "object",
      properties: {
        table:        { type: "string", description: "BC table name (e.g. 'Customer', 'G/L Entry', 'Sales Line')." },
        decimalField: { type: "string", description: "Decimal field to total. Accepts BC field name (e.g. 'Amount') or field number as text (e.g. '15')." },
        filter:       { type: "string", description: "Optional BC tableView filter, e.g. \"WHERE(Posting Date=FILTER(>=2026-01-01&<=2026-12-31))\"." },
      },
      required: ["table", "decimalField"],
    },
  },
  {
    name:        "get_sales_order_statistics",
    description: "Returns comprehensive statistics for a sales order (amounts, VAT totals, quantities, weight and volume) using the Sales.Order.Statistics Cloud Event message type. Equivalent to page 402 'Sales Order Statistics' in Business Central.",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Sales order number (e.g. '101016')." },
      },
      required: ["orderNo"],
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
    name:        "get_integration_timestamp",
    description: "Returns the latest non-reversed Date & Time entry from the Cloud Events Integration table for a given source + tableId combination. Returns null if no entry exists.",
    inputSchema: {
      type:       "object",
      properties: {
        source:  { type: "string",  description: "Integration source name (e.g. 'MyApp')." },
        tableId: { type: "integer", description: "BC table number (e.g. 18 for Customer)." },
      },
      required: ["source", "tableId"],
    },
  },
  {
    name:        "set_integration_timestamp",
    description: "Inserts a new Date & Time entry into the Cloud Events Integration table for a given source + tableId. Use this to record the timestamp of a completed integration run.",
    inputSchema: {
      type:       "object",
      properties: {
        source:   { type: "string", description: "Integration source name." },
        tableId:  { type: "integer", description: "BC table number." },
        dateTime: { type: "string",  description: "ISO 8601 timestamp to record (e.g. '2026-03-17T12:00:00Z')." },
      },
      required: ["source", "tableId", "dateTime"],
    },
  },
  {
    name:        "reverse_integration_timestamp",
    description: "Marks the latest non-reversed Cloud Events Integration entry for a given source + tableId as reversed (Reversed = true). Use to invalidate the current timestamp so the next sync re-processes from the previous one.",
    inputSchema: {
      type:       "object",
      properties: {
        source:  { type: "string",  description: "Integration source name." },
        tableId: { type: "integer", description: "BC table number." },
      },
      required: ["source", "tableId"],
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
  {
    name:        "save_app_range",
    description: "Saves a BC extension app's ID range information to the Cloud Events Storage table (source = 'Origo App Range'). Stores the app id, name, publisher and idRanges from app.json. Uses upsert semantics keyed on the app id.",
    inputSchema: {
      type:       "object",
      properties: {
        appId:     { type: "string",  description: "The app GUID from app.json 'id' field. Used as the storage key." },
        appName:   { type: "string",  description: "The app name from app.json 'name' field." },
        publisher: { type: "string",  description: "The publisher from app.json 'publisher' field." },
        idRanges:  { type: "array",   description: "The idRanges array from app.json, e.g. [{\"from\": 65300, \"to\": 65399}].", items: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } }, required: ["from", "to"] } },
      },
      required: ["appId", "appName", "publisher", "idRanges"],
    },
  },
  {
    name:        "check_app_range",
    description: "Checks whether a given set of BC object ID ranges conflicts with any app ranges already registered in the Cloud Events Storage table (source = 'Origo App Range'). Returns a list of conflicting apps and suggests the first available non-conflicting range of the same size.",
    inputSchema: {
      type:       "object",
      properties: {
        idRanges: { type: "array", description: "The ID ranges to check, e.g. [{\"from\": 65300, \"to\": 65399}].", items: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } }, required: ["from", "to"] } },
      },
      required: ["idRanges"],
    },
  },
  {
    name:        "set_config",
    description: "Writes a JSON configuration object to the Cloud Events Storage table (Source + Id primary key). Uses upsert semantics — creates a new record or updates the existing one. Optionally encrypts the data with the server-side AES-256-GCM key before storing.",
    inputSchema: {
      type:       "object",
      properties: {
        source:  { type: "string",  description: "Logical namespace / application name (e.g. 'BC Portal')." },
        id:      { type: "string",  description: "Record identifier — any string or GUID." },
        data:    { description: "The configuration to store. Can be a JSON object or a plain string." },
        encrypt: { type: "boolean", description: "When true, encrypts the data with the server-side MCP_ENCRYPTION_KEY before storing. Default false." },
      },
      required: ["source", "id", "data"],
    },
  },
  {
    name:        "get_config",
    description: "Reads a JSON configuration object from the Cloud Events Storage table by Source + Id. Returns { found: false } when the record does not exist. Optionally decrypts the stored value with the server-side AES-256-GCM key.",
    inputSchema: {
      type:       "object",
      properties: {
        source:  { type: "string",  description: "Logical namespace / application name (e.g. 'BC Portal')." },
        id:      { type: "string",  description: "Record identifier — any string or GUID." },
        decrypt: { type: "boolean", description: "When true, decrypts the stored BLOB with the server-side MCP_ENCRYPTION_KEY before returning. Default false." },
      },
      required: ["source", "id"],
    },
  },
  {
    name:        "encrypt_data",
    description: "Encrypts a plaintext string using AES-256-GCM with the server-side MCP_ENCRYPTION_KEY. Returns a self-contained base64 ciphertext that includes the IV and authentication tag. Safe for strings up to tens of thousands of characters.",
    inputSchema: {
      type:       "object",
      properties: {
        plaintext: { type: "string", description: "The string to encrypt." },
      },
      required: ["plaintext"],
    },
  },
  {
    name:        "decrypt_data",
    description: "Decrypts a base64 ciphertext string previously produced by encrypt_data. Uses the server-side MCP_ENCRYPTION_KEY. Restricted to callers coming from websites on the same host as the MCP endpoint.",
    inputSchema: {
      type:       "object",
      properties: {
        ciphertext: { type: "string", description: "The base64 ciphertext produced by encrypt_data." },
      },
      required: ["ciphertext"],
    },
  },
  {
    name:        "check_standards_status",
    description: "Check the Origo BC development standards GitHub sync status and verify the full local environment setup including .claude folder, CLAUDE.md, skills junction, and mcp.json configuration",
    inputSchema: {
      type:       "object",
      properties: {
        githubToken:   { type: "string", description: "GitHub fine-grained PAT for the bc-dev-standards repo. Falls back to the x-github-token request header." },
        standardsRepo: { type: "string", description: "Local path to the cloned bc-dev-standards repository. Falls back to x-standards-repo header or %USERPROFILE%\\bc-dev-standards." },
        claudeDir:     { type: "string", description: "Local path to the .claude directory. Falls back to x-claude-dir header or %USERPROFILE%\\.claude." },
      },
    },
  },
  {
    name:        "update_bc_standards",
    description: "Pulls the latest changes from the bc-dev-standards GitHub repository and copies CLAUDE.md to the .claude directory. Reports the before and after commit SHAs and all commit messages applied. The skills folder updates automatically via the existing directory junction. Run setup_origo_bc_environment first if the repo is not yet cloned.",
    inputSchema: {
      type:       "object",
      properties: {
        standardsRepo: { type: "string", description: "Local path to the cloned bc-dev-standards repository. Falls back to the x-standards-repo request header." },
        claudeDir:     { type: "string", description: "Local path to the .claude directory (e.g. C:\\Users\\you\\.claude). Falls back to the x-claude-dir request header." },
      },
      required: ["standardsRepo", "claudeDir"],
    },
  },
  {
    name:        "setup_origo_bc_environment",
    description: "One-time setup: verifies git is in PATH, clones or updates bc-dev-standards to the given local path, creates the .claude directory, copies CLAUDE.md, and creates a directory junction from .claude\\skills to bc-dev-standards\\skills. Returns a step-by-step ✅/❌ status summary. Must be run with the MCP server running locally.",
    inputSchema: {
      type:       "object",
      properties: {
        standardsRepo: { type: "string", description: "Local path where bc-dev-standards will be cloned or updated (e.g. C:\\Users\\you\\bc-dev-standards). Falls back to the x-standards-repo request header." },
        claudeDir:     { type: "string", description: "Local path to the .claude directory (e.g. C:\\Users\\you\\.claude). Falls back to the x-claude-dir request header." },
      },
      required: ["standardsRepo", "claudeDir"],
    },
  },
];

// ── JSON-RPC 2.0 dispatcher ────────────────────────────────────────────────────

async function handleMessage(msg, { headerEncryptedConn = "", headerCompanyId = "", headerGithubToken = "", headerStandardsRepo = "", headerClaudeDir = "", allowDecrypt = false } = {}) {
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

      case "tools/list": {
        const coProp   = { type: "string", description: "Target company: BC company GUID or exact company name. Omit to use the server default company." };
        const connProps = {
          tenantId:     { type: "string", description: "BC tenant ID (GUID). Falls back to the server's BC_TENANT_ID env var." },
          clientId:     { type: "string", description: "Azure AD application (client) ID. Falls back to BC_CLIENT_ID." },
          clientSecret: { type: "string", description: "Azure AD client secret. Falls back to BC_CLIENT_SECRET." },
          environment:  { type: "string", description: "BC environment name (default 'production'). Falls back to BC_ENVIRONMENT." },
          encryptedConn: { type: "string", description: "Base64 ciphertext from encrypt_data containing a JSON object with tenantId, clientId, clientSecret, and optionally environment. Overridden by any explicit credential params above." },
        };
        const toolsOut = TOOLS.map(t => {
          const extraProps = t.name === "list_companies"
            ? connProps
            : { companyId: coProp, ...connProps };
          return { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...extraProps } } };
        });
        return { jsonrpc: "2.0", id, result: { tools: toolsOut } };
      }

      case "tools/call": {
        const toolName = (params || {}).name;
        const args     = (params || {}).arguments || {};
        args.__allowDecrypt = !!allowDecrypt;
        // Inject header-provided defaults as workspace-level fallbacks
        // (per-call arguments always take priority).
        if (headerEncryptedConn  && !args.encryptedConn)  args.encryptedConn  = headerEncryptedConn;
        if (headerCompanyId    && !args.companyId)    args.companyId    = headerCompanyId;
        if (headerGithubToken  && !args.githubToken)  args.githubToken  = headerGithubToken;
        if (headerStandardsRepo && !args.standardsRepo) args.standardsRepo = headerStandardsRepo;
        if (headerClaudeDir    && !args.claudeDir)    args.claudeDir    = headerClaudeDir;
        let content;

        switch (toolName) {
          case "list_tables":        content = await toolListTables(args);        break;
          case "get_table_info":     content = await toolGetTableInfo(args);      break;
          case "get_table_fields":   content = await toolGetTableFields(args);    break;
          case "list_companies":        content = await toolListCompanies(args);              break;
          case "list_message_types":    content = await toolListMessageTypes(args);       break;
          case "get_message_type_help": content = await toolGetMessageTypeHelp(args);     break;
          case "call_message_type":     content = await toolCallMessageType(args);         break;
          case "get_record_count":            content = await toolGetRecordCount(args);            break;
          case "get_decimal_total":           content = await toolGetDecimalTotal(args);           break;
          case "get_sales_order_statistics":  content = await toolGetSalesOrderStatistics(args);   break;
          case "get_records":           content = await toolGetRecords(args);              break;
          case "set_records":           content = await toolSetRecords(args);              break;
          case "search_customers":      content = await toolSearchCustomers(args);        break;
          case "search_items":       content = await toolSearchItems(args);       break;
          case "list_translations":            content = await toolListTranslations(args);            break;
          case "set_translations":             content = await toolSetTranslations(args);             break;
          case "get_integration_timestamp":     content = await toolGetIntegrationTimestamp(args);     break;
          case "set_integration_timestamp":     content = await toolSetIntegrationTimestamp(args);     break;
          case "reverse_integration_timestamp": content = await toolReverseIntegrationTimestamp(args); break;
          case "save_app_range":                content = await toolSaveAppRange(args);                break;
          case "check_app_range":               content = await toolCheckAppRange(args);               break;
          case "set_config":                    content = await toolSetConfig(args);                    break;
          case "get_config":                    content = await toolGetConfig(args);                    break;
          case "encrypt_data":                  content = toolEncryptData(args);                       break;
          case "decrypt_data":                  content = toolDecryptData(args, { allowExternal: !!allowDecrypt }); break;
          case "check_standards_status":        content = await toolCheckStandardsStatus(args);        break;
          case "update_bc_standards":           content = await toolUpdateBcStandards(args);           break;
          case "setup_origo_bc_environment":    content = await toolSetupOrigoEnv(args);               break;
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
        "Access-Control-Allow-Headers": "Content-Type, x-encrypted-conn, x-company-id, x-github-token, x-standards-repo, x-claude-dir",
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

  // Read per-workspace defaults from request headers.
  // Set in mcp.json → headers → "x-encrypted-conn" / "x-company-id" / "x-github-token" etc.
  const headerEncryptedConn  = req.headers["x-encrypted-conn"]  || "";
  const headerCompanyId      = req.headers["x-company-id"]      || "";
  const headerGithubToken    = req.headers["x-github-token"]    || "";
  const headerStandardsRepo  = req.headers["x-standards-repo"]  || "";
  const headerClaudeDir      = req.headers["x-claude-dir"]      || "";
  const allowDecrypt         = isTrustedDecryptCaller(req);

  const body = req.body;
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  // Batch request (array of messages)
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(msg => handleMessage(msg, { headerEncryptedConn, headerCompanyId, headerGithubToken, headerStandardsRepo, headerClaudeDir, allowDecrypt })))).filter((r) => r !== null);
    context.res = { status: 200, headers: corsHeaders, body: JSON.stringify(responses) };
    return;
  }

  const response = await handleMessage(body, { headerEncryptedConn, headerCompanyId, headerGithubToken, headerStandardsRepo, headerClaudeDir, allowDecrypt });
  if (response === null) {
    // Notification — acknowledge with 202, no body
    context.res = { status: 202, headers: { "Access-Control-Allow-Origin": "*" } };
    return;
  }

  context.res = { status: 200, headers: corsHeaders, body: JSON.stringify(response) };
};
