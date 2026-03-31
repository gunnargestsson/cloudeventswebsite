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
 *   get_table_fields   — Help.Fields.Get + Help.Permissions.Get — fields for one table (json or markdown), includes hasTableRelation indicator
 *   get_table_relations — Help.TableRelations.Get — foreign-key / conditional relations for a specific field in a table
 *   list_companies     — /api/v2.0/companies — all companies in the BC environment
 *   list_message_types — Help.MessageTypes.Get — all Cloud Event message types
 *   get_message_type_help — Help.Implementation.Get — full implementation guide (markdown) for one message type
 *   get_records        — Data.Records.Get — records from any table with filter/paging/date range
 *   set_records        — Data.Records.Set — create / modify / delete / upsert records in any table (pre-flight: write permission + ChangeLog Write Guard check per field; force never used)
 *   search_customers   — Data.Records.Get — customer lookup by name or number
 *   search_items       — Data.Records.Get — item lookup by description or number
 *   search_records     — Data.Records.Get — generic search across any readable table by a code field and/or a name/description field
 *   list_translations  — Cloud Event Translation — list UI translations (filter by source/lcid)
 *   set_translations   — Cloud Event Translation — upsert UI translation pairs
 *   get_record_count             — Data.Records.Get (take:1, field 1 only) — total record count for any table with optional filter
 *   get_decimal_total            — Data.Totals.Get — sum one decimal field across records in any table with optional filter
 *   get_sales_order_statistics  — Sales.Order.Statistics — amounts, VAT totals, quantities for a sales order
 *   get_record_ids              — Data.RecordIds.Get — SystemId + SystemModifiedAt for incremental sync
 *   get_csv_records             — CSV.Records.Get — export all matching records as a UTF-8 CSV (Open Mirroring format)
 *   get_deleted_records         — Deleted.Records.Get — full record snapshots from the Cloud Events Delete Log
 *   get_deleted_record_ids      — Deleted.RecordIds.Get — lightweight deletion log: id + deletedAt per deleted record
 *   get_csv_deleted_records     — CSV.DeletedRecords.Get — deleted-record audit log as a UTF-8 CSV
 *   get_table_permissions       — Help.Permissions.Get — read/write permissions for a table
 *   get_customer_credit_limit   — Customer.CreditLimit.Get — balance, outstanding, credit limit, remaining credit
 *   get_customer_sales_history  — Customer.SalesHistory.Get — items sold to a customer within a date range
 *   get_item_availability       — Item.Availability.Get — inventory or projected availability per location
 *   get_item_price              — Item.Price.Get — price list lines for an item
 *   release_sales_order         — Sales.Order.Release — release a sales order
 *   reopen_sales_order          — Sales.Order.Reopen — reopen a released sales order
 *   post_sales_order            — Sales.Order.Post — post a sales order, returns posted invoice no.
 *   get_sales_document_pdf      — Sales.SalesInvoice.Pdf / Sales.SalesShipment.Pdf / Sales.SalesCreditMemo.Pdf / Sales.ReturnReceipt.Pdf — downloads PDF from BC and returns pdfBase64
 *   get_customer_statement_pdf  — Customer.Statement.Pdf — downloads PDF from BC and returns pdfBase64
 *   get_purchase_order_statistics — Purchase.Order.Statistics — amounts, VAT totals for a purchase order
 *   release_purchase_order      — Purchase.Order.Release — release a purchase order
 *   reopen_purchase_order       — Purchase.Order.Reopen — reopen a released purchase order
 *   post_purchase_order         — Purchase.Order.Post — post a purchase order, returns posted invoice no.
 *   check_general_journal       — Finance.GeneralJournal.Check — validate a general journal batch without posting
 *   post_general_journal        — Finance.GeneralJournal.Post — post a general journal batch and return G/L register details
 *   call_message_type  — any Cloud Event type — generic caller: send any message type with subject + data; use get_message_type_help first to understand the schema
 *   get_integration_timestamp   — Cloud Events Integration — latest non-reversed DateTime for source+tableId
 *   set_integration_timestamp   — Cloud Events Integration — insert a DateTime entry for source+tableId
 *   reverse_integration_timestamp — Cloud Events Integration — mark the latest non-reversed entry as reversed
 *   get_changelog_field_history — ChangeLog.Field.History — current value + modification history for a field on a record (entry 0 = live value)
 *   restore_changelog_field     — ChangeLog.Field.Restore — restore a field to a prior Change Log value (by entry no. or point-in-time)
 *   changelog_field_enabled     — ChangeLog.Field.Enabled — check if a field is Change Log tracked and return ChangeLog Write Guard mode
 *
 * Resources: bc://companies, bc://message-types, bc://tables, bc://tables/{name}
 * Prompts:   describe_table, find_tables_for_entity, data_model_overview,
 *            sales_order_creation_workflow, customer_lookup_pattern, item_lookup_pattern,
 *            implement_message_type
 *
 *   encrypt_data   — AES-256-GCM symmetric encryption using server-side MCP_ENCRYPTION_KEY
 *   decrypt_data   — AES-256-GCM symmetric decryption using server-side MCP_ENCRYPTION_KEY
 *   check_standards_status  — full Origo BC environment check: GitHub sync + local repo, .claude, CLAUDE.md, skills junction, pr-gateway junction, mcp.json, git, node
 *   update_bc_standards     — pull latest bc-dev-standards and copy CLAUDE.md to .claude
 *   setup_origo_bc_environment — one-time setup: clone repo, create .claude, copy CLAUDE.md, create skills and pr-gateway junctions
 *   save_app_range          — upsert a BC extension's app id/name/publisher/idRanges into Cloud Events Storage (Source = Publisher-Name, Id = app.id)
 *   check_app_range         — verify a set of BC object ID ranges against all registered apps; reports conflicts and suggests a free range
 *   read_app_json           — reads app.json from a BC extension project and returns its contents including ID ranges
 *   update_app_json_ranges  — updates the idRanges field in app.json and saves it (with optional backup)
 *   prepare_for_pull_request — full PR readiness check: app range sync, skill-driven code analysis, copilot rules validation, documentation completeness (README/CHANGELOG in repo root). Does not perform git operations.
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

function httpsRequest(hostname, path, method, headers, body, encoding = "utf8") {
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
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString(encoding) }));
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
  // Use latin1 encoding so binary PDF bytes (and any other non-UTF-8 content) are preserved
  // as-is. JSON responses are all-ASCII so JSON.parse still works correctly.
  const { body: resultRaw } = await httpsRequest(
    url.hostname, url.pathname + url.search, "GET",
    { Authorization: auth },
    null,
    "latin1",
  );
  let result;
  try {
    result = JSON.parse(resultRaw);
  } catch {
    // Response is plain text / binary — return as-is
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
      ["#", "Name", "JSON Key", "Caption", "Type", "Len", "Class", "PK", "Rel"],
      fields.map(f => [f.id, f.name, f.jsonName, f.caption, f.type, f.len || "", f.class || "", f.isPartOfPrimaryKey ? "✓" : "", f.hasTableRelation ? "✓" : ""]),
    );
    return { company: company.name, table: String(table), permissions, fieldCount: fields.length, markdown: md };
  }

  return { company: company.name, table: String(table), permissions, fieldCount: fields.length, fields };
}

async function toolGetTableRelations({ table, fieldId, fieldName, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");
  validateTableName(table);
  if (fieldId == null && !fieldName) throw new Error("Either 'fieldId' or 'fieldName' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table) };
  if (fieldId != null) data.fieldId = Number(fieldId);
  else                 data.fieldName = String(fieldName);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Help.TableRelations.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  return {
    company:       company.name,
    tableId:       result.tableId,
    tableName:     result.tableName,
    relationCount: result.relationCount || (result.relations || []).length,
    relations:     result.relations || [],
  };
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

async function toolGetRecords({ table, filter, fields, startDateTime, endDateTime, skip = 0, take = 50, lcid = 1033, format = "json", companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
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
  if (filter)        data.tableView     = String(filter);
  if (startDateTime) data.startDateTime = String(startDateTime);
  if (endDateTime)   data.endDateTime   = String(endDateTime);
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

// ── ChangeLog Write Guard pre-flight check ────────────────────────────────────
// Enforces the BC ChangeLog Write Guard before any Data.Records.Set call.
// Steps:
//   1. Check the first field to discover whether the write guard is active.
//   2. If guard is OFF  → return immediately (all writes allowed).
//   3. If guard is ON   → fetch full field metadata so jsonName can be resolved
//                         to a stable fieldNo, then check every unique field in
//                         parallel using fieldNo (avoids name-normalization edge
//                         cases with special characters).
//   4. If any field is not covered → throw a descriptive error.
// The force parameter is never used — the MCP server intentionally has no
// mechanism to bypass the write guard.

async function checkWriteGuard(table, fieldJsonNames, conn, companyId) {
  if (!fieldJsonNames.length) return; // nothing to check (delete mode)

  // --- Step 1: probe the first field to read the write guard flag -----------
  let firstResult;
  try {
    firstResult = await bcTask(conn, companyId, {
      specversion: "1.0",
      type:        "ChangeLog.Field.Enabled",
      source:      "BC Metadata MCP v1.0",
      data:        JSON.stringify({ tableName: String(table), fieldName: fieldJsonNames[0] }),
    });
  } catch (_) {
    // Table not found or field unresolvable — skip guard check; BC will
    // enforce its own guards when the actual write is attempted.
    return;
  }

  if (!firstResult.changelogWriteGuardEnabled) return; // guard is OFF — all clear

  // --- Step 2: guard is ON — resolve jsonName → fieldNo via Help.Fields.Get --
  let fieldMeta;
  try {
    fieldMeta = await bcTask(conn, companyId, {
      specversion: "1.0",
      type:        "Help.Fields.Get",
      source:      "BC Metadata MCP v1.0",
      data:        JSON.stringify({ tableName: String(table) }),
      lcid:        1033,
    });
  } catch (_) {
    throw new Error(
      `Write blocked by ChangeLog Write Guard on table '${table}': ` +
      `unable to verify field coverage because field metadata could not be retrieved. ` +
      `Contact your BC administrator or use 'changelog_field_enabled' to investigate.`
    );
  }

  const allFields = fieldMeta.result || fieldMeta.value || fieldMeta.fields || (Array.isArray(fieldMeta) ? fieldMeta : []);

  // Build jsonName → fieldNo map (also add exact name match as fallback)
  const jsonNameToNo = {};
  for (const f of allFields) {
    if (f.jsonName) jsonNameToNo[f.jsonName] = f.id;
    if (f.name && !jsonNameToNo[f.name]) jsonNameToNo[f.name] = f.id;
  }

  // --- Step 3: check every unique field in parallel using fieldNo -----------
  const checks = await Promise.all(
    fieldJsonNames.map(async (fn) => {
      const fieldNo = jsonNameToNo[fn];
      if (!fieldNo) {
        // jsonName could not be mapped to a known field → treat as uncovered
        return { fieldJsonName: fn, fieldNo: null, fieldCovered: false, fieldName: fn };
      }
      try {
        const res = await bcTask(conn, companyId, {
          specversion: "1.0",
          type:        "ChangeLog.Field.Enabled",
          source:      "BC Metadata MCP v1.0",
          data:        JSON.stringify({ tableName: String(table), fieldNo }),
        });
        return { fieldJsonName: fn, fieldNo, fieldCovered: res.fieldCovered, fieldName: res.fieldName || fn };
      } catch (_) {
        return { fieldJsonName: fn, fieldNo, fieldCovered: false, fieldName: fn };
      }
    })
  );

  const uncovered = checks.filter(c => !c.fieldCovered);
  if (uncovered.length > 0) {
    const details = uncovered
      .map(c => c.fieldName !== c.fieldJsonName ? `${c.fieldJsonName} (${c.fieldName})` : c.fieldJsonName)
      .join(", ");
    throw new Error(
      `Write blocked by ChangeLog Write Guard: field(s) [${details}] on table '${table}' ` +
      `are not covered by Change Log modification tracking. ` +
      `When the write guard is active, every field written via Data.Records.Set must be covered. ` +
      `Use 'changelog_field_enabled' to check coverage, or ask your BC administrator to add the ` +
      `field(s) to Change Log Setup.`
    );
  }
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

  // --- Write permission check -----------------------------------------------
  const permsResult = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Help.Permissions.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
  }).catch(() => null);

  if (permsResult) {
    const rawPerms = permsResult.permissions || permsResult;
    const canWrite = !!(rawPerms.write ?? rawPerms.writePermission);
    if (!canWrite) {
      throw new Error(
        `Write permission denied: the current user does not have write access to table '${table}'. ` +
        `Use 'get_table_fields' to verify permissions before writing.`
      );
    }
  }

  // --- ChangeLog Write Guard check ------------------------------------------
  // Collect every unique field jsonName being written across all records.
  // Delete mode has no field values to check.
  if (mode !== "delete") {
    const fieldJsonNames = [...new Set(data.flatMap(rec => Object.keys(rec.fields || {})))];
    await checkWriteGuard(table, fieldJsonNames, conn, company.id);
  }

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

// ── Multi-field search engine ──────────────────────────────────────────────────
// Searches N fields in parallel using Data.RecordIds.Get, deduplicates SystemIds
// (capped at 100), then fetches full records in a single Data.Records.Get call.

function escapeBcFilter(q) {
  return String(q).replace(/[*|&<>='"/\\()@]/g, "?");
}

async function multiFieldSearch({ tableName, query, searchFields, fieldNumbers, baseFilter, conn, companyId }) {
  const escaped = escapeBcFilter(query);
  if (!escaped.trim()) return [];

  // Fire parallel RecordIds.Get — one per search field
  const idRequests = searchFields.map(fieldName =>
    bcTask(conn, companyId, {
      specversion: "1.0",
      type:        "Data.RecordIds.Get",
      source:      "BC Metadata MCP v1.0",
      data:        JSON.stringify({
        tableName,
        tableView: baseFilter
          ? `WHERE(${baseFilter},${fieldName}=FILTER(@*${escaped}*))`
          : `WHERE(${fieldName}=FILTER(@*${escaped}*))`,
        take: 2000,
      }),
    }).catch(() => ({ result: [] }))
  );

  const results = await Promise.all(idRequests);

  // Collect unique SystemIds — cap at 100
  const idSet = new Set();
  for (const res of results) {
    for (const rec of (res.result || [])) {
      if (rec.id) {
        idSet.add(rec.id);
        if (idSet.size >= 100) break;
      }
    }
    if (idSet.size >= 100) break;
  }

  if (idSet.size === 0) return [];

  // Fetch full records by System Id
  const ids = [...idSet];
  const fetchData = {
    tableName,
    tableView: `WHERE(System Id=FILTER(${ids.join("|")}))`,
    take: ids.length,
  };
  if (fieldNumbers) fetchData.fieldNumbers = fieldNumbers;

  const res = await bcTask(conn, companyId, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(fetchData),
  });

  return res.result || res.value || [];
}

// ── Tier 1 search tools ────────────────────────────────────────────────────────

async function toolSearchCustomers({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Customer",
    query,
    searchFields: ["No.", "Name", "Address", "Post Code", "City", "Registration No.", "Contact", "Phone No.", "E-Mail"],
    fieldNumbers: [1, 2, 5, 7, 8, 9, 23, 35, 86, 91, 102],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, customers: records.slice(0, take) };
}

async function toolSearchItems({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Item",
    query,
    searchFields: ["No.", "Description", "Description 2", "Vendor Item No.", "Base Unit of Measure", "Item Category Code"],
    fieldNumbers: [1, 3, 4, 8, 18, 21, 54, 5702, 5704],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, items: records.slice(0, take) };
}

async function toolSearchVendors({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Vendor",
    query,
    searchFields: ["No.", "Name", "Address", "Post Code", "City", "Phone No.", "Contact", "VAT Registration No."],
    fieldNumbers: [1, 2, 5, 7, 9, 22, 39, 54, 86, 91],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, vendors: records.slice(0, take) };
}

async function toolSearchContacts({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Contact",
    query,
    searchFields: ["No.", "Name", "Company Name", "Phone No.", "Mobile Phone No.", "E-Mail", "City", "Post Code"],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, contacts: records.slice(0, take) };
}

async function toolSearchEmployees({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Employee",
    query,
    searchFields: ["First Name", "Middle Name", "Last Name", "Job Title", "Phone No.", "Mobile Phone No.", "E-Mail", "Company E-Mail"],
    baseFilter:   "Status=CONST(Active)",
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, employees: records.slice(0, take) };
}

// ── Tier 2 search tools ────────────────────────────────────────────────────────

async function toolSearchGlAccounts({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "G/L Account",
    query,
    searchFields: ["No.", "Name", "Search Name", "Account Category"],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, accounts: records.slice(0, take) };
}

async function toolSearchBankAccounts({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Bank Account",
    query,
    searchFields: ["No.", "Name", "Bank Account No.", "IBAN", "Bank Branch No."],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, bankAccounts: records.slice(0, take) };
}

async function toolSearchResources({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Resource",
    query,
    searchFields: ["No.", "Name", "Type", "Resource Group No.", "Base Unit of Measure"],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, resources: records.slice(0, take) };
}

async function toolSearchFixedAssets({ query, take = 50, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!query) throw new Error("Parameter 'query' is required");
  take = Math.min(Number(take) || 50, 100);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const records = await multiFieldSearch({
    tableName:    "Fixed Asset",
    query,
    searchFields: ["No.", "Description", "Serial No.", "FA Class Code", "FA Subclass Code", "FA Location Code"],
    conn,
    companyId:    company.id,
  });

  return { company: company.name, query, count: records.length, fixedAssets: records.slice(0, take) };
}

// ── Generic multi-field search tool ────────────────────────────────────────────

async function toolSearchRecords({ table, query, searchFields, codeField, nameField, fields, take = 50, lcid = 1033, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  if (!query) throw new Error("Parameter 'query' is required");
  validateTableName(table);
  take = Math.min(Number(take) || 50, 200);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const fieldNumbers = Array.isArray(fields) && fields.length ? fields.map(Number) : undefined;

  // New path: multi-field parallel search via RecordIds when searchFields is provided
  if (Array.isArray(searchFields) && searchFields.length) {
    const records = await multiFieldSearch({
      tableName:    String(table),
      query,
      searchFields,
      fieldNumbers,
      conn,
      companyId:    company.id,
    });
    return { company: company.name, table: String(table), query, count: records.length, records: records.slice(0, take) };
  }

  // Legacy path: 2-field search (codeField prefix + nameField substring)
  if (!nameField) throw new Error("Parameter 'nameField' or 'searchFields' is required");
  const baseData = (view) => JSON.stringify({
    tableName: String(table),
    tableView: view,
    ...(fieldNumbers ? { fieldNumbers } : {}),
    take,
    lcid,
  });

  const looksLikeCode = codeField && /^[\w\-]+$/.test(String(query).trim()) && query.length <= 20;

  let records;
  if (looksLikeCode) {
    const [byCode, byName] = await Promise.all([
      bcTask(conn, company.id, {
        specversion: "1.0",
        type:        "Data.Records.Get",
        source:      "BC Metadata MCP v1.0",
        data:        baseData(`WHERE(${codeField}=FILTER(${query}*))`),
      }),
      bcTask(conn, company.id, {
        specversion: "1.0",
        type:        "Data.Records.Get",
        source:      "BC Metadata MCP v1.0",
        data:        baseData(`WHERE(${nameField}=FILTER(*${query}*))`),
      }),
    ]);
    const seen = new Set();
    records = [...(byCode.result || byCode.value || []), ...(byName.result || byName.value || [])]
      .filter(r => {
        const key = JSON.stringify(r.primaryKey || r);
        return seen.has(key) ? false : seen.add(key);
      })
      .slice(0, take);
  } else {
    const result = await bcTask(conn, company.id, {
      specversion: "1.0",
      type:        "Data.Records.Get",
      source:      "BC Metadata MCP v1.0",
      data:        baseData(`WHERE(${nameField}=FILTER(*${query}*))`),
    });
    records = result.result || result.value || [];
  }

  return { company: company.name, table: String(table), query, count: records.length, records };
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

async function toolGetFieldTranslation({ table, systemId, fieldId, lcid, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table)                                    throw new Error("Parameter 'table' is required (table name or number)");
  if (!systemId)                                 throw new Error("Parameter 'systemId' is required (record SystemId GUID without braces)");
  if (fieldId === undefined || fieldId === null) throw new Error("Parameter 'fieldId' is required (field number)");
  if (!lcid)                                     throw new Error("Parameter 'lcid' is required (Windows Language ID, e.g. 1033)");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Field.Translation.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
    data:        JSON.stringify({ systemId: String(systemId), fieldId: Number(fieldId), lcid: Number(lcid) }),
  });

  return { company: company.name, ...result };
}

async function toolSetFieldTranslation({ table, systemId, fieldId, lcid, value, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table)                                    throw new Error("Parameter 'table' is required (table name or number)");
  if (!systemId)                                 throw new Error("Parameter 'systemId' is required (record SystemId GUID without braces)");
  if (fieldId === undefined || fieldId === null) throw new Error("Parameter 'fieldId' is required (field number)");
  if (!lcid)                                     throw new Error("Parameter 'lcid' is required (Windows Language ID, e.g. 1033)");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { systemId: String(systemId), fieldId: Number(fieldId), lcid: Number(lcid) };
  if (value !== undefined && value !== null) data.value = String(value);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Field.Translation.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
    data:        JSON.stringify(data),
  });

  return { company: company.name, ...result };
}

async function toolGetFieldTranslations({ table, systemId, fieldId, lcid, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table)    throw new Error("Parameter 'table' is required (table name or number)");
  if (!systemId) throw new Error("Parameter 'systemId' is required (record SystemId GUID without braces)");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { systemId: String(systemId) };
  if (fieldId !== undefined && fieldId !== null) data.fieldId = Number(fieldId);
  if (lcid    !== undefined && lcid    !== null) data.lcid    = Number(lcid);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Field.Translations.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
    data:        JSON.stringify(data),
  });

  return { company: company.name, ...result };
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

async function toolGetDecimalTotal({ table, decimalField, decimalFields, filter, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  // Support both single decimalField and array decimalFields
  const fieldRefs = [];
  if (Array.isArray(decimalFields) && decimalFields.length) {
    for (const f of decimalFields) fieldRefs.push(normalizeDecimalFieldRef(f));
  } else if (decimalField !== undefined && decimalField !== null) {
    fieldRefs.push(normalizeDecimalFieldRef(decimalField));
  } else {
    throw new Error("Parameter 'decimalField' or 'decimalFields' is required");
  }

  // When multiple fields, request using fieldNumbers array
  if (fieldRefs.length > 1) {
    const data = { tableName: String(table) };
    const fieldNumbers = [];
    const fieldNames   = [];
    for (const ref of fieldRefs) {
      if (ref.fieldNo !== null) { fieldNumbers.push(ref.fieldNo); fieldNames.push(String(ref.fieldNo)); }
      else                      { fieldNames.push(ref.fieldName); }
    }
    if (fieldNumbers.length === fieldRefs.length) data.fieldNumbers = fieldNumbers;
    if (filter) data.tableView = String(filter);

    const result = await bcTask(conn, company.id, {
      specversion: "1.0",
      type:        "Data.Totals.Get",
      source:      "BC Metadata MCP v1.0",
      data:        JSON.stringify(data),
    });

    // Parse response: may be array of {fieldNo, total} or object with named totals
    const totals = {};
    if (Array.isArray(result)) {
      for (const item of result) {
        const key = item.fieldNo || item.fieldName || item.field;
        totals[key] = extractTotalNumber(item);
      }
    } else if (result && typeof result === "object") {
      // Try result.totals (array) or result.result (array)
      const arr = result.totals || result.result || result.value;
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const key = item.fieldNo || item.fieldName || item.field;
          totals[key] = extractTotalNumber(item);
        }
      } else {
        // Single result — fall back to extracting a single total
        for (const ref of fieldRefs) totals[ref.normalized] = extractTotalNumber(result);
      }
    }

    return {
      company: company.name,
      table: String(table),
      decimalFields: fieldRefs.map(r => r.normalized),
      filter: filter || null,
      totals,
    };
  }

  // Single-field path (original behavior)
  const { fieldNo, fieldName, normalized } = fieldRefs[0];

  const data = {
    tableName: String(table),
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

async function toolGetRecordIds({ table, startDateTime, endDateTime, filter, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table) };
  if (startDateTime) data.startDateTime = String(startDateTime);
  if (endDateTime)   data.endDateTime   = String(endDateTime);
  if (filter)        data.tableView     = String(filter);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.RecordIds.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  const records    = result.result || result.value || (Array.isArray(result) ? result : []);
  const noOfRecords = result.noOfRecords;
  return { company: company.name, table: String(table), noOfRecords, records };
}

async function toolGetCsvRecords({ table, fieldNumbers, startDateTime, endDateTime, filter, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table) };
  if (Array.isArray(fieldNumbers) && fieldNumbers.length) data.fieldNumbers = fieldNumbers.map(Number);
  if (startDateTime) data.startDateTime = String(startDateTime);
  if (endDateTime)   data.endDateTime   = String(endDateTime);
  if (filter)        data.tableView     = String(filter);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "CSV.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  // bcTask follows the redirect URL and returns the CSV as a latin1 string
  const csv = typeof result === "string" ? result : JSON.stringify(result);
  return { company: company.name, table: String(table), datacontenttype: "text/csv", csv };
}

async function toolGetDeletedRecords({ table, fieldNumbers, startDateTime, endDateTime, skip = 0, take = 100, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);
  take = Math.min(Number(take) || 100, 1000);
  skip = Math.max(Number(skip) || 0, 0);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table), skip, take };
  if (Array.isArray(fieldNumbers) && fieldNumbers.length) data.fieldNumbers = fieldNumbers.map(Number);
  if (startDateTime) data.startDateTime = String(startDateTime);
  if (endDateTime)   data.endDateTime   = String(endDateTime);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Deleted.Records.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  const records     = result.result || result.value || (Array.isArray(result) ? result : []);
  const noOfRecords = result.noOfRecords;
  return { company: company.name, table: String(table), skip, take, noOfRecords, records };
}

async function toolGetDeletedRecordIds({ table, startDateTime, endDateTime, skip = 0, take = 100, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);
  take = Math.min(Number(take) || 100, 1000);
  skip = Math.max(Number(skip) || 0, 0);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table), skip, take };
  if (startDateTime) data.startDateTime = String(startDateTime);
  if (endDateTime)   data.endDateTime   = String(endDateTime);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Deleted.RecordIds.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  const records     = result.result || result.value || (Array.isArray(result) ? result : []);
  const noOfRecords = result.noOfRecords;
  return { company: company.name, table: String(table), skip, take, noOfRecords, records };
}

async function toolGetCsvDeletedRecords({ table, tableNo, fromDate, toDate, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = {};
  if (table)   { validateTableName(table); data.tableName = String(table); }
  if (tableNo) data.tableNo = Number(tableNo);
  if (fromDate) data.fromDate = String(fromDate);
  if (toDate)   data.toDate   = String(toDate);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "CSV.DeletedRecords.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  const csv = typeof result === "string" ? result : JSON.stringify(result);
  return { company: company.name, datacontenttype: "text/csv", csv };
}

async function toolGetTablePermissions({ table, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Help.Permissions.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(table),
  });

  return { company: company.name, table: String(table), ...result };
}

async function toolGetCustomerCreditLimit({ customerNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!customerNo) throw new Error("Parameter 'customerNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Customer.CreditLimit.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(customerNo),
  });

  return { company: company.name, ...result };
}

async function toolGetCustomerSalesHistory({ customerNo, fromDate, toDate, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!customerNo) throw new Error("Parameter 'customerNo' is required");
  if (!fromDate)   throw new Error("Parameter 'fromDate' is required (YYYY-MM-DD)");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { customerNo: String(customerNo), fromDate: String(fromDate) };
  if (toDate) data.toDate = String(toDate);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Customer.SalesHistory.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(customerNo),
    data:        JSON.stringify(data),
  });

  return { company: company.name, ...result };
}

async function toolGetItemAvailability({ itemNo, requestedDeliveryDate, variantCode, locationFilter, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!itemNo) throw new Error("Parameter 'itemNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = {};
  if (requestedDeliveryDate) data.requestedDeliveryDate = String(requestedDeliveryDate);
  if (variantCode)           data.variantCode           = String(variantCode);
  if (locationFilter)        data.locationFilter        = String(locationFilter);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Item.Availability.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(itemNo),
    data:        JSON.stringify(data),
  });

  return { company: company.name, ...result };
}

async function toolGetItemPrice({ itemNo, customerNo, requestedDeliveryDate, quantity, variantCode, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!itemNo) throw new Error("Parameter 'itemNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = {};
  if (customerNo)                              data.customerNo            = String(customerNo);
  if (requestedDeliveryDate)                   data.requestedDeliveryDate = String(requestedDeliveryDate);
  if (quantity !== undefined && quantity !== null) data.quantity          = Number(quantity);
  if (variantCode)                             data.variantCode           = String(variantCode);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Item.Price.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     String(itemNo),
    data:        JSON.stringify(data),
  });

  return { company: company.name, ...result };
}

async function toolReleaseSalesOrder({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Sales.Order.Release",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  return { company: company.name, ...result };
}

async function toolReopenSalesOrder({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Sales.Order.Reopen",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  return { company: company.name, ...result };
}

async function toolPostSalesOrder({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Sales.Order.Post",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  return { company: company.name, ...result };
}

async function toolGetSalesDocumentPdf({ documentType, documentNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!documentType) throw new Error("Parameter 'documentType' is required: Invoice, Shipment, CreditMemo, or ReturnReceipt");
  if (!documentNo)   throw new Error("Parameter 'documentNo' is required");

  const typeMap = {
    "invoice":       "Sales.SalesInvoice.Pdf",
    "shipment":      "Sales.SalesShipment.Pdf",
    "creditmemo":    "Sales.SalesCreditMemo.Pdf",
    "returnreceipt": "Sales.ReturnReceipt.Pdf",
  };
  const messageType = typeMap[String(documentType).toLowerCase().replace(/[^a-z]/g, "")];
  if (!messageType) throw new Error(`Unknown documentType '${documentType}'. Valid values: Invoice, Shipment, CreditMemo, ReturnReceipt`);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        messageType,
    source:      "BC Metadata MCP v1.0",
    subject:     String(documentNo),
  });

  if (typeof result !== "string") throw new Error(`Unexpected response from BC for ${messageType}: ${JSON.stringify(result)}`);
  const base64 = Buffer.from(result, "latin1").toString("base64");
  return {
    company:         company.name,
    documentType:    String(documentType),
    documentNo:      String(documentNo),
    messageType,
    datacontenttype: "application/pdf",
    pdfBase64:       base64,
    note:            "pdfBase64 contains the base64-encoded PDF. Decode it to get the binary PDF file.",
  };
}

async function toolGetCustomerStatementPdf({ customerNo, startDate, endDate, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!customerNo) throw new Error("Parameter 'customerNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = {};
  if (startDate) data.startDate = startDate;
  if (endDate)   data.endDate   = endDate;

  const envelope = {
    specversion: "1.0",
    type:        "Customer.Statement.Pdf",
    source:      "BC Metadata MCP v1.0",
    subject:     String(customerNo),
  };
  if (Object.keys(data).length > 0) envelope.data = JSON.stringify(data);

  const result = await bcTask(conn, company.id, envelope);

  // BC downloads the PDF binary via the task data URL; result arrives as a latin1 string.
  if (typeof result !== "string") throw new Error(`Unexpected response from BC for Customer.Statement.Pdf: ${JSON.stringify(result)}`);
  // result arrived as latin1 string — latin1 is a 1-to-1 byte map so this is lossless
  const base64 = Buffer.from(result, "latin1").toString("base64");
  return {
    company:         company.name,
    customerNo:      String(customerNo),
    startDate:       startDate || null,
    endDate:         endDate   || null,
    datacontenttype: "application/pdf",
    pdfBase64:       base64,
    note:            "pdfBase64 contains the base64-encoded PDF. Decode it to get the binary PDF file.",
  };
}

async function toolGetPurchaseOrderStatistics({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Purchase.Order.Statistics",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  if (typeof result === "string") {
    try { return JSON.parse(result); } catch { return { raw: result }; }
  }
  return result;
}

async function toolReleasePurchaseOrder({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Purchase.Order.Release",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  return { company: company.name, ...result };
}

async function toolReopenPurchaseOrder({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Purchase.Order.Reopen",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  return { company: company.name, ...result };
}

async function toolPostPurchaseOrder({ orderNo, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!orderNo) throw new Error("Parameter 'orderNo' is required");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Purchase.Order.Post",
    source:      "BC Metadata MCP v1.0",
    subject:     String(orderNo),
  });

  return { company: company.name, ...result };
}

async function toolCheckGeneralJournal({ subject, templateName, batchName, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  const resolvedSubject = subject || (templateName && batchName ? `${templateName}|${batchName}` : null);
  if (!resolvedSubject) throw new Error("Provide 'subject' (e.g. 'GENERAL|DEFAULT') or both 'templateName' and 'batchName'");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Finance.GeneralJournal.Check",
    source:      "BC Metadata MCP v1.0",
    subject:     resolvedSubject,
  });

  return { company: company.name, ...result };
}

async function toolPostGeneralJournal({ subject, templateName, batchName, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  const resolvedSubject = subject || (templateName && batchName ? `${templateName}|${batchName}` : null);
  if (!resolvedSubject) throw new Error("Provide 'subject' (e.g. 'GENERAL|BATCH001') or both 'templateName' and 'batchName'");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Finance.GeneralJournal.Post",
    source:      "BC Metadata MCP v1.0",
    subject:     resolvedSubject,
  });

  return { company: company.name, ...result };
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

// ── get_next_line_no ─────────────────────────────────────────────────────────

async function toolGetNextLineNo({ table, primaryKey, id, increment = 10000, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required");
  validateTableName(table);
  increment = Number(increment) || 10000;
  if (increment < 1) throw new Error("Parameter 'increment' must be >= 1");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table), increment };
  if (primaryKey && typeof primaryKey === "object") data.primaryKey = primaryKey;
  if (id) data.id = String(id);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Help.NextLineNo.Get",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  const lineNo = typeof result === "number" ? result
    : (result && typeof result === "object") ? (result.lineNo ?? result.nextLineNo ?? result.result ?? result.value) : null;

  return {
    company: company.name,
    table: String(table),
    primaryKey: primaryKey || null,
    id: id || null,
    increment,
    nextLineNo: lineNo,
  };
}

// ── batch_records ────────────────────────────────────────────────────────────

async function toolBatchRecords({ requests, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) throw new Error("Parameter 'requests' must be a non-empty array");
  if (requests.length > 10) throw new Error("Maximum 10 requests per batch");

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const results = await Promise.all(requests.map(async (req, idx) => {
    try {
      if (!req.table) throw new Error(`Request [${idx}]: 'table' is required`);
      validateTableName(req.table);
      const take = Math.min(Number(req.take) || 50, 200);
      const data = { tableName: String(req.table), skip: 0, take };
      if (req.filter) data.tableView = String(req.filter);
      if (Array.isArray(req.fieldNumbers) && req.fieldNumbers.length) data.fieldNumbers = req.fieldNumbers.map(Number);

      const result = await bcTask(conn, company.id, {
        specversion: "1.0",
        type:        "Data.Records.Get",
        source:      "BC Metadata MCP v1.0",
        data:        JSON.stringify(data),
      });

      const records = result.result || result.value || (Array.isArray(result) ? result : []);
      const ret = { table: String(req.table), count: records.length, records };
      if (result.noOfRecords !== undefined) ret.noOfRecords = result.noOfRecords;
      return ret;
    } catch (err) {
      return { table: req.table || `request[${idx}]`, error: err.message };
    }
  }));

  return { company: company.name, results };
}

// ── get_document_lines ───────────────────────────────────────────────────────

const DOC_LINE_TABLE_MAP = {
  "sales order":      { table: "Sales Line",      docTypeFilter: "Order" },
  "sales invoice":    { table: "Sales Line",      docTypeFilter: "Invoice" },
  "sales quote":      { table: "Sales Line",      docTypeFilter: "Quote" },
  "sales credit memo":{ table: "Sales Line",      docTypeFilter: "Credit Memo" },
  "purchase order":   { table: "Purchase Line",   docTypeFilter: "Order" },
  "purchase invoice": { table: "Purchase Line",   docTypeFilter: "Invoice" },
  "purchase quote":   { table: "Purchase Line",   docTypeFilter: "Quote" },
  "purchase credit memo": { table: "Purchase Line", docTypeFilter: "Credit Memo" },
};

async function toolGetDocumentLines({ documentType, documentNo, table, fields, take = 200, lcid = 1033, format = "json", companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!documentNo) throw new Error("Parameter 'documentNo' is required");
  take = Math.min(Number(take) || 200, 200);

  let targetTable, docTypeFilter;
  if (table) {
    targetTable = String(table);
  } else if (documentType) {
    const key = String(documentType).toLowerCase().trim();
    const mapped = DOC_LINE_TABLE_MAP[key];
    if (!mapped) throw new Error(`Unknown documentType '${documentType}'. Use one of: ${Object.keys(DOC_LINE_TABLE_MAP).join(", ")} — or pass 'table' directly.`);
    targetTable = mapped.table;
    docTypeFilter = mapped.docTypeFilter;
  } else {
    throw new Error("Either 'documentType' or 'table' is required");
  }

  const filterParts = [];
  if (docTypeFilter) filterParts.push(`Document Type=CONST(${docTypeFilter})`);
  filterParts.push(`Document No.=CONST(${String(documentNo)})`);
  const filter = `WHERE(${filterParts.join(",")})`;

  // Delegate to toolGetRecords for field resolution, format support, etc.
  return await toolGetRecords({ table: targetTable, filter, fields, take, lcid, format, companyId, tenantId, clientId, clientSecret, environment, encryptedConn });
}

// ── get_changelog_field_history ──────────────────────────────────────────────

async function toolGetChangelogFieldHistory({ table, recordSystemId, fieldNo, fieldName, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");
  if (!recordSystemId) throw new Error("Parameter 'recordSystemId' is required (record SystemId GUID)");
  if (fieldNo == null && !fieldName) throw new Error("Either 'fieldNo' or 'fieldName' is required");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table), recordSystemId: String(recordSystemId) };
  if (fieldNo != null) data.fieldNo = Number(fieldNo);
  else                 data.fieldName = String(fieldName);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "ChangeLog.Field.History",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  return {
    company:        company.name,
    tableNo:        result.tableNo,
    tableName:      result.tableName,
    recordSystemId: result.recordSystemId,
    fieldNo:        result.fieldNo,
    fieldName:      result.fieldName,
    fieldType:      result.fieldType,
    totalCount:     result.totalCount,
    history:        result.history || [],
  };
}

// ── restore_changelog_field ──────────────────────────────────────────────────

async function toolRestoreChangelogField({ entryNo, table, recordSystemId, fieldNo, fieldName, restoreToDateTime, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  // Mode 1: by entry number — Mode 2: by table + recordSystemId + field + restoreToDateTime
  const isMode1 = entryNo != null;
  const isMode2 = table && recordSystemId && (fieldNo != null || fieldName) && restoreToDateTime;
  if (!isMode1 && !isMode2) {
    throw new Error(
      "Provide either 'entryNo' (Mode 1) or 'table' + 'recordSystemId' + 'fieldNo'/'fieldName' + 'restoreToDateTime' (Mode 2)"
    );
  }

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  let data;
  if (isMode1) {
    data = { entryNo: Number(entryNo) };
  } else {
    validateTableName(table);
    data = {
      tableName:         String(table),
      recordSystemId:    String(recordSystemId),
      restoreToDateTime: String(restoreToDateTime),
    };
    if (fieldNo != null) data.fieldNo = Number(fieldNo);
    else                 data.fieldName = String(fieldName);
  }

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "ChangeLog.Field.Restore",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  return {
    company:        company.name,
    tableNo:        result.tableNo,
    tableName:      result.tableName,
    recordSystemId: result.recordSystemId,
    fieldNo:        result.fieldNo,
    fieldName:      result.fieldName,
    previousValue:  result.previousValue,
    restoredValue:  result.restoredValue,
    fromEntryNo:    result.fromEntryNo,
    entryDateTime:  result.entryDateTime,
  };
}

// ── changelog_field_enabled ──────────────────────────────────────────────────

async function toolChangelogFieldEnabled({ table, fieldNo, fieldName, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!table) throw new Error("Parameter 'table' is required (table name or number)");
  if (fieldNo == null && !fieldName) throw new Error("Either 'fieldNo' or 'fieldName' is required");
  validateTableName(table);

  const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
  const company = await getCompany(companyId, conn);

  const data = { tableName: String(table) };
  if (fieldNo != null) data.fieldNo = Number(fieldNo);
  else                 data.fieldName = String(fieldName);

  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "ChangeLog.Field.Enabled",
    source:      "BC Metadata MCP v1.0",
    data:        JSON.stringify(data),
  });

  return {
    company:                    company.name,
    changeLogEnabled:           result.changeLogEnabled,
    changelogWriteGuardEnabled: result.changelogWriteGuardEnabled,
    tableNo:                    result.tableNo,
    tableName:                  result.tableName,
    fieldNo:                    result.fieldNo,
    fieldName:                  result.fieldName,
    fieldCovered:               result.fieldCovered,
  };
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
// App ranges are stored with Source = "<Publisher>-<AppName>" and Id = app.id (GUID)

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

  // Use Publisher-Name as source, app.id as Id
  const source = `${publisher}-${appName}`;
  const blobValue = Buffer.from(JSON.stringify(data)).toString("base64");
  await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Set",
    source:      "BC Metadata MCP v1.0",
    subject:     CS_TABLE,
    data:        JSON.stringify({
      mode: "upsert",
      data: [{
        primaryKey: { Source: source, Id: appId },
        fields:     { Data: blobValue },
      }],
    }),
  });

  return { company: company.name, saved: true, appId, appName, publisher, source, idRanges };
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

  // Fetch all stored app ranges - no source filter, get all records with app range data
  const result = await bcTask(conn, company.id, {
    specversion: "1.0",
    type:        "Data.Records.Get",
    source:      "BC Metadata MCP v1.0",
    subject:     CS_TABLE,
    data:        JSON.stringify({
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

// ── App.json file operations ───────────────────────────────────────────────────

async function toolReadAppJson({ projectPath } = {}) {
  if (!projectPath) throw new Error("Parameter 'projectPath' is required (local path to the BC extension project folder)");

  const sep = process.platform === "win32" ? "\\" : "/";
  const appJsonPath = `${projectPath}${sep}app.json`;

  if (!fs.existsSync(appJsonPath)) {
    throw new Error(`app.json not found at: ${appJsonPath}`);
  }

  let appJson;
  try {
    const content = fs.readFileSync(appJsonPath, "utf8");
    appJson = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to read or parse app.json: ${e.message}`);
  }

  return {
    path: appJsonPath,
    id: appJson.id || null,
    name: appJson.name || null,
    publisher: appJson.publisher || null,
    version: appJson.version || null,
    target: appJson.target || null,
    idRanges: appJson.idRanges || [],
    dependencies: (appJson.dependencies || []).map(d => ({
      id: d.id,
      name: d.name,
      publisher: d.publisher,
      version: d.version,
    })),
    raw: appJson,
  };
}

async function toolUpdateAppJsonRanges({ projectPath, idRanges, backup = true } = {}) {
  if (!projectPath) throw new Error("Parameter 'projectPath' is required (local path to the BC extension project folder)");
  if (!Array.isArray(idRanges) || !idRanges.length)
    throw new Error("Parameter 'idRanges' is required (array of { from, to } objects)");

  for (const r of idRanges) {
    if (typeof r.from !== "number" || typeof r.to !== "number" || r.from > r.to)
      throw new Error(`Each idRanges entry must have numeric 'from' <= 'to'. Got: ${JSON.stringify(r)}`);
  }

  const sep = process.platform === "win32" ? "\\" : "/";
  const appJsonPath = `${projectPath}${sep}app.json`;

  if (!fs.existsSync(appJsonPath)) {
    throw new Error(`app.json not found at: ${appJsonPath}`);
  }

  let appJson, originalContent;
  try {
    originalContent = fs.readFileSync(appJsonPath, "utf8");
    appJson = JSON.parse(originalContent);
  } catch (e) {
    throw new Error(`Failed to read or parse app.json: ${e.message}`);
  }

  // Create backup if requested
  if (backup) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = `${projectPath}${sep}app.json.backup.${timestamp}`;
    try {
      fs.writeFileSync(backupPath, originalContent, "utf8");
    } catch (e) {
      throw new Error(`Failed to create backup at ${backupPath}: ${e.message}`);
    }
  }

  // Update idRanges
  const previousRanges = appJson.idRanges || [];
  appJson.idRanges = idRanges;

  // Write updated app.json with proper formatting (2-space indent)
  try {
    fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n", "utf8");
  } catch (e) {
    throw new Error(`Failed to write updated app.json: ${e.message}`);
  }

  return {
    path: appJsonPath,
    updated: true,
    previousRanges,
    newRanges: idRanges,
    backup: backup ? `${projectPath}${sep}app.json.backup.${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}` : null,
    appId: appJson.id,
    appName: appJson.name,
  };
}

// ── Prepare for Pull Request ───────────────────────────────────────────────────

async function toolPrepareForPullRequest({ projectPath, standardsRepo, claudeDir, companyId, tenantId, clientId, clientSecret, environment, encryptedConn } = {}) {
  if (!projectPath) throw new Error("Parameter 'projectPath' is required (local path to the BC extension project folder)");

  const sep         = process.platform === "win32" ? "\\" : "/";
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  const resolvedStandardsRepo = standardsRepo || (userProfile ? `${userProfile}${sep}bc-dev-standards` : "");
  const resolvedClaudeDir     = claudeDir     || (userProfile ? `${userProfile}${sep}.claude`          : "");

  function readFileSafe(p) {
    try { return fs.readFileSync(p, "utf8"); } catch (_) { return null; }
  }

  function findFilesRecursive(dir, extension, excludeDirs = []) {
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = `${dir}${sep}${entry.name}`;
        if (entry.isDirectory()) {
          if (!excludeDirs.includes(entry.name.toLowerCase())) {
            results.push(...findFilesRecursive(fullPath, extension, excludeDirs));
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
          results.push(fullPath);
        }
      }
    } catch (_) {}
    return results;
  }

  const report = {
    projectPath,
    appInfo:        null,
    appRange:       { status: null, details: null },
    skills:         [],
    codeAnalysis:   { filesScanned: 0, issues: [], summary: {} },
    documentation:  {},
    requiredActions: [],
  };

  // ── 1. Read app.json ──────────────────────────────────────────────────────
  const appJsonPath = `${projectPath}${sep}app.json`;
  const appJsonRaw  = readFileSafe(appJsonPath);
  let appJson = null;

  if (!appJsonRaw) {
    report.requiredActions.push({ severity: "❌", item: "app.json not found", action: `Create app.json at ${appJsonPath}` });
  } else {
    try { appJson = JSON.parse(appJsonRaw); } catch (e) {
      report.requiredActions.push({ severity: "❌", item: "app.json is not valid JSON", action: `Fix JSON syntax: ${e.message}` });
    }
  }

  if (appJson) {
    report.appInfo = {
      id:           appJson.id           || null,
      name:         appJson.name         || null,
      publisher:    appJson.publisher    || null,
      version:      appJson.version      || null,
      target:       appJson.target       || null,
      idRanges:     appJson.idRanges     || [],
      dependencies: (appJson.dependencies || []).map(d => ({ id: d.id, name: d.name, publisher: d.publisher, version: d.version })),
    };

    // app.json quality checks
    if (!appJson.target || appJson.target !== "Cloud")
      report.requiredActions.push({ severity: "⚠️", item: "app.json: target is not 'Cloud'", action: "Set \"target\": \"Cloud\" in app.json" });
    if (!appJson.applicationInsightsKey)
      report.requiredActions.push({ severity: "⚠️", item: "app.json: applicationInsightsKey is missing", action: "Add applicationInsightsKey for production telemetry" });

    // ── 2. Save / verify / conflict-check app range ───────────────────────
    if (appJson.id && appJson.name && appJson.publisher && Array.isArray(appJson.idRanges) && appJson.idRanges.length) {
      try {
        const conn    = resolveConn({ tenantId, clientId, clientSecret, environment, encryptedConn });
        const company = await getCompany(companyId, conn);
        const source  = `${appJson.publisher}-${appJson.name}`;

        // Read current stored record for this app by app.id
        const existingResult = await bcTask(conn, company.id, {
          specversion: "1.0",
          type:        "Data.Records.Get",
          source:      "BC Metadata MCP v1.0",
          subject:     CS_TABLE,
          data:        JSON.stringify({
            tableView: `WHERE(Id=CONST(${appJson.id}))`,
            take: 1,
          }),
        });
        const existingRecords = existingResult.result || existingResult.value || [];
        let existingData = null;
        if (existingRecords.length) {
          try { existingData = JSON.parse(Buffer.from((existingRecords[0].fields || {}).Data || "", "base64").toString("utf8")); } catch (_) {}
        }

        const rangesMatch = existingData &&
          JSON.stringify(existingData.idRanges) === JSON.stringify(appJson.idRanges) &&
          existingData.appName  === appJson.name &&
          existingData.publisher === appJson.publisher;

        // Upsert if new or changed
        if (!existingData || !rangesMatch) {
          const blobValue = Buffer.from(JSON.stringify({ appId: appJson.id, appName: appJson.name, publisher: appJson.publisher, idRanges: appJson.idRanges })).toString("base64");
          await bcTask(conn, company.id, {
            specversion: "1.0",
            type:        "Data.Records.Set",
            source:      "BC Metadata MCP v1.0",
            subject:     CS_TABLE,
            data:        JSON.stringify({
              mode: "upsert",
              data: [{ primaryKey: { Source: source, Id: appJson.id }, fields: { Data: blobValue } }],
            }),
          });
          report.appRange = {
            status: existingData ? "✅ Updated" : "✅ Registered",
            details: existingData ? "App range updated in Cloud Events Storage" : "App range saved to Cloud Events Storage for the first time",
            company: company.name,
            source,
          };
        } else {
          report.appRange = { status: "✅ Verified", details: "App range matches Cloud Events Storage", company: company.name, source };
        }

        // Conflict check — get all app ranges (no source filter) and skip the current app's own ranges
        const allResult = await bcTask(conn, company.id, {
          specversion: "1.0",
          type:        "Data.Records.Get",
          source:      "BC Metadata MCP v1.0",
          subject:     CS_TABLE,
          data:        JSON.stringify({ take: 500 }),
        });
        const allApps = (allResult.result || allResult.value || []).reduce((acc, rec) => {
          try { const d = JSON.parse(Buffer.from((rec.fields || {}).Data || "", "base64").toString("utf8")); if (d && d.idRanges) acc.push(d); } catch (_) {}
          return acc;
        }, []).filter(a => a.appId !== appJson.id);

        const conflicts = [];
        for (const checkRange of appJson.idRanges) {
          for (const app of allApps) {
            for (const appRange of app.idRanges) {
              if (checkRange.from <= appRange.to && appRange.from <= checkRange.to) {
                conflicts.push({ checkedRange: checkRange, conflictingApp: { appId: app.appId, appName: app.appName, publisher: app.publisher, conflictingRange: appRange } });
              }
            }
          }
        }
        if (conflicts.length) {
          report.appRange.conflicts = conflicts;
          report.requiredActions.push({ severity: "❌", item: `ID range conflicts with ${[...new Set(conflicts.map(c => c.conflictingApp.appName))].join(", ")}`, action: "Resolve overlapping ID ranges before merging" });
        }

      } catch (e) {
        report.appRange = { status: "⚠️ BC unreachable", details: e.message.slice(0, 150) };
        report.requiredActions.push({ severity: "⚠️", item: "Could not verify app range in BC", action: `Check BC connection and retry. Error: ${e.message.slice(0, 100)}` });
      }
    } else {
      report.appRange = { status: "❌ Incomplete", details: "app.json is missing id, name, publisher, or idRanges" };
      report.requiredActions.push({ severity: "❌", item: "app.json missing id / name / publisher / idRanges", action: "Add missing fields to app.json" });
    }

    // Look for test app.json (convention: test subfolder)
    const testDirs = ["test", "Test", "tests", "Tests"];
    for (const td of testDirs) {
      const testAppJson = readFileSafe(`${projectPath}${sep}${td}${sep}app.json`);
      if (testAppJson) {
        try {
          const ta = JSON.parse(testAppJson);
          report.appInfo.testApp = { id: ta.id, name: ta.name, publisher: ta.publisher, idRanges: ta.idRanges || [] };
          // Verify the test range follows the 9xxxx convention (main range + 30000)
          if (appJson.idRanges && ta.idRanges) {
            for (const mr of appJson.idRanges) {
              const expectedFrom = mr.from + 30000;
              const expectedTo   = mr.to   + 30000;
              const match = ta.idRanges.some(tr => tr.from === expectedFrom && tr.to === expectedTo);
              if (!match) {
                report.requiredActions.push({ severity: "⚠️", item: `Test app ID range does not follow +30000 convention for main range [${mr.from}-${mr.to}]`, action: `Set test app idRanges to [{ "from": ${expectedFrom}, "to": ${expectedTo} }]` });
              }
            }
          }
        } catch (_) {}
        break;
      }
    }
  }

  // ── 3. Read skill files from both global and project-local .claude ──────
  const globalSkillsDir = resolvedClaudeDir ? `${resolvedClaudeDir}${sep}skills` : null;
  const projectClaudeDir = `${projectPath}${sep}.claude`;
  const projectSkillsDir = fs.existsSync(projectClaudeDir) ? `${projectClaudeDir}${sep}skills` : null;
  const fallbackSkillsDir = resolvedStandardsRepo ? `${resolvedStandardsRepo}${sep}skills` : null;

  const skillDirectories = [
    { type: "project", dir: projectSkillsDir },
    { type: "global",  dir: globalSkillsDir },
    { type: "fallback", dir: fallbackSkillsDir },
  ].filter(s => s.dir && fs.existsSync(s.dir));

  for (const { type, dir } of skillDirectories) {
    try {
      const skillDirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
      for (const skillName of skillDirs) {
        const content = readFileSafe(`${dir}${sep}${skillName}${sep}SKILL.md`);
        if (content && !report.skills.some(s => s.name === skillName)) {
          report.skills.push({ name: skillName, source: type, content });
        }
      }
    } catch (_) {}
  }

  // Read copilot-instructions and CLAUDE.md from both project and global locations
  const copilotInstructions = [];
  const projectGithubDir = `${projectPath}${sep}.github`;
  const projectCopilot = readFileSafe(`${projectGithubDir}${sep}copilot-instructions.md`);
  if (projectCopilot) copilotInstructions.push({ source: "project", content: projectCopilot });
  
  const projectClaude = readFileSafe(`${projectClaudeDir}${sep}CLAUDE.md`);
  if (projectClaude) copilotInstructions.push({ source: "project", content: projectClaude });
  
  const globalClaude = readFileSafe(resolvedClaudeDir ? `${resolvedClaudeDir}${sep}CLAUDE.md` : null);
  if (globalClaude && globalClaude !== projectClaude) copilotInstructions.push({ source: "global", content: globalClaude });

  report.copilotRules = copilotInstructions;

  if (!report.skills.length) {
    report.requiredActions.push({ severity: "⚠️", item: "No skill files found", action: "Run setup_origo_bc_environment to set up the skills junction or add project-specific skills to .claude/skills" });
  }

  // ── 4. Static AL code analysis ───────────────────────────────────────────
  const EXCLUDE_DIRS = [".alpackages", ".app", "output", "rad", ".git", "node_modules", ".vscode"];
  const allAlFiles  = findFilesRecursive(projectPath, ".al", EXCLUDE_DIRS);
  // Separate test files from main files
  const mainAlFiles = allAlFiles.filter(f => !/(\\|\/)test(\\|\/|s)/i.test(f));

  report.codeAnalysis.filesScanned = allAlFiles.length;

  const MAX_PER_RULE = 10;
  const cnt = { withStatement: 0, countNotIsEmpty: 0, fileNaming: 0, longObjectName: 0, calcFieldsInLoop: 0 };

  const AL_OBJECT_TYPES = "table|page|codeunit|report|query|xmlport|enum|interface|permissionset";
  const OBJECT_DECL_RE  = new RegExp(`^\\s*(${AL_OBJECT_TYPES})\\s+\\d+\\s+"([^"]+)"`, "im");

  for (const filePath of mainAlFiles) {
    const content = readFileSafe(filePath);
    if (!content) continue;

    const relPath    = filePath.replace(projectPath, "").replace(/^[/\\]/, "");
    const fileName   = filePath.split(sep).pop();
    const fileIssues = [];
    const lines      = content.split("\n");

    // WITH statement
    if (cnt.withStatement < MAX_PER_RULE) {
      const hits = lines.map((l, i) => ({ l: l.trim(), n: i + 1 }))
        .filter(({ l }) => /^\s*with\s+\w/i.test(l) && !l.startsWith("//") && !l.startsWith("*"));
      if (hits.length) {
        fileIssues.push({ rule: "No WITH statements (deprecated)", lines: hits.slice(0, 3).map(h => h.n) });
        cnt.withStatement += hits.length;
      }
    }

    // Count() > 0 instead of IsEmpty()
    if (cnt.countNotIsEmpty < MAX_PER_RULE) {
      const hits = lines.map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /\.Count\(\)\s*(>|<>|!=)\s*0/i.test(l) && !l.trim().startsWith("//"));
      if (hits.length) {
        fileIssues.push({ rule: "Use IsEmpty() instead of Count() > 0", lines: hits.slice(0, 3).map(h => h.n) });
        cnt.countNotIsEmpty += hits.length;
      }
    }

    // CALCFIELDS inside loops
    if (cnt.calcFieldsInLoop < MAX_PER_RULE) {
      let insideLoop = false;
      const repeatLines = [];
      lines.forEach((l, i) => {
        const trimmed = l.trim().toLowerCase();
        if (trimmed.startsWith("repeat")) insideLoop = true;
        if (trimmed.startsWith("until"))  insideLoop = false;
        if (insideLoop && /\.calcfields\(/i.test(l) && !l.trim().startsWith("//")) {
          repeatLines.push(i + 1);
        }
      });
      if (repeatLines.length) {
        fileIssues.push({ rule: "Do not use CalcFields inside a loop", lines: repeatLines.slice(0, 3) });
        cnt.calcFieldsInLoop += repeatLines.length;
      }
    }

    // File naming: ObjectName.ObjectType.al
    if (cnt.fileNaming < MAX_PER_RULE) {
      const validNamingRE = /^.+\.(Table|Page|Codeunit|Report|Query|XMLport|Enum|Interface|TableExt|PageExt|ReportExt|EnumExt|ControlAddin|Profile|PageCustomization|PermissionSet|PermissionSetExt)\.al$/i;
      if (!validNamingRE.test(fileName)) {
        fileIssues.push({ rule: "File naming: ObjectName.ObjectType.al", detail: `'${fileName}' does not follow the convention` });
        cnt.fileNaming++;
      }
    }

    // Object name > 30 chars
    if (cnt.longObjectName < MAX_PER_RULE) {
      const declMatch = OBJECT_DECL_RE.exec(content);
      if (declMatch && declMatch[2].length > 30) {
        fileIssues.push({ rule: "Object name max 30 characters", detail: `"${declMatch[2]}" is ${declMatch[2].length} chars` });
        cnt.longObjectName++;
      }
    }

    if (fileIssues.length) report.codeAnalysis.issues.push({ file: relPath, issues: fileIssues });
  }

  report.codeAnalysis.summary = cnt;

  if (cnt.withStatement   > 0) report.requiredActions.push({ severity: "❌", item: `WITH statements — ${cnt.withStatement} occurrence(s)`,         action: "Remove all WITH statements (deprecated in AL)" });
  if (cnt.countNotIsEmpty > 0) report.requiredActions.push({ severity: "⚠️", item: `Count() > 0 instead of IsEmpty() — ${cnt.countNotIsEmpty}`,   action: "Replace .Count() > 0 with not .IsEmpty()" });
  if (cnt.calcFieldsInLoop> 0) report.requiredActions.push({ severity: "⚠️", item: `CalcFields inside loops — ${cnt.calcFieldsInLoop} occurrence(s)`, action: "Move CalcFields calls outside repeat..until loops" });
  if (cnt.fileNaming      > 0) report.requiredActions.push({ severity: "⚠️", item: `File naming violations — ${cnt.fileNaming} file(s)`,           action: "Rename files to ObjectName.ObjectType.al" });
  if (cnt.longObjectName  > 0) report.requiredActions.push({ severity: "⚠️", item: `Object names > 30 characters — ${cnt.longObjectName}`,         action: "Shorten object names to max 30 characters" });

  // ── 5. Documentation check — README, CHANGELOG, Help must be in repo root ───
  // These files must be in the repository root, not in a subfolder
  const readmeExists    = fs.existsSync(`${projectPath}${sep}README.md`);
  const changelogExists = fs.existsSync(`${projectPath}${sep}CHANGELOG.md`);
  
  // Help can be in help/ or docs/ subfolder, but must exist at repo root level
  const helpDirs = ["help", "Help", "docs", "Docs"];
  const helpDir = helpDirs.find(d => fs.existsSync(`${projectPath}${sep}${d}`));
  const hasHelpDir = !!helpDir;
  
  const permSetFiles = allAlFiles.filter(f => /PermissionSet/i.test(f));

  // Check README has actual content (not just a header)
  const readmeContent = readmeExists ? readFileSafe(`${projectPath}${sep}README.md`) : null;
  const readmeHasContent = readmeContent && readmeContent.trim().length > 100;

  // Validate README sections based on loaded rules
  const readmeHasSections = {
    description: readmeContent && /##?\s*(Description|Overview|About)/im.test(readmeContent),
    prerequisites: readmeContent && /##?\s*(Prerequisites|Requirements)/im.test(readmeContent),
    setup: readmeContent && /##?\s*(Setup|Installation|Getting Started)/im.test(readmeContent),
    features: readmeContent && /##?\s*(Features|Functionality|Usage)/im.test(readmeContent),
    version: readmeContent && /##?\s*(Version|Changelog|History)/im.test(readmeContent),
  };

  // Check CHANGELOG follows Keep a Changelog format
  const changelogContent = changelogExists ? readFileSafe(`${projectPath}${sep}CHANGELOG.md`) : null;
  const changelogHasVersions = changelogContent && /##\s*\[?\d+\.\d+\.\d+\]?/m.test(changelogContent);
  const changelogHasRecent = changelogContent && /##\s*\[?Unreleased\]?|##\s*\[?\d+\.\d+\.\d+\]?\s*-\s*\d{4}-\d{2}-\d{2}/im.test(changelogContent);

  report.documentation = {
    readme:      readmeExists     ? (readmeHasContent ? "✅ README.md — has content" : "⚠️ README.md — appears empty or minimal") : "❌ README.md missing",
    readmeLocation: readmeExists ? `✅ README.md in repository root` : "❌ README.md not found in root",
    readmeSections: readmeHasSections,
    changelog:   changelogExists  ? (changelogHasVersions ? "✅ CHANGELOG.md — has versions" : "⚠️ CHANGELOG.md — missing version entries") : "❌ CHANGELOG.md missing",
    changelogLocation: changelogExists ? `✅ CHANGELOG.md in repository root` : "❌ CHANGELOG.md not found in root",
    changelogFormat: changelogHasRecent ? "✅ Recent changes documented" : "⚠️ No recent version or Unreleased section",
    helpDir:     hasHelpDir       ? `✅ ${helpDir}/ folder found in root`  : "⚠️  No help or docs folder in root",
    permSets:    permSetFiles.length ? `✅ ${permSetFiles.length} permission set file(s)` : "⚠️  No permission set files found",
  };

  if (!readmeExists)
    report.requiredActions.push({ 
      severity: "❌", 
      item: "README.md is missing from repository root", 
      action: "Create README.md in repository root with: app description, prerequisites, setup steps, feature overview, and version history" 
    });
  else if (!readmeHasContent)
    report.requiredActions.push({ 
      severity: "⚠️", 
      item: "README.md appears minimal", 
      action: "Expand README.md — add description, setup, and feature documentation. Check loaded skills for required sections." 
    });
  else {
    // Check for missing sections
    const missingSections = Object.entries(readmeHasSections).filter(([_, has]) => !has).map(([name, _]) => name);
    if (missingSections.length > 0) {
      report.requiredActions.push({
        severity: "⚠️",
        item: `README.md missing sections: ${missingSections.join(", ")}`,
        action: `Add missing sections to README.md: ${missingSections.join(", ")}`
      });
    }
  }
  
  if (!changelogExists)
    report.requiredActions.push({ 
      severity: "⚠️", 
      item: "CHANGELOG.md is missing from repository root", 
      action: "Create CHANGELOG.md in repository root following Keep a Changelog format (https://keepachangelog.com/)" 
    });
  else if (!changelogHasVersions)
    report.requiredActions.push({ 
      severity: "⚠️", 
      item: "CHANGELOG.md has no version entries", 
      action: "Add version entries to CHANGELOG.md (## [1.0.0] - YYYY-MM-DD format)" 
    });
  else if (!changelogHasRecent)
    report.requiredActions.push({ 
      severity: "⚠️", 
      item: "CHANGELOG.md has no recent changes", 
      action: "Add an [Unreleased] section or current version entry with recent changes" 
    });
    
  if (!hasHelpDir)
    report.requiredActions.push({ 
      severity: "⚠️", 
      item: "No help or docs folder in repository root", 
      action: "Create a help/ or docs/ folder in repository root with page/codeunit usage documentation" 
    });
    
  if (!permSetFiles.length)
    report.requiredActions.push({ 
      severity: "⚠️", 
      item: "No permission set files found", 
      action: "Add a PermissionSet.al file defining required object permissions" 
    });

  // ── 6. Overall status ────────────────────────────────────────────────────
  const errors   = report.requiredActions.filter(a => a.severity === "❌").length;
  const warnings = report.requiredActions.filter(a => a.severity === "⚠️").length;

  report.overall = errors   > 0 ? `❌ Not ready for PR — ${errors} error(s), ${warnings} warning(s)`
                 : warnings > 0 ? `⚠️ Ready with warnings — ${warnings} item(s) to address`
                                : "✅ Ready for pull request";

  // Note about next steps
  report.nextSteps = {
    note: "Review required actions above. Git operations (commit, push, PR creation) are the developer's responsibility.",
    gitWorkflow: [
      "1. Address all ❌ errors and review ⚠️ warnings",
      "2. Update documentation (README.md, CHANGELOG.md, help files) based on loaded skills/rules",
      "3. Test your changes in BC",
      "4. git add .",
      "5. git commit -m \"Your commit message\"",
      "6. git push",
      "7. Create pull request on GitHub",
    ],
    loadedRules: {
      skills: report.skills.map(s => `${s.name} (${s.source})`),
      copilotRules: copilotInstructions.map(c => c.source),
    },
  };

  return report;
}

// ── BC Dev Standards tools (local git / file-system, for local development use) ──
// Windows-first philosophy: BC development happens primarily on Windows.
// All shell commands prioritize PowerShell over bash. Non-Windows platforms are 
// supported for basic operations but may have limitations (e.g., symlinks instead of junctions).

const BC_DEV_STANDARDS_REPO = "https://github.com/OrigoSoftwareSolutions/bc-dev-standards.git";
const GITHUB_API_HOST        = "api.github.com";
// Use /bin/sh (POSIX-standard, always present) instead of /bin/bash (not available in Azure Functions runtime)
const WIN_SHELL              = process.platform === "win32" ? "powershell.exe" : "/bin/sh";

// Returns true when a path looks like a Windows absolute path (e.g. C:\Users\...)
function isWindowsPath(p) {
  return /^[A-Za-z]:[\\\/]/.test(String(p || ""));
}

function execGit(command, cwd) {
  // Always use PowerShell on Windows for consistency
  const shell = process.platform === "win32" ? "powershell.exe" : WIN_SHELL;
  return execSync(command, {
    cwd,
    stdio:    "pipe",
    encoding: "utf8",
    shell,
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

  // ── 5b. PR Gateway junction ─────────────────────────────────────────────────
  const prGatewayPath = claudePath ? `${claudePath}${sep}pr-gateway` : "";
  let prGatewayExists = false, prGatewayIsLink = false, prGatewayHasFile = false;
  try {
    if (prGatewayPath) {
      const stat = fs.lstatSync(prGatewayPath);
      prGatewayExists = true;
      prGatewayIsLink = stat.isSymbolicLink();
      try {
        prGatewayHasFile = fs.existsSync(`${prGatewayPath}${sep}PR-GATEWAY.md`);
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
  const prGatewayOk   = prGatewayExists && prGatewayIsLink;
  const mcpConfigured = mcpHasBcOrigo && mcpHasEncConn && mcpHasGithubToken && mcpHasStdRepo && mcpHasClaudeDir;
  const allGood       = repoExists && repoIsGit && claudeExists && claudeMdOk
                     && junctionOk && prGatewayOk && mcpConfigured && !!gitVersion
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
    bar(`  ${ck(prGatewayOk)}  PR Gateway junction active     : ${prGatewayHasFile ? "PR-GATEWAY.md found" : "not found"}`),
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
  if (!prGatewayOk)
    nextSteps.push({ icon: "\u274C", item: "PR Gateway junction is missing or broken",
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

  // Guard: Windows paths passed to a non-Windows server means the server is running remotely
  // and cannot access the developer's local file system.
  if (process.platform !== "win32" && (isWindowsPath(standardsRepo) || isWindowsPath(claudeDir))) {
    throw new Error(
      "update_bc_standards requires the MCP server to run locally on Windows. " +
      "The paths provided are Windows paths but this server is running on Linux. " +
      "Run the MCP server locally (node api/mcp/index.js) or update the standards manually: " +
      "cd %USERPROFILE%\\bc-dev-standards && git pull"
    );
  }

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
    note: "Skills and pr-gateway folders update automatically via the existing directory junctions.",
  };
}

async function toolSetupOrigoEnv({ standardsRepo, claudeDir } = {}) {
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  const sep         = process.platform === "win32" ? "\\" : "/";
  const repoPath    = standardsRepo || (userProfile ? `${userProfile}${sep}bc-dev-standards` : "");
  const claudePath  = claudeDir     || (userProfile ? `${userProfile}${sep}.claude`          : "");

  if (!repoPath)   throw new Error("Cannot determine standardsRepo path. Provide 'standardsRepo' parameter or set USERPROFILE env var.");
  if (!claudePath) throw new Error("Cannot determine claudeDir path. Provide 'claudeDir' parameter or set USERPROFILE env var.");

  // Guard: Windows paths passed to a non-Windows server means the server is running remotely
  // and cannot access the developer's local file system.
  if (process.platform !== "win32" && (isWindowsPath(repoPath) || isWindowsPath(claudePath))) {
    throw new Error(
      "setup_origo_bc_environment requires the MCP server to run locally on Windows. " +
      "The paths provided are Windows paths but this server is running on Linux. " +
      "Run the MCP server locally (node api/mcp/index.js) to use this tool."
    );
  }

  const steps = [];

  // 1. Check git
  let gitVersion;
  try {
    const shell = process.platform === "win32" ? "powershell.exe" : WIN_SHELL;
    gitVersion = execSync("git --version", { stdio: "pipe", encoding: "utf8", shell }).trim();
    steps.push({ step: "Check git", status: "✅", detail: gitVersion });
  } catch (e) {
    steps.push({ step: "Check git", status: "❌", detail: e.message });
    return { steps, success: false, error: "git is not available in PATH — install Git for Windows and retry." };
  }

  // 2. Clone or pull bc-dev-standards
  if (!fs.existsSync(repoPath)) {
    try {
      const shell = process.platform === "win32" ? "powershell.exe" : WIN_SHELL;
      execSync(`git clone ${BC_DEV_STANDARDS_REPO} "${repoPath}"`, { stdio: "pipe", encoding: "utf8", shell });
      steps.push({ step: "Clone bc-dev-standards", status: "✅", detail: `Cloned to ${repoPath}` });
    } catch (e) {
      steps.push({ step: "Clone bc-dev-standards", status: "❌", detail: e.message });
      return { steps, success: false };
    }
  } else {
    try {
      execGit("git pull --ff-only", repoPath);
      steps.push({ step: "Pull bc-dev-standards", status: "✅", detail: `Updated at ${repoPath}` });
    } catch (e) {
      steps.push({ step: "Pull bc-dev-standards", status: "❌", detail: e.message });
    }
  }

  // 3. Create claudeDir if absent
  if (!fs.existsSync(claudePath)) {
    try {
      fs.mkdirSync(claudePath, { recursive: true });
      steps.push({ step: "Create .claude directory", status: "✅", detail: `Created ${claudePath}` });
    } catch (e) {
      steps.push({ step: "Create .claude directory", status: "❌", detail: e.message });
      return { steps, success: false };
    }
  } else {
    steps.push({ step: "Create .claude directory", status: "✅", detail: `Already exists: ${claudePath}` });
  }

  // 4. Copy CLAUDE.md
  const claudeMdSrc  = `${repoPath}${sep}CLAUDE.md`;
  const claudeMdDest = `${claudePath}${sep}CLAUDE.md`;
  try {
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
    steps.push({ step: "Copy CLAUDE.md", status: "✅", detail: `${claudeMdSrc} → ${claudeMdDest}` });
  } catch (e) {
    steps.push({ step: "Copy CLAUDE.md", status: "❌", detail: e.message });
  }

  // 5. Create junction: claudeDir\skills → standardsRepo\skills
  const junctionLink   = `${claudePath}${sep}skills`;
  const junctionTarget = `${repoPath}${sep}skills`;
  
  // Windows-first approach: assume Windows PowerShell unless proven otherwise
  const isWindows = process.platform === "win32" || WIN_SHELL.includes("powershell");
  
  if (!isWindows) {
    steps.push({ 
      step: "Create skills junction", 
      status: "⚠️", 
      detail: "Skipped: non-Windows platforms are not fully supported. Manually create symlink with: ln -s \"" + junctionTarget + "\" \"" + junctionLink + "\""
    });
  } else {
    try {
      if (fs.existsSync(junctionLink)) {
        execSync(`Remove-Item -Path "${junctionLink}" -Force -Recurse`, { stdio: "pipe", encoding: "utf8", shell: "powershell.exe" });
      }
      execSync(`New-Item -ItemType Junction -Path "${junctionLink}" -Target "${junctionTarget}"`, { stdio: "pipe", encoding: "utf8", shell: "powershell.exe" });
      steps.push({ step: "Create skills junction", status: "✅", detail: `${junctionLink} → ${junctionTarget}` });
    } catch (e) {
      steps.push({ step: "Create skills junction", status: "❌", detail: e.message });
    }
  }

  // 6. Create junction: claudeDir\pr-gateway → standardsRepo\pr-gateway
  const prGatewayLink   = `${claudePath}${sep}pr-gateway`;
  const prGatewayTarget = `${repoPath}${sep}pr-gateway`;
  
  if (!isWindows) {
    steps.push({ 
      step: "Create pr-gateway junction", 
      status: "⚠️", 
      detail: "Skipped: non-Windows platforms are not fully supported. Manually create symlink with: ln -s \"" + prGatewayTarget + "\" \"" + prGatewayLink + "\""
    });
  } else {
    try {
      if (fs.existsSync(prGatewayLink)) {
        execSync(`Remove-Item -Path "${prGatewayLink}" -Force -Recurse`, { stdio: "pipe", encoding: "utf8", shell: "powershell.exe" });
      }
      execSync(`New-Item -ItemType Junction -Path "${prGatewayLink}" -Target "${prGatewayTarget}"`, { stdio: "pipe", encoding: "utf8", shell: "powershell.exe" });
      steps.push({ step: "Create pr-gateway junction", status: "✅", detail: `${prGatewayLink} → ${prGatewayTarget}` });
    } catch (e) {
      steps.push({ step: "Create pr-gateway junction", status: "❌", detail: e.message });
    }
  }

  return { steps, success: steps.every(s => s.status === "✅" || s.status === "⚠️") };
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
    description: "Gets all fields for a Business Central table — field names, JSON keys, captions, data types, lengths, class, primary key membership, enum values, table relation indicators (hasTableRelation), and read/write permissions. Use get_table_relations to explore a specific field's foreign-key relations.",
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
    name:        "get_table_relations",
    description: "Returns all foreign-key relationships for a specific field in a Business Central table, including conditional relation branches that resolve to different target tables depending on a field value. Uses Help.TableRelations.Get.",
    inputSchema: {
      type:       "object",
      properties: {
        table:     { type: "string",  description: "Table name (e.g. 'Sales Line') or table number as string (e.g. '37')." },
        fieldId:   { type: "integer", description: "Field number (e.g. 6 for 'No.' on Sales Line). Provide fieldId or fieldName." },
        fieldName: { type: "string",  description: "Field name (e.g. 'No.'). Used only if fieldId is not provided." },
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
    description: "Returns the aggregated total for one or more decimal fields in a Business Central table using Data.Totals.Get. Supports optional tableView filtering. Pass 'decimalField' for a single field or 'decimalFields' (array) for multiple fields in one call.",
    inputSchema: {
      type:       "object",
      properties: {
        table:         { type: "string", description: "BC table name (e.g. 'Customer', 'G/L Entry', 'Sales Line')." },
        decimalField:  { type: "string", description: "Single decimal field to total. Accepts BC field name (e.g. 'Amount') or field number as text (e.g. '15')." },
        decimalFields: { type: "array",  items: { type: "string" }, description: "Array of decimal fields to total in one call. Each item is a field name or field number as text." },
        filter:        { type: "string", description: "Optional BC tableView filter, e.g. \"WHERE(Posting Date=FILTER(>=2026-01-01&<=2026-12-31))\"." },
      },
      required: ["table"],
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
    description: "Reads records from a Business Central table with optional filter, field selection, date range, and paging. Returns up to 50 records by default (max 200).",
    inputSchema: {
      type:       "object",
      properties: {
        table:         { type: "string",  description: "BC table name (e.g. 'Customer', 'Item', 'Sales Header')." },
        filter:        { type: "string",  description: "BC-style tableView filter, e.g. \"WHERE(Blocked=CONST( ))\"." },
        fields:        { type: "array",   items: { type: "integer" }, description: "Field numbers to return (omit for all)." },
        startDateTime: { type: "string",  description: "ISO 8601 UTC datetime — filter records with SystemModifiedAt >= this value, e.g. '2026-01-01T00:00:00Z'." },
        endDateTime:   { type: "string",  description: "ISO 8601 UTC datetime — filter records with SystemModifiedAt <= this value." },
        skip:          { type: "integer", description: "Records to skip for paging (default 0)." },
        take:          { type: "integer", description: "Max records to return (default 50, max 200)." },
        lcid:          { type: "integer", description: "Language LCID for enum captions (default 1033)." },
        format:        { type: "string",  enum: ["json", "markdown"], description: "Output format: 'json' (default) or 'markdown' for LLM-friendly table output." },
      },
      required: ["table"],
    },
  },
  {
    name:        "set_records",
    description: "Creates, modifies, deletes, or upserts records in any Business Central table via Data.Records.Set. Each record must supply a primaryKey object (the BC primary key fields) and a fields object (the non-key fields to write). Mode 'upsert' (default) inserts if the record does not exist, otherwise modifies it. Before writing, the tool automatically checks (1) that the current user has write permission on the table and (2) that every field being written is covered by Change Log modification tracking when the ChangeLog Write Guard is active. Writes are blocked if either check fails — the force parameter is never used.",
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
    description: "Multi-field search for customers in Business Central. Searches across No., Name, Address, Post Code, City, Registration No., Contact, Phone No., and E-Mail in parallel. Returns deduplicated results capped at 100 IDs.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 9 customer fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_items",
    description: "Multi-field search for items/products in Business Central. Searches across No., Description, Description 2, Vendor Item No., Base Unit of Measure, and Item Category Code in parallel.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 6 item fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_vendors",
    description: "Multi-field search for vendors in Business Central. Searches across No., Name, Address, Post Code, City, Phone No., Contact, and VAT Registration No. in parallel.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 8 vendor fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_contacts",
    description: "Multi-field search for contacts in Business Central. Searches across No., Name, Company Name, Phone No., Mobile Phone No., E-Mail, City, and Post Code in parallel.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 8 contact fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_employees",
    description: "Multi-field search for active employees in Business Central. Searches across First Name, Middle Name, Last Name, Job Title, Phone No., Mobile Phone No., E-Mail, and Company E-Mail in parallel. Only returns employees with Status = Active.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 8 employee fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_gl_accounts",
    description: "Multi-field search for G/L accounts in Business Central. Searches across No., Name, Search Name, and Account Category in parallel.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 4 G/L account fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_bank_accounts",
    description: "Multi-field search for bank accounts in Business Central. Searches across No., Name, Bank Account No., IBAN, and Bank Branch No. in parallel.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 5 bank account fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_resources",
    description: "Multi-field search for resources in Business Central. Searches across No., Name, Type, Resource Group No., and Base Unit of Measure in parallel.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 5 resource fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "search_fixed_assets",
    description: "Multi-field search for fixed assets in Business Central. Searches across No., Description, Serial No., FA Class Code, FA Subclass Code, and FA Location Code in parallel.",
    inputSchema: {
      type:       "object",
      properties: {
        query: { type: "string",  description: "Search string — matched against 6 fixed asset fields simultaneously (partial match, case-insensitive)." },
        take:  { type: "integer", description: "Max results to return (default 50, max 100)." },
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
    name:        "search_records",
    description: "Generic search across any Business Central table. Preferred mode: supply 'searchFields' as an array of field names — each field is searched in parallel via Data.RecordIds.Get, IDs are deduplicated (max 100), and full records are fetched in one call. Legacy mode: supply 'nameField' (and optionally 'codeField') for the older 2-field approach. Supply 'fields' as an array of field numbers to limit the returned columns.",
    inputSchema: {
      type:       "object",
      properties: {
        table:        { type: "string",  description: "BC table name to search (e.g. 'Customer', 'G/L Account', 'Vendor')." },
        query:        { type: "string",  description: "Search string — matched as a case-insensitive substring against every field in searchFields." },
        searchFields: { type: "array", items: { type: "string" }, description: "Array of BC field names to search in parallel (e.g. ['No.', 'Name', 'Address']). Preferred over nameField/codeField." },
        nameField:    { type: "string",  description: "(Legacy) Field name for wildcard substring filter. Use searchFields instead for multi-field search." },
        codeField:    { type: "string",  description: "(Legacy) Optional field name for prefix matching. Use searchFields instead." },
        fields:       { type: "array", items: { type: "integer" }, description: "Optional array of field numbers to include in the results. Omit to return all default fields." },
        take:         { type: "integer", description: "Max records to return (default 50, max 200)." },
        lcid:         { type: "integer", description: "Language LCID for translated captions (default 1033 = English)." },
      },
      required: ["table", "query"],
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
    name:        "get_field_translation",
    description: "Returns the translated value for a single field on a specific BC record (Field.Translation.Get). Uses BC codeunit 3711 Translation.Get(). Requires table, record SystemId, field number, and language LCID.",
    inputSchema: {
      type:       "object",
      properties: {
        table:    { type: "string",  description: "BC table name or table number (e.g. 'Customer' or '18')." },
        systemId: { type: "string",  description: "Record SystemId GUID without braces (e.g. '12345678-1234-1234-1234-123456789012')." },
        fieldId:  { type: "integer", description: "Field number to retrieve translation for (e.g. 2 for Name)." },
        lcid:     { type: "integer", description: "Windows Language ID (e.g. 1039 for Icelandic, 1030 for Danish, 1033 for English)." },
      },
      required: ["table", "systemId", "fieldId", "lcid"],
    },
  },
  {
    name:        "set_field_translation",
    description: "Creates, updates, or deletes a translation for a single field on a BC record (Field.Translation.Set). Uses BC codeunit 3711 Translation.Set(). Pass an empty or omitted value to delete the translation.",
    inputSchema: {
      type:       "object",
      properties: {
        table:    { type: "string",  description: "BC table name or table number (e.g. 'Customer' or '18')." },
        systemId: { type: "string",  description: "Record SystemId GUID without braces." },
        fieldId:  { type: "integer", description: "Field number to set translation for." },
        lcid:     { type: "integer", description: "Windows Language ID (e.g. 1039 for Icelandic)." },
        value:    { type: "string",  description: "Translated text. Omit or pass empty string to delete the translation." },
      },
      required: ["table", "systemId", "fieldId", "lcid"],
    },
  },
  {
    name:        "get_field_translations",
    description: "Returns all translations for a BC record across fields and/or languages (Field.Translations.Get). Omit fieldId (or pass 0) to get all fields. Omit lcid to get all languages. Returns translationCount and a translations array with {fieldId, languageId, value} per entry.",
    inputSchema: {
      type:       "object",
      properties: {
        table:    { type: "string",  description: "BC table name or table number (e.g. 'Customer' or '18')." },
        systemId: { type: "string",  description: "Record SystemId GUID without braces." },
        fieldId:  { type: "integer", description: "Field number to filter by. Omit or pass 0 to return all translated fields." },
        lcid:     { type: "integer", description: "Windows Language ID to filter by. Omit to return all languages." },
      },
      required: ["table", "systemId"],
    },
  },
  {
    name:        "get_record_ids",
    description: "Returns SystemId + SystemModifiedAt for every record matching an optional filter and date range using Data.RecordIds.Get. Designed for fast incremental sync — no field data is returned.",
    inputSchema: {
      type:       "object",
      properties: {
        table:         { type: "string", description: "BC table name (e.g. 'Customer', 'Item')." },
        startDateTime: { type: "string", description: "ISO 8601 UTC datetime — return records modified at or after this time." },
        endDateTime:   { type: "string", description: "ISO 8601 UTC datetime — return records modified at or before this time." },
        filter:        { type: "string", description: "Optional BC tableView filter." },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_csv_records",
    description: "Exports all matching records from a BC table as a UTF-8 CSV file in Open Mirroring format (CSV.Records.Get). The full result set is returned — no pagination. Column headers follow the {fieldName}-{fieldNo} convention. System fields (Timestamp, SystemId, SystemCreatedAt, SystemCreatedBy, SystemModifiedAt, SystemModifiedBy) are always appended. A $Company column is added for per-company tables. Unsupported field types (BLOB, Media, etc.) are silently skipped.",
    inputSchema: {
      type:       "object",
      properties: {
        table:         { type: "string", description: "BC table name (e.g. 'Customer', 'Item')." },
        fieldNumbers:  { type: "array",  items: { type: "integer" }, description: "Optional list of specific field numbers to include. All non-BLOB fields returned when omitted." },
        startDateTime: { type: "string", description: "ISO 8601 UTC datetime — include only records with SystemModifiedAt >= this value." },
        endDateTime:   { type: "string", description: "ISO 8601 UTC datetime — include only records with SystemModifiedAt <= this value." },
        filter:        { type: "string", description: "Optional BC tableView filter expression, e.g. \"WHERE(Blocked = CONST( ))\"." },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_deleted_records",
    description: "Retrieves full record snapshots from the Cloud Events Delete Log for records deleted from a specified BC table (Deleted.Records.Get). Requires 'Store Record' to be enabled in Cloud Events Delete Setup for the table. Supports pagination via skip/take and date-range filtering on the deletion timestamp.",
    inputSchema: {
      type:       "object",
      properties: {
        table:         { type: "string",  description: "BC table name (e.g. 'Customer') or use tableNo." },
        fieldNumbers:  { type: "array",   items: { type: "integer" }, description: "Optional list of field numbers to include. All fields returned when omitted." },
        startDateTime: { type: "string",  description: "ISO 8601 UTC datetime — include only records deleted at or after this time." },
        endDateTime:   { type: "string",  description: "ISO 8601 UTC datetime — include only records deleted at or before this time." },
        skip:          { type: "integer", description: "Number of records to skip for pagination. Default 0." },
        take:          { type: "integer", description: "Number of records to return. Default 100, max 1000." },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_deleted_record_ids",
    description: "Returns a lightweight list of deleted record IDs and deletion timestamps from the Cloud Events Delete Log (Deleted.RecordIds.Get). Does NOT require 'Store Record' to be enabled. Designed for fast incremental deletion-sync. Returns id (SystemId GUID) and deletedAt (ISO 8601) per record. Supports pagination via skip/take and date-range filtering.",
    inputSchema: {
      type:       "object",
      properties: {
        table:         { type: "string",  description: "BC table name (e.g. 'Customer') or use tableNo." },
        startDateTime: { type: "string",  description: "ISO 8601 UTC datetime — include only records deleted at or after this time." },
        endDateTime:   { type: "string",  description: "ISO 8601 UTC datetime — include only records deleted at or before this time." },
        skip:          { type: "integer", description: "Number of records to skip for pagination. Default 0." },
        take:          { type: "integer", description: "Number of records to return. Default 100, max 1000." },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_csv_deleted_records",
    description: "Exports deleted-record audit data from the Cloud Events Delete Log as a UTF-8 CSV file (CSV.DeletedRecords.Get). Columns: systemId, tableId, tableName, deletedAt, userId. Suitable for compliance reporting and data archival. Optionally filter by table and/or date range.",
    inputSchema: {
      type:       "object",
      properties: {
        table:    { type: "string",  description: "Optional BC table name to filter by." },
        tableNo:  { type: "integer", description: "Optional BC table number to filter by." },
        fromDate: { type: "string",  description: "ISO 8601 UTC start datetime for the deletion window." },
        toDate:   { type: "string",  description: "ISO 8601 UTC end datetime for the deletion window." },
      },
    },
  },
  {
    name:        "get_table_permissions",
    description: "Returns read and write permissions for the current service principal on a Business Central table (Help.Permissions.Get).",
    inputSchema: {
      type:       "object",
      properties: {
        table: { type: "string", description: "BC table name (e.g. 'Customer', 'G/L Account')." },
      },
      required: ["table"],
    },
  },
  {
    name:        "get_customer_credit_limit",
    description: "Returns credit limit details for a customer: balance, outstanding amounts, credit limit, remaining credit (with tolerance), and whether the limit is exceeded (Customer.CreditLimit.Get).",
    inputSchema: {
      type:       "object",
      properties: {
        customerNo: { type: "string", description: "Customer number (e.g. '10000')." },
      },
      required: ["customerNo"],
    },
  },
  {
    name:        "get_customer_sales_history",
    description: "Returns a summary of items sold to a customer within a date range from posted sales invoices (Customer.SalesHistory.Get). Returns item number, description, quantity, and number of orders per item.",
    inputSchema: {
      type:       "object",
      properties: {
        customerNo: { type: "string", description: "Customer number." },
        fromDate:   { type: "string", description: "Start date (YYYY-MM-DD, required)." },
        toDate:     { type: "string", description: "End date (YYYY-MM-DD, defaults to today)." },
      },
      required: ["customerNo", "fromDate"],
    },
  },
  {
    name:        "get_item_availability",
    description: "Returns inventory or projected availability for an item, optionally filtered by location and variant (Item.Availability.Get). Response format (physical inventory or calculated quantity) depends on BC Cloud Events Setup.",
    inputSchema: {
      type:       "object",
      properties: {
        itemNo:                  { type: "string", description: "Item number." },
        requestedDeliveryDate:   { type: "string", description: "Requested delivery date (YYYY-MM-DD)." },
        variantCode:             { type: "string", description: "Item variant code." },
        locationFilter:          { type: "string", description: "BC filter syntax for locations, e.g. 'BLUE|RED'." },
      },
      required: ["itemNo"],
    },
  },
  {
    name:        "get_item_price",
    description: "Returns price list lines for an item, optionally for a specific customer, quantity, date and variant (Item.Price.Get).",
    inputSchema: {
      type:       "object",
      properties: {
        itemNo:                { type: "string",  description: "Item number." },
        customerNo:            { type: "string",  description: "Customer number for customer-specific pricing." },
        requestedDeliveryDate: { type: "string",  description: "Requested delivery date (YYYY-MM-DD)." },
        quantity:              { type: "number",  description: "Quantity (for quantity-break pricing)." },
        variantCode:           { type: "string",  description: "Item variant code." },
      },
      required: ["itemNo"],
    },
  },
  {
    name:        "release_sales_order",
    description: "Releases a sales order in Business Central (Sales.Order.Release). Returns status before/after and order details.",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Sales order number or SystemId." },
      },
      required: ["orderNo"],
    },
  },
  {
    name:        "reopen_sales_order",
    description: "Reopens a released sales order in Business Central (Sales.Order.Reopen).",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Sales order number or SystemId." },
      },
      required: ["orderNo"],
    },
  },
  {
    name:        "post_sales_order",
    description: "Posts a sales order in Business Central (Sales.Order.Post). The original order is deleted and a posted sales invoice is created. Returns the posted invoice number and totals.",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Sales order number or SystemId." },
      },
      required: ["orderNo"],
    },
  },
  {
    name:        "get_sales_document_pdf",
    description: "Downloads a PDF of a posted sales document (invoice, shipment, credit memo, or return receipt) from BC and returns it as a base64-encoded string in pdfBase64.",
    inputSchema: {
      type:       "object",
      properties: {
        documentType: { type: "string", enum: ["Invoice", "Shipment", "CreditMemo", "ReturnReceipt"], description: "Type of posted sales document." },
        documentNo:   { type: "string", description: "Document number or SystemId." },
      },
      required: ["documentType", "documentNo"],
    },
  },
  {
    name:        "get_customer_statement_pdf",
    description: "Returns a customer account statement PDF (Customer.Statement.Pdf). The PDF is returned as a base64-encoded string in pdfBase64. Optionally filter by date range.",
    inputSchema: {
      type:       "object",
      properties: {
        customerNo: { type: "string", description: "Customer number or SystemId." },
        startDate:  { type: "string", description: "Statement start date (YYYY-MM-DD). Optional." },
        endDate:    { type: "string", description: "Statement end date (YYYY-MM-DD). Optional." },
      },
      required: ["customerNo"],
    },
  },
  {
    name:        "get_purchase_order_statistics",
    description: "Returns comprehensive statistics for a purchase order (amounts, VAT totals, quantities, weight and volume) using the Purchase.Order.Statistics Cloud Event.",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Purchase order number or SystemId." },
      },
      required: ["orderNo"],
    },
  },
  {
    name:        "release_purchase_order",
    description: "Releases a purchase order in Business Central (Purchase.Order.Release). Returns status before/after and order details.",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Purchase order number or SystemId." },
      },
      required: ["orderNo"],
    },
  },
  {
    name:        "reopen_purchase_order",
    description: "Reopens a released purchase order in Business Central (Purchase.Order.Reopen).",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Purchase order number or SystemId." },
      },
      required: ["orderNo"],
    },
  },
  {
    name:        "post_purchase_order",
    description: "Posts a purchase order in Business Central (Purchase.Order.Post). The original order is deleted and a posted purchase invoice is created. Returns the posted invoice number and totals.",
    inputSchema: {
      type:       "object",
      properties: {
        orderNo: { type: "string", description: "Purchase order number or SystemId." },
      },
      required: ["orderNo"],
    },
  },
  {
    name:        "check_general_journal",
    description: "Validates a general journal batch in Business Central without posting (Finance.GeneralJournal.Check). Returns a validationResult ('Ready', 'ReadyWithWarnings', or 'NotReady') along with full error and warning details. Always run this before post_general_journal.",
    inputSchema: {
      type:       "object",
      properties: {
        subject:      { type: "string", description: "Journal batch identifier as 'TEMPLATE|BATCH' (pipe-separated), e.g. 'GENERAL|DEFAULT'. Can also be a SystemId GUID. If omitted, supply templateName and batchName separately." },
        templateName: { type: "string", description: "Journal template name (e.g. 'GENERAL'). Used together with batchName when subject is not provided." },
        batchName:    { type: "string", description: "Journal batch name (e.g. 'DEFAULT'). Used together with templateName when subject is not provided." },
      },
    },
  },
  {
    name:        "post_general_journal",
    description: "Posts a general journal batch in Business Central (Finance.GeneralJournal.Post). All journal lines are cleared from the batch after successful posting. Returns G/L register details including entry number ranges for the audit trail. Always validate with check_general_journal first.",
    inputSchema: {
      type:       "object",
      properties: {
        subject:      { type: "string", description: "Journal batch identifier as 'TEMPLATE|BATCH' (pipe-separated), e.g. 'GENERAL|BATCH001'. Can also be a SystemId GUID. If omitted, supply templateName and batchName separately." },
        templateName: { type: "string", description: "Journal template name (e.g. 'GENERAL'). Used together with batchName when subject is not provided." },
        batchName:    { type: "string", description: "Journal batch name (e.g. 'BATCH001'). Used together with templateName when subject is not provided." },
      },
    },
  },
  {
    name:        "prepare_for_pull_request",
    description: "Prepares a Business Central AL extension project for a pull request. Reads app.json, saves or verifies the app ID range in Cloud Events Storage, checks for range conflicts with other registered apps, validates the test app ID range follows the +30000 convention, reads skill files from both project-local (.claude/skills) and global skills directories, reads copilot-instructions.md and CLAUDE.md from project .github/ and .claude/ folders, performs static AL code analysis (WITH statements, CalcFields in loops, Count() vs IsEmpty(), file naming, object name length) against loaded rules, and validates documentation completeness in repository root (README.md with required sections, CHANGELOG.md following Keep a Changelog format, help/ folder, permission sets). Returns a full PR readiness report with required actions. Does NOT perform git operations — commit and push are the developer's responsibility.",
    inputSchema: {
      type:       "object",
      properties: {
        projectPath:   { type: "string", description: "Local path to the root of the BC extension project (the folder containing app.json). This is the repository root." },
        standardsRepo: { type: "string", description: "Local path to the bc-dev-standards repository. Falls back to x-standards-repo header or %USERPROFILE%\\bc-dev-standards." },
        claudeDir:     { type: "string", description: "Local path to the global .claude directory. Falls back to x-claude-dir header or %USERPROFILE%\\.claude. Project-local .claude is always checked." },
      },
      required: ["projectPath"],
    },
  },
  {
    name:        "save_app_range",
    description: "Saves a BC extension app's ID range information to the Cloud Events Storage table. Uses Source = Publisher-Name and Id = app.id as the primary key. Stores the app id, name, publisher and idRanges from app.json. Uses upsert semantics - creates new record or updates existing one based on app.id.",
    inputSchema: {
      type:       "object",
      properties: {
        appId:     { type: "string",  description: "The app GUID from app.json 'id' field. Used as the Id in the storage primary key." },
        appName:   { type: "string",  description: "The app name from app.json 'name' field." },
        publisher: { type: "string",  description: "The publisher from app.json 'publisher' field." },
        idRanges:  { type: "array",   description: "The idRanges array from app.json, e.g. [{\"from\": 65300, \"to\": 65399}].", items: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } }, required: ["from", "to"] } },
      },
      required: ["appId", "appName", "publisher", "idRanges"],
    },
  },
  {
    name:        "check_app_range",
    description: "Checks whether a given set of BC object ID ranges conflicts with any app ranges already registered in the Cloud Events Storage table. Retrieves all app range registrations (regardless of source) by scanning for records with idRanges data. Returns a list of conflicting apps and suggests the first available non-conflicting range of the same size.",
    inputSchema: {
      type:       "object",
      properties: {
        idRanges: { type: "array", description: "The ID ranges to check, e.g. [{\"from\": 65300, \"to\": 65399}].", items: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } }, required: ["from", "to"] } },
      },
      required: ["idRanges"],
    },
  },
  {
    name:        "read_app_json",
    description: "Reads the app.json file from a BC extension project and returns its contents, including the object ID ranges. Useful for verifying current configuration before making changes.",
    inputSchema: {
      type:       "object",
      properties: {
        projectPath: { type: "string", description: "Local path to the root of the BC extension project (the folder containing app.json)." },
      },
      required: ["projectPath"],
    },
  },
  {
    name:        "update_app_json_ranges",
    description: "Updates the idRanges field in the app.json file and saves it back to disk. Creates a timestamped backup of the original file by default. Returns the previous and new ranges, plus the backup path if created.",
    inputSchema: {
      type:       "object",
      properties: {
        projectPath: { type: "string", description: "Local path to the root of the BC extension project (the folder containing app.json)." },
        idRanges:    { type: "array",  description: "The new ID ranges to write, e.g. [{\"from\": 65300, \"to\": 65399}].", items: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } }, required: ["from", "to"] } },
        backup:      { type: "boolean", description: "When true (default), creates a timestamped backup of app.json before updating it." },
      },
      required: ["projectPath", "idRanges"],
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
    description: "Check the Origo BC development standards GitHub sync status and verify the full local environment setup including .claude folder, CLAUDE.md, skills junction, pr-gateway junction, and mcp.json configuration",
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
    description: "Pulls the latest changes from the bc-dev-standards GitHub repository and copies CLAUDE.md to the .claude directory. Reports the before and after commit SHAs and all commit messages applied. The skills and pr-gateway folders update automatically via the existing directory junctions. Run setup_origo_bc_environment first if the repo is not yet cloned.",
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
    description: "One-time setup: verifies git is in PATH, clones or updates bc-dev-standards to the given local path, creates the .claude directory, copies CLAUDE.md, and creates directory junctions from .claude\\skills to bc-dev-standards\\skills and from .claude\\pr-gateway to bc-dev-standards\\pr-gateway. Returns a step-by-step ✅/❌ status summary. Must be run with the MCP server running locally.",
    inputSchema: {
      type:       "object",
      properties: {
        standardsRepo: { type: "string", description: "Local path where bc-dev-standards will be cloned or updated (e.g. C:\\Users\\you\\bc-dev-standards). Falls back to the x-standards-repo request header or %USERPROFILE%\\bc-dev-standards." },
        claudeDir:     { type: "string", description: "Local path to the .claude directory (e.g. C:\\Users\\you\\.claude). Falls back to the x-claude-dir request header or %USERPROFILE%\\.claude." },
      },
    },
  },
  {
    name:        "get_next_line_no",
    description: "Returns the next available Line No. for a BC table that uses an integer last primary key field (e.g. Sales Line, Purchase Line, Gen. Journal Line). Uses the Help.NextLineNo.Get Cloud Event message type. The increment controls the step size (default 10000).",
    inputSchema: {
      type:       "object",
      properties: {
        table:      { type: "string",  description: "BC table name (e.g. 'Sales Line', 'Purchase Line', 'Gen. Journal Line')." },
        primaryKey: { type: "object",  description: "Partial primary key values to scope the line number (e.g. {\"Document Type\": \"Order\", \"Document No.\": \"S-ORD101001\"})." },
        id:         { type: "string",  description: "Record GUID (SystemId) — alternative to primaryKey for scoping." },
        increment:  { type: "integer", description: "Step size for Line No. (default 10000). BC standard is 10000." },
      },
      required: ["table"],
    },
  },
  {
    name:        "batch_records",
    description: "Reads records from multiple Business Central tables in parallel in a single call. Each request specifies its own table, filter, and field selection. Returns an array of results (one per request). Max 10 requests per batch.",
    inputSchema: {
      type:       "object",
      properties: {
        requests: {
          type:  "array",
          description: "Array of record read requests (max 10).",
          items: {
            type: "object",
            properties: {
              table:        { type: "string",  description: "BC table name." },
              filter:       { type: "string",  description: "Optional BC tableView filter." },
              fieldNumbers: { type: "array",   items: { type: "integer" }, description: "Field numbers to return (omit for all)." },
              take:         { type: "integer", description: "Max records (default 50, max 200)." },
            },
            required: ["table"],
          },
        },
      },
      required: ["requests"],
    },
  },
  {
    name:        "get_document_lines",
    description: "Convenience tool that reads document lines (Sales Line, Purchase Line, etc.) for a given document number. Automatically resolves the correct line table and applies Document Type + Document No. filters. Supports field selection and markdown output.",
    inputSchema: {
      type:       "object",
      properties: {
        documentType: { type: "string", description: "Document type: 'sales order', 'sales invoice', 'sales quote', 'sales credit memo', 'purchase order', 'purchase invoice', 'purchase quote', or 'purchase credit memo'." },
        documentNo:   { type: "string", description: "The document number (e.g. 'S-ORD101001')." },
        table:        { type: "string", description: "Explicit line table name — overrides documentType auto-detection." },
        fields:       { type: "array",  items: { type: "integer" }, description: "Field numbers to return (omit for all)." },
        take:         { type: "integer", description: "Max lines to return (default 200)." },
        lcid:         { type: "integer", description: "Language LCID for field name resolution (default 1033)." },
        format:       { type: "string",  enum: ["json", "markdown"], description: "Output format (default 'json')." },
      },
      required: ["documentNo"],
    },
  },
  {
    name:        "get_changelog_field_history",
    description: "Returns the current live value and full Change Log modification history for a specific field on a record. Entry 0 is a synthetic 'Current' entry with the live value; subsequent entries are real Change Log entries (newest first). Use 'entryNo' values with restore_changelog_field to revert.",
    inputSchema: {
      type:       "object",
      properties: {
        table:          { type: "string",  description: "BC table name (e.g. 'Customer') or number as string." },
        recordSystemId: { type: "string",  description: "SystemId GUID of the record (without braces)." },
        fieldNo:        { type: "integer", description: "Field number (from get_table_fields)." },
        fieldName:      { type: "string",  description: "Field name (alternative to fieldNo, e.g. 'Name')." },
      },
      required: ["table", "recordSystemId"],
    },
  },
  {
    name:        "restore_changelog_field",
    description: "Restores a field value from the Change Log. Mode 1: provide 'entryNo' (from get_changelog_field_history). Mode 2: provide 'table' + 'recordSystemId' + 'fieldNo'/'fieldName' + 'restoreToDateTime' (restores to the most recent Modification at or before that time). Only Modification entries can be restored.",
    inputSchema: {
      type:       "object",
      properties: {
        entryNo:           { type: "integer", description: "(Mode 1) Change Log Entry No. from get_changelog_field_history." },
        table:             { type: "string",  description: "(Mode 2) BC table name or number as string." },
        recordSystemId:    { type: "string",  description: "(Mode 2) SystemId GUID of the record." },
        fieldNo:           { type: "integer", description: "(Mode 2) Field number." },
        fieldName:         { type: "string",  description: "(Mode 2) Field name (alternative to fieldNo)." },
        restoreToDateTime: { type: "string",  description: "(Mode 2) ISO 8601 timestamp — restores to the most recent Modification at or before this time." },
      },
    },
  },
  {
    name:        "changelog_field_enabled",
    description: "Checks whether the BC Change Log feature is globally active and whether a specific field is covered by Change Log Setup for modification tracking. Also returns the ChangeLog Write Guard mode (Open / Blocked / Via force) from Cloud Events Setup.",
    inputSchema: {
      type:       "object",
      properties: {
        table:     { type: "string",  description: "BC table name (e.g. 'Customer') or number as string." },
        fieldNo:   { type: "integer", description: "Field number (from get_table_fields)." },
        fieldName: { type: "string",  description: "Field name (alternative to fieldNo, e.g. 'Name')." },
      },
      required: ["table"],
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
          case "get_table_relations": content = await toolGetTableRelations(args);  break;
          case "list_companies":        content = await toolListCompanies(args);              break;
          case "list_message_types":    content = await toolListMessageTypes(args);       break;
          case "get_message_type_help": content = await toolGetMessageTypeHelp(args);     break;
          case "call_message_type":     content = await toolCallMessageType(args);         break;
          case "get_record_count":            content = await toolGetRecordCount(args);            break;
          case "get_decimal_total":           content = await toolGetDecimalTotal(args);           break;
          case "get_sales_order_statistics":  content = await toolGetSalesOrderStatistics(args);   break;
          case "get_record_ids":              content = await toolGetRecordIds(args);               break;
          case "get_csv_records":             content = await toolGetCsvRecords(args);              break;
          case "get_deleted_records":         content = await toolGetDeletedRecords(args);          break;
          case "get_deleted_record_ids":      content = await toolGetDeletedRecordIds(args);        break;
          case "get_csv_deleted_records":     content = await toolGetCsvDeletedRecords(args);       break;
          case "get_table_permissions":       content = await toolGetTablePermissions(args);        break;
          case "get_customer_credit_limit":   content = await toolGetCustomerCreditLimit(args);     break;
          case "get_customer_sales_history":  content = await toolGetCustomerSalesHistory(args);    break;
          case "get_item_availability":       content = await toolGetItemAvailability(args);        break;
          case "get_item_price":              content = await toolGetItemPrice(args);               break;
          case "release_sales_order":         content = await toolReleaseSalesOrder(args);          break;
          case "reopen_sales_order":          content = await toolReopenSalesOrder(args);           break;
          case "post_sales_order":            content = await toolPostSalesOrder(args);             break;
          case "get_sales_document_pdf":      content = await toolGetSalesDocumentPdf(args);        break;
          case "get_customer_statement_pdf":   content = await toolGetCustomerStatementPdf(args);   break;
          case "get_purchase_order_statistics": content = await toolGetPurchaseOrderStatistics(args); break;
          case "release_purchase_order":      content = await toolReleasePurchaseOrder(args);       break;
          case "reopen_purchase_order":       content = await toolReopenPurchaseOrder(args);        break;
          case "post_purchase_order":         content = await toolPostPurchaseOrder(args);          break;
          case "check_general_journal":        content = await toolCheckGeneralJournal(args);       break;
          case "post_general_journal":         content = await toolPostGeneralJournal(args);        break;
          case "get_records":           content = await toolGetRecords(args);              break;
          case "set_records":           content = await toolSetRecords(args);              break;
          case "search_customers":    content = await toolSearchCustomers(args);    break;
          case "search_items":         content = await toolSearchItems(args);         break;
          case "search_vendors":       content = await toolSearchVendors(args);       break;
          case "search_contacts":      content = await toolSearchContacts(args);      break;
          case "search_employees":     content = await toolSearchEmployees(args);     break;
          case "search_gl_accounts":   content = await toolSearchGlAccounts(args);    break;
          case "search_bank_accounts": content = await toolSearchBankAccounts(args);  break;
          case "search_resources":     content = await toolSearchResources(args);     break;
          case "search_fixed_assets":  content = await toolSearchFixedAssets(args);   break;
          case "search_records":       content = await toolSearchRecords(args);       break;
          case "list_translations":            content = await toolListTranslations(args);            break;
          case "set_translations":             content = await toolSetTranslations(args);             break;
          case "get_field_translation":        content = await toolGetFieldTranslation(args);         break;
          case "set_field_translation":        content = await toolSetFieldTranslation(args);         break;
          case "get_field_translations":       content = await toolGetFieldTranslations(args);        break;
          case "get_integration_timestamp":     content = await toolGetIntegrationTimestamp(args);     break;
          case "set_integration_timestamp":     content = await toolSetIntegrationTimestamp(args);     break;
          case "reverse_integration_timestamp": content = await toolReverseIntegrationTimestamp(args); break;
          case "prepare_for_pull_request":      content = await toolPrepareForPullRequest(args);      break;
          case "save_app_range":                content = await toolSaveAppRange(args);                break;
          case "check_app_range":               content = await toolCheckAppRange(args);               break;
          case "read_app_json":                 content = await toolReadAppJson(args);                 break;
          case "update_app_json_ranges":        content = await toolUpdateAppJsonRanges(args);         break;
          case "set_config":                    content = await toolSetConfig(args);                    break;
          case "get_config":                    content = await toolGetConfig(args);                    break;
          case "encrypt_data":                  content = toolEncryptData(args);                       break;
          case "decrypt_data":                  content = toolDecryptData(args, { allowExternal: !!allowDecrypt }); break;
          case "check_standards_status":        content = await toolCheckStandardsStatus(args);        break;
          case "update_bc_standards":           content = await toolUpdateBcStandards(args);           break;
          case "setup_origo_bc_environment":    content = await toolSetupOrigoEnv(args);               break;
          case "get_next_line_no":               content = await toolGetNextLineNo(args);               break;
          case "batch_records":                  content = await toolBatchRecords(args);                break;
          case "get_document_lines":             content = await toolGetDocumentLines(args);            break;
          case "get_changelog_field_history":    content = await toolGetChangelogFieldHistory(args);    break;
          case "restore_changelog_field":        content = await toolRestoreChangelogField(args);       break;
          case "changelog_field_enabled":        content = await toolChangelogFieldEnabled(args);       break;
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
            resourceTemplates: [
              { uriTemplate: "bc://tables/{tableName}",        name: "Table Fields",         mimeType: "application/json", description: "Returns all fields for a BC table (e.g. bc://tables/Customer)." },
              { uriTemplate: "bc://message-types/{typeName}",  name: "Message Type Help",    mimeType: "application/json", description: "Returns help/documentation for a Cloud Event message type (e.g. bc://message-types/Customer.Create)." },
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
              {
                name: "vendor_lookup_pattern",
                description: "Returns a vendor lookup guide with the complete live Vendor field table for this BC instance.",
                arguments: [],
              },
              {
                name: "gl_account_lookup_pattern",
                description: "Returns a G/L account lookup guide with the complete live G/L Account field table for this BC instance.",
                arguments: [],
              },
              {
                name: "bank_account_lookup_pattern",
                description: "Returns a bank account lookup guide with the complete live Bank Account field table for this BC instance.",
                arguments: [],
              },
              {
                name: "resource_lookup_pattern",
                description: "Returns a resource lookup guide with the complete live Resource field table for this BC instance.",
                arguments: [],
              },
              {
                name: "employee_lookup_pattern",
                description: "Returns an employee lookup guide with the complete live Employee field table for this BC instance.",
                arguments: [],
              },
              {
                name: "purchase_order_creation_workflow",
                description: "Returns a step-by-step purchase order creation recipe pre-populated with the live Purchase Header and Purchase Line field names for this BC instance.",
                arguments: [
                  { name: "lcid", description: "Language LCID for field captions (default 1033)", required: false },
                ],
              },
              {
                name: "general_journal_creation_workflow",
                description: "Returns a step-by-step general journal line creation recipe pre-populated with the live Gen. Journal Line field names for this BC instance.",
                arguments: [
                  { name: "lcid", description: "Language LCID for field captions (default 1033)", required: false },
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
        } else if (promptName === "vendor_lookup_pattern") {
          const data = await toolGetTableFields({ table: "Vendor", format: "markdown" });
          text = `## Vendor Lookup Pattern\n\n` +
            `Company: **${data.company}**\n\n` +
            `Use \`Data.Records.Get\` with \`tableName: "Vendor"\`.\n\n` +
            `**tableView filter examples:**\n` +
            `- By No. (exact): \`WHERE(No.=FILTER(V00001))\`\n` +
            `- By name (wildcard): \`WHERE(Name=FILTER(*World*))\`\n` +
            `- Either: \`WHERE(No.=FILTER(V*)|Name=FILTER(*World*))\`\n` +
            `- Unblocked only: \`WHERE(Blocked=CONST( ))\`\n\n` +
            `To limit fields returned, pass a \`fieldNumbers\` array (e.g. \`[1,2,5,8,23,35]\` for No., Name, Address, Phone, Contact, Country).\n\n` +
            `**All Vendor fields in this BC instance:**\n${data.markdown}`;
        } else if (promptName === "gl_account_lookup_pattern") {
          const data = await toolGetTableFields({ table: "G/L Account", format: "markdown" });
          text = `## G/L Account Lookup Pattern\n\n` +
            `Company: **${data.company}**\n\n` +
            `Use \`Data.Records.Get\` with \`tableName: "G/L Account"\`.\n\n` +
            `**tableView filter examples:**\n` +
            `- By No. (exact): \`WHERE(No.=FILTER(6110))\`\n` +
            `- By No. range: \`WHERE(No.=FILTER(6000..6999))\`\n` +
            `- By name (wildcard): \`WHERE(Name=FILTER(*Sales*))\`\n` +
            `- Income statement only: \`WHERE(Income/Balance=CONST(Income Statement))\`\n` +
            `- Not blocked: \`WHERE(Blocked=CONST(No))\`\n` +
            `- Posting accounts only: \`WHERE(Account Type=CONST(Posting))\`\n\n` +
            `To limit fields returned, pass a \`fieldNumbers\` array (e.g. \`[1,2,4,6,9,43]\` for No., Name, Account Type, Income/Balance, Balance, Blocked).\n\n` +
            `**All G/L Account fields in this BC instance:**\n${data.markdown}`;
        } else if (promptName === "bank_account_lookup_pattern") {
          const data = await toolGetTableFields({ table: "Bank Account", format: "markdown" });
          text = `## Bank Account Lookup Pattern\n\n` +
            `Company: **${data.company}**\n\n` +
            `Use \`Data.Records.Get\` with \`tableName: "Bank Account"\`.\n\n` +
            `**tableView filter examples:**\n` +
            `- By No. (exact): \`WHERE(No.=FILTER(CHECKING))\`\n` +
            `- By name (wildcard): \`WHERE(Name=FILTER(*Savings*))\`\n` +
            `- By currency: \`WHERE(Currency Code=CONST(USD))\`\n` +
            `- Not blocked: \`WHERE(Blocked=CONST( ))\`\n\n` +
            `To limit fields returned, pass a \`fieldNumbers\` array (e.g. \`[1,2,3,5,7,22,24]\` for No., Name, Bank Account No., Contact, Phone No., Currency Code, Balance).\n\n` +
            `**All Bank Account fields in this BC instance:**\n${data.markdown}`;
        } else if (promptName === "resource_lookup_pattern") {
          const data = await toolGetTableFields({ table: "Resource", format: "markdown" });
          text = `## Resource Lookup Pattern\n\n` +
            `Company: **${data.company}**\n\n` +
            `Use \`Data.Records.Get\` with \`tableName: "Resource"\`.\n\n` +
            `**tableView filter examples:**\n` +
            `- By No. (exact): \`WHERE(No.=FILTER(R00001))\`\n` +
            `- By name (wildcard): \`WHERE(Name=FILTER(*Design*))\`\n` +
            `- People only: \`WHERE(Type=CONST(Person))\`\n` +
            `- Machines only: \`WHERE(Type=CONST(Machine))\`\n` +
            `- Not blocked: \`WHERE(Blocked=CONST(No))\`\n\n` +
            `To limit fields returned, pass a \`fieldNumbers\` array (e.g. \`[1,2,3,8,10,14,20]\` for No., Type, Name, Base Unit of Measure, Direct Unit Cost, Unit Price, Blocked).\n\n` +
            `**All Resource fields in this BC instance:**\n${data.markdown}`;
        } else if (promptName === "employee_lookup_pattern") {
          const data = await toolGetTableFields({ table: "Employee", format: "markdown" });
          text = `## Employee Lookup Pattern\n\n` +
            `Company: **${data.company}**\n\n` +
            `Use \`Data.Records.Get\` with \`tableName: "Employee"\`.\n\n` +
            `**tableView filter examples:**\n` +
            `- By No. (exact): \`WHERE(No.=FILTER(E00001))\`\n` +
            `- By name (wildcard): \`WHERE(First Name=FILTER(*John*))\`\n` +
            `- By last name: \`WHERE(Last Name=FILTER(*Smith*))\`\n` +
            `- Active only: \`WHERE(Status=CONST(Active))\`\n` +
            `- By department: \`WHERE(Department Code=FILTER(SALES))\`\n\n` +
            `To limit fields returned, pass a \`fieldNumbers\` array (e.g. \`[1,2,3,4,5,11,18,25,90]\` for No., First Name, Middle Name, Last Name, Address, Phone No., E-Mail, Status).\n\n` +
            `**All Employee fields in this BC instance:**\n${data.markdown}`;
        } else if (promptName === "purchase_order_creation_workflow") {
          const lcid = Number(promptArgs.lcid) || 1033;
          const [headerData, lineData] = await Promise.all([
            toolGetTableFields({ table: "Purchase Header", lcid, format: "markdown" }),
            toolGetTableFields({ table: "Purchase Line",   lcid, format: "markdown" }),
          ]);
          text = `## Purchase Order Creation Workflow\n\n` +
            `Company: **${headerData.company}**\n\n` +
            `This requires three \`Data.Records.Set\` calls via the Cloud Events API.\n\n` +
            `### Step 1 — Create the Purchase Header\n` +
            `Send \`Data.Records.Set\` with \`tableName: "Purchase Header"\` and \`mode: "insert"\`.\n` +
            `Key fields: \`buyFromVendorNo\` (vendor No.), \`orderDate\`, \`documentType\` = \`"Order"\`.\n\n` +
            `**All Purchase Header fields (${headerData.company}):**\n${headerData.markdown}\n\n` +
            `### Step 2 — Read back the assigned No.\n` +
            `The response record contains the full header. Read \`fields.no\` — this is the document number used in steps 3+.\n\n` +
            `### Step 3 — Create Purchase Lines\n` +
            `For each product line, send \`Data.Records.Set\` with \`tableName: "Purchase Line"\`, \`mode: "insert"\`.\n` +
            `Key fields: \`documentType\` = \`"Order"\`, \`documentNo\` (from step 2), \`lineNo\` (10000, 20000, …), \`type\` = \`"Item"\`, \`no\` (item No.), \`quantity\`.\n` +
            `Use \`get_next_line_no\` tool to determine the correct lineNo if appending to an existing order.\n\n` +
            `**All Purchase Line fields (${headerData.company}):**\n${lineData.markdown}`;
        } else if (promptName === "general_journal_creation_workflow") {
          const lcid = Number(promptArgs.lcid) || 1033;
          const lineData = await toolGetTableFields({ table: "Gen. Journal Line", lcid, format: "markdown" });
          text = `## General Journal Line Creation Workflow\n\n` +
            `Company: **${lineData.company}**\n\n` +
            `General journal lines are created via \`Data.Records.Set\` with \`tableName: "Gen. Journal Line"\` and \`mode: "insert"\`.\n\n` +
            `### Key Concepts\n` +
            `- Each line belongs to a **Journal Template** + **Journal Batch** (primary key fields)\n` +
            `- Line No. is an auto-incrementing integer — use \`get_next_line_no\` tool to get the next available value\n` +
            `- After creating lines, use \`check_general_journal\` to validate, then \`post_general_journal\` to post\n\n` +
            `### Step 1 — Create the Journal Line\n` +
            `Key fields: \`journalTemplateName\`, \`journalBatchName\`, \`lineNo\`, \`postingDate\`, \`documentNo\`, \`accountType\`, \`accountNo\`, \`amount\`.\n` +
            `For balanced entries, create two lines: one debit and one credit.\n\n` +
            `### Step 2 — Validate\n` +
            `Call \`check_general_journal\` with the template and batch name to verify the journal is balanced.\n\n` +
            `### Step 3 — Post\n` +
            `Call \`post_general_journal\` with the template and batch name.\n\n` +
            `**All Gen. Journal Line fields (${lineData.company}):**\n${lineData.markdown}`;
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
        "Access-Control-Allow-Headers": "Content-Type, x-encrypted-conn, x-company-id, x-bc-tenant, x-bc-client-id, x-bc-client-secret, x-bc-environment, x-bc-company, x-github-token, x-standards-repo, x-claude-dir",
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
