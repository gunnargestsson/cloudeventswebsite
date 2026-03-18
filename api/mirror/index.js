"use strict";

const https = require("https");
const crypto = require("crypto");
const { format } = require("date-fns");
const { ClientSecretCredential } = require("@azure/identity");
const { DataLakeServiceClient } = require("@azure/storage-file-datalake");

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  globalThis.crypto = crypto.webcrypto;
}

const BC_HOST = "api.businesscentral.dynamics.com";
const MSFT_HOST = "login.microsoftonline.com";
const SOURCE = "BC Open Mirror";
const CS_TABLE = "Cloud Events Storage";
const CI_TABLE = "Cloud Events Integration";
const CONFIG_CONN_ID = "11111111-1111-1111-1111-000000000001";
const CONFIG_TABLES_ID = "11111111-1111-1111-1111-000000000002";

const SUPPORTED_TYPES = new Set([
  "BigInteger",
  "Boolean",
  "Code",
  "Date",
  "DateFormula",
  "DateTime",
  "Decimal",
  "Duration",
  "Guid",
  "Integer",
  "Option",
  "Text",
  "Time",
]);

const _tokenCache = new Map();

module.exports = async function (context, req) {
  try {
    const action = req.body?.action;
    const companyId = req.body?.companyId || req.headers?.["x-bc-company"] || req.headers?.["x-company-id"];

    if (!companyId) return json(400, { error: "companyId is required" });
    if (!action) return json(400, { error: "action is required" });

    const conn = resolveConn(req.headers || {});
    const token = await getToken(conn);

    let result;
    switch (action) {
      case "getMirrorInfo":
        result = getMirrorInfo();
        break;
      case "getSettings":
        result = await getSettings(conn, token, companyId);
        break;
      case "saveMirrorConnection":
        result = await saveMirrorConnection(conn, token, companyId, req.body?.connection);
        break;
      case "verifyMirrorConnection":
        result = await verifyMirrorConnection(req.body?.connection);
        break;
      case "getTableConfigs":
      case "getCompanyMirrors":
        result = await getTableConfigs(conn, token, companyId);
        break;
      case "saveTableConfigs":
        result = await saveTableConfigs(conn, token, companyId, req.body?.tables);
        break;
      case "activateTable":
        result = await activateTable(conn, token, companyId, Number(req.body?.tableId));
        break;
      case "deactivateTable":
        result = await deactivateTable(conn, token, companyId, Number(req.body?.tableId));
        break;
      case "runMirror":
      case "runNow":
        result = await runMirror(conn, token, companyId, Number(req.body?.tableId));
        break;
      case "runAllActive":
        result = await runAllActive(conn, token, companyId);
        break;
      case "upload-ddl":
        result = await uploadDdlOnly(conn, token, companyId, Number(req.body?.tableId));
        break;
      default:
        return json(400, { error: `Unknown action: ${action}` });
    }

    return json(200, result);
  } catch (error) {
    context.log(`Mirror API Error: ${error.message}`);
    return json(500, { error: error.message });
  }
};

function json(status, body) {
  return { status, headers: { "Content-Type": "application/json" }, body };
}

function resolveConn(headers = {}) {
  const tenantId = headers["x-bc-tenant"] || process.env.BC_TENANT_ID;
  const clientId = headers["x-bc-client-id"] || process.env.BC_CLIENT_ID;
  const clientSecret = headers["x-bc-client-secret"] || process.env.BC_CLIENT_SECRET;
  const environment = headers["x-bc-environment"] || process.env.BC_ENVIRONMENT || "production";
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Missing credentials: provide x-bc-* headers or configure server BC_* environment variables");
  }
  return { tenantId, clientId, clientSecret, environment };
}

async function getToken(conn) {
  const key = `${conn.tenantId}|${conn.clientId}`;
  const cached = _tokenCache.get(key);
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: conn.clientId,
    client_secret: conn.clientSecret,
    scope: "https://api.businesscentral.dynamics.com/.default",
  }).toString();
  const raw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: MSFT_HOST,
      path: `/${conn.tenantId}/oauth2/v2.0/token`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(form, "utf8"),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.write(form);
    req.end();
  });

  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`Token error (${parsed.error}): ${parsed.error_description || ""}`);
  if (!parsed.access_token) throw new Error("No access_token returned");
  _tokenCache.set(key, { token: parsed.access_token, expiry: Date.now() + Number(parsed.expires_in || 3600) * 1000 });
  return parsed.access_token;
}

function httpsJson(hostname, path, method, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj), "utf8");
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...headers,
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": body.length,
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
            return;
          }
          if (!raw) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Invalid JSON response: ${raw.slice(0, 400)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function bcTask(conn, token, companyId, type, subject, data) {
  const { tenantId, environment } = conn;
  const envelope = { specversion: "1.0", type, source: SOURCE };
  if (subject !== undefined && subject !== null) envelope.subject = String(subject);
  if (data !== undefined && data !== null) envelope.data = JSON.stringify(data);

  const taskPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
  const task = await httpsJson(BC_HOST, taskPath, "POST", { Authorization: `Bearer ${token}` }, envelope);

  if (task.status === "Error") throw new Error(task.error || "BC task failed");
  if (!task.data || !String(task.data).startsWith("https://")) return task;

  const taskUrl = new URL(task.data);
  const result = await httpsJson(taskUrl.hostname, taskUrl.pathname + taskUrl.search, "GET", { Authorization: `Bearer ${token}` }, null);
  if (result.status === "Error") throw new Error(result.error || "BC result failed");
  return result;
}

async function dataRecordsGet(conn, token, companyId, payload) {
  return bcTask(conn, token, companyId, "Data.Records.Get", null, payload);
}

async function dataRecordsSet(conn, token, companyId, tableName, payload) {
  return bcTask(conn, token, companyId, "Data.Records.Set", tableName, payload);
}

function getEncryptionKey() {
  const hex = process.env.MCP_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("MCP_ENCRYPTION_KEY must be set to 64 hex chars");
  }
  return Buffer.from(hex, "hex");
}

function encryptText(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptText(ciphertext) {
  const key = getEncryptionKey();
  const raw = Buffer.from(String(ciphertext), "base64");
  if (raw.length < 28) throw new Error("Invalid encrypted payload");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function decodeStorageData(record) {
  const blob = record?.fields?.Data;
  if (!blob) return null;
  return Buffer.from(blob, "base64").toString("utf8");
}

async function getConfig(conn, token, companyId, id) {
  const result = await dataRecordsGet(conn, token, companyId, {
    tableName: CS_TABLE,
    tableView: `WHERE(Source=CONST(${SOURCE}),Id=CONST(${id}))`,
    skip: 0,
    take: 1,
  });
  const rows = result.result || result.value || [];
  if (!rows.length) return null;
  return decodeStorageData(rows[0]);
}

async function setConfig(conn, token, companyId, id, plainText) {
  const blobValue = Buffer.from(String(plainText), "utf8").toString("base64");
  await dataRecordsSet(conn, token, companyId, CS_TABLE, {
    mode: "upsert",
    data: [{
      primaryKey: { Source: SOURCE, Id: id },
      fields: { Data: blobValue },
    }],
  });
}

async function getMirrorConnection(conn, token, companyId) {
  const encrypted = await getConfig(conn, token, companyId, CONFIG_CONN_ID);
  if (!encrypted) return null;
  const parsed = JSON.parse(decryptText(encrypted));
  return parsed;
}

async function setMirrorConnection(connCtx, token, companyId, conn) {
  const ciphertext = encryptText(JSON.stringify(conn));
  await setConfig(connCtx, token, companyId, CONFIG_CONN_ID, ciphertext);
}

async function getStoredTables(conn, token, companyId) {
  const raw = await getConfig(conn, token, companyId, CONFIG_TABLES_ID);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function setStoredTables(conn, token, companyId, tables) {
  await setConfig(conn, token, companyId, CONFIG_TABLES_ID, JSON.stringify(tables));
}

function normalizeTableConfig(table) {
  return {
    tableId: Number(table.tableId),
    tableName: String(table.tableName || ""),
    dataPerCompany: Boolean(table.dataPerCompany),
    fieldNumbers: Array.isArray(table.fieldNumbers) ? table.fieldNumbers.map(Number).filter((n) => n >= 1 && n <= 1999999999) : [],
    tableView: String(table.tableView || ""),
    intervalMin: Math.max(1, Number(table.intervalMin || 60)),
    active: Boolean(table.active),
  };
}

async function withTableRefFallback(tableCfg, callback) {
  const refs = [];
  const nameRef = String(tableCfg?.tableName || "").trim();
  const idRef = Number(tableCfg?.tableId) > 0 ? String(Number(tableCfg.tableId)) : "";
  if (nameRef) refs.push(nameRef);
  if (idRef && !refs.includes(idRef)) refs.push(idRef);
  if (!refs.length) throw new Error("tableName or tableId is required");

  let lastError;
  for (const ref of refs) {
    try {
      return await callback(ref);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Unable to resolve table reference");
}

function resolveTableName(tableCfg, fields) {
  const fromFields = Array.isArray(fields) && fields.length
    ? String(fields[0].tableName || fields[0].table || "").trim()
    : "";
  if (fromFields) return fromFields;
  const fallback = String(tableCfg?.tableName || "").trim();
  if (fallback) return fallback;
  return `Table${Number(tableCfg?.tableId || 0)}`;
}

function getMirrorInfo() {
  return {
    source: SOURCE,
    configIds: {
      mirrorConnection: CONFIG_CONN_ID,
      tableConfig: CONFIG_TABLES_ID,
    },
    fieldsMetadata: [
      { name: "tableId", label: "Table ID", type: "integer" },
      { name: "tableName", label: "Table Name", type: "text" },
      { name: "dataPerCompany", label: "Data Per Company", type: "boolean" },
      { name: "fieldNumbers", label: "Field Numbers", type: "array" },
      { name: "tableView", label: "Table View", type: "text" },
      { name: "intervalMin", label: "Interval Minutes", type: "integer" },
      { name: "active", label: "Active", type: "boolean" },
    ],
  };
}

async function getSettings(conn, token, companyId) {
  const [connection, tables] = await Promise.all([
    getMirrorConnection(conn, token, companyId),
    getStoredTables(conn, token, companyId),
  ]);

  return {
    connection: connection || {
      mirrorUrl: "",
      tenant: "",
      clientId: "",
      clientSecret: "",
      status: "unverified",
    },
    tables,
  };
}

async function verifyMirrorConnection(connection) {
  const conn = sanitizeConnection(connection);
  const parsed = parseMirrorUrl(conn.mirrorUrl);
  const credential = new ClientSecretCredential(conn.tenant, conn.clientId, conn.clientSecret);

  // OneLake/Fabric can reject some filesystem probe operations even when auth/path are valid.
  // For OneLake we verify by acquiring a storage token and validating URL shape only.
  if (/\.dfs\.fabric\.microsoft\.com$/i.test(parsed.accountHost)) {
    await credential.getToken("https://storage.azure.com/.default");
    return { verified: true };
  }

  const serviceClient = createDataLakeServiceClient(conn.mirrorUrl, credential);
  const { fileSystemName, basePath } = parsed;
  const fs = serviceClient.getFileSystemClient(fileSystemName);

  try {
    await fs.exists();
    if (basePath) {
      const dir = fs.getDirectoryClient(basePath);
      await dir.exists();
    }
  } catch (error) {
    const message = String(error?.message || "");
    if (/operation not supported on the specified endpoint/i.test(message)) {
      if (/\.blob\.core\.windows\.net$/i.test(parsed.accountHost)) {
        throw new Error("Mirror URL must use the DFS endpoint. Replace '.blob.core.windows.net' with '.dfs.core.windows.net'.");
      }
      throw new Error("The mirror endpoint rejected the verification operation. Use an ADLS Gen2 DFS URL (or OneLake-compatible DFS path) and verify tenant/client permissions.");
    }
    throw error;
  }

  return { verified: true };
}

function sanitizeConnection(connection) {
  if (!connection) throw new Error("connection is required");
  const mirrorUrl = String(connection.mirrorUrl || "").trim();
  const tenant = String(connection.tenant || "").trim();
  const clientId = String(connection.clientId || "").trim();
  const clientSecret = String(connection.clientSecret || "").trim();
  const status = connection.status === "verified" ? "verified" : "unverified";

  if (!mirrorUrl || !tenant || !clientId || !clientSecret) {
    throw new Error("mirrorUrl, tenant, clientId and clientSecret are required");
  }

  return { mirrorUrl, tenant, clientId, clientSecret, status };
}

async function saveMirrorConnection(connCtx, token, companyId, connection) {
  const conn = sanitizeConnection(connection);
  await setMirrorConnection(connCtx, token, companyId, conn);
  return { saved: true, status: conn.status };
}

async function getTableConfigs(conn, token, companyId) {
  const tables = await getStoredTables(conn, token, companyId);
  return { mirrors: tables, count: tables.length };
}

async function saveTableConfigs(conn, token, companyId, tables) {
  if (!Array.isArray(tables)) throw new Error("tables must be an array");
  const normalized = tables.map(normalizeTableConfig);
  await setStoredTables(conn, token, companyId, normalized);
  return { saved: true, count: normalized.length, mirrors: normalized };
}

async function activateTable(conn, token, companyId, tableId) {
  if (!tableId) throw new Error("tableId is required");
  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified") {
    throw new Error("Mirror connection must be verified before activation");
  }

  const tables = await getStoredTables(conn, token, companyId);
  const idx = tables.findIndex((t) => Number(t.tableId) === Number(tableId));
  if (idx < 0) throw new Error(`Table ${tableId} is not configured`);

  const tableCfg = normalizeTableConfig(tables[idx]);
  await uploadDdl(conn, token, companyId, connection, tableCfg);

  tableCfg.active = true;
  tables[idx] = tableCfg;
  await setStoredTables(conn, token, companyId, tables);

  return { activated: true, tableId, tableName: tableCfg.tableName };
}

async function deactivateTable(conn, token, companyId, tableId) {
  if (!tableId) throw new Error("tableId is required");
  const tables = await getStoredTables(conn, token, companyId);
  const idx = tables.findIndex((t) => Number(t.tableId) === Number(tableId));
  if (idx < 0) throw new Error(`Table ${tableId} is not configured`);
  tables[idx] = { ...normalizeTableConfig(tables[idx]), active: false };
  await setStoredTables(conn, token, companyId, tables);
  return { deactivated: true, tableId };
}

async function uploadDdlOnly(conn, token, companyId, tableId) {
  if (!tableId) throw new Error("tableId is required");
  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified") throw new Error("Verified mirror connection is required");
  const tables = await getStoredTables(conn, token, companyId);
  const cfg = tables.find((t) => Number(t.tableId) === Number(tableId));
  if (!cfg) throw new Error(`Table ${tableId} is not configured`);
  await uploadDdl(conn, token, companyId, connection, normalizeTableConfig(cfg));
  return { uploaded: true, tableId };
}

function ciTableView(tableId) {
  return `SORTING(Source,Table Id,Date & Time) ORDER(Descending) WHERE(Source=CONST(${SOURCE}),Table Id=CONST(${tableId}),Reversed=CONST(false))`;
}

async function getIntegrationTimestamp(conn, token, companyId, tableId) {
  const result = await dataRecordsGet(conn, token, companyId, {
    tableName: CI_TABLE,
    tableView: ciTableView(tableId),
    skip: 0,
    take: 1,
  });
  const records = result.result || result.value || [];
  if (!records.length) return null;
  return records[0]?.primaryKey?.DateTime || null;
}

async function setIntegrationTimestamp(conn, token, companyId, tableId, dateTime) {
  await dataRecordsSet(conn, token, companyId, CI_TABLE, {
    data: [{
      primaryKey: {
        Source: SOURCE,
        TableId: Number(tableId),
        DateTime: String(dateTime),
      },
      fields: { Reversed: "false" },
    }],
  });
}

async function reverseIntegrationTimestamp(conn, token, companyId, tableId) {
  const result = await dataRecordsGet(conn, token, companyId, {
    tableName: CI_TABLE,
    tableView: ciTableView(tableId),
    skip: 0,
    take: 1,
  });
  const records = result.result || result.value || [];
  if (!records.length) return;
  const dateTime = records[0]?.primaryKey?.DateTime;
  if (!dateTime) return;

  await dataRecordsSet(conn, token, companyId, CI_TABLE, {
    mode: "modify",
    data: [{
      primaryKey: {
        Source: SOURCE,
        TableId: Number(tableId),
        DateTime: String(dateTime),
      },
      fields: { Reversed: "true" },
    }],
  });
}

function isoNoMs(dateObj) {
  return dateObj.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function appendWhere(baseView, clause) {
  const s = String(baseView || "").trim();
  if (!s) return `WHERE(${clause})`;
  if (/\bWHERE\(/i.test(s)) {
    return s.replace(/\)\s*$/, `,${clause})`);
  }
  return `${s} WHERE(${clause})`;
}

function buildRunTableView(tableCfg, startIso, endIso) {
  if (!startIso) return tableCfg.tableView || "";
  const range = `SystemModifiedAt=FILTER(${startIso}..${endIso})`;
  return appendWhere(tableCfg.tableView, range);
}

function parseMirrorUrl(urlString) {
  const u = new URL(urlString);
  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length) throw new Error("mirrorUrl must include a filesystem/container path");
  return {
    accountHost: u.hostname,
    fileSystemName: parts[0],
    basePath: parts.slice(1).join("/"),
  };
}

function normalizeAccountHost(host) {
  const value = String(host || "").trim();
  if (/\.blob\.core\.windows\.net$/i.test(value)) {
    return value.replace(/\.blob\.core\.windows\.net$/i, ".dfs.core.windows.net");
  }
  return value;
}

function createDataLakeServiceClient(mirrorUrl, credential) {
  const { accountHost } = parseMirrorUrl(mirrorUrl);
  const normalizedHost = normalizeAccountHost(accountHost);
  return new DataLakeServiceClient(`https://${normalizedHost}`, credential);
}

function pathJoin(...segments) {
  return segments.filter(Boolean).map((s) => String(s).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function parseTableRef(tableRef) {
  const raw = String(tableRef || "").trim();
  if (!raw) throw new Error("tableRef is required");
  if (/^\d+$/.test(raw)) {
    const tableNumber = Number(raw);
    if (!Number.isFinite(tableNumber) || tableNumber < 1) {
      throw new Error(`Invalid table number: ${raw}`);
    }
    return { tableNumber };
  }
  return { tableName: raw };
}

function formatMirrorFileStamp(dateObj) {
  return format(dateObj, "yyyyMMdd_HHmmss_SSS");
}

function washName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9%]/g, "");
}

function mapDdlType(fieldType, fieldLength) {
  switch (fieldType) {
    case "Text":
    case "Code":
      return { columnDataType: "varchar", columnLength: Number(fieldLength || 250) };
    case "Integer":
      return { columnDataType: "int" };
    case "BigInteger":
      return { columnDataType: "bigint" };
    case "Decimal":
      return { columnDataType: "decimal" };
    case "Boolean":
      return { columnDataType: "bit" };
    case "Date":
      return { columnDataType: "date" };
    case "Time":
      return { columnDataType: "time" };
    case "DateTime":
      return { columnDataType: "datetime2" };
    case "DateFormula":
      return { columnDataType: "varchar", columnLength: 250 };
    case "Duration":
      return { columnDataType: "bigint" };
    case "Guid":
      return { columnDataType: "uniqueidentifier" };
    case "Option":
      return { columnDataType: "varchar", columnLength: 250 };
    default:
      return null;
  }
}

async function getTableFields(conn, token, companyId, tableRef) {
  const result = await bcTask(conn, token, companyId, "Help.Fields.Get", String(tableRef), null);
  return result.result || result.value || (Array.isArray(result) ? result : []);
}

function buildDdl(tableCfg, fields) {
  const selectedFieldSet = new Set((tableCfg.fieldNumbers || []).map(Number));
  const useSelection = selectedFieldSet.size > 0;

  const userFields = fields.filter((f) => {
    const no = Number(f.number || f.fieldNo || f.no || f.id);
    const fieldType = String(f.type || "");
    const fieldClass = String(f.class || "Normal");
    if (!(no >= 1 && no <= 1999999999)) return false;
    if (fieldClass !== "Normal") return false;
    if (!SUPPORTED_TYPES.has(fieldType)) return false;
    if (useSelection && !selectedFieldSet.has(no)) return false;
    return true;
  });

  const columns = userFields.map((f) => {
    const no = Number(f.number || f.fieldNo || f.no || f.id);
    const name = String(f.name || f.caption || `Field${no}`);
    const mapped = mapDdlType(String(f.type || ""), f.len || f.length);
    const base = {
      columnName: `${washName(name)}-${no}`,
      isNullable: true,
      isPrimaryKey: false,
      ...mapped,
    };
    return base;
  });

  columns.push(
    { columnName: "Timestamp-0", columnDataType: "bigint", isNullable: true, isPrimaryKey: false },
    { columnName: "SystemId-2000000000", columnDataType: "uniqueidentifier", isNullable: false, isPrimaryKey: true },
    { columnName: "SystemCreatedAt-2000000001", columnDataType: "datetime2", isNullable: true, isPrimaryKey: false },
    { columnName: "SystemCreatedBy-2000000002", columnDataType: "uniqueidentifier", isNullable: true, isPrimaryKey: false },
    { columnName: "SystemModifiedAt-2000000003", columnDataType: "datetime2", isNullable: true, isPrimaryKey: false },
    { columnName: "SystemModifiedBy-2000000004", columnDataType: "uniqueidentifier", isNullable: true, isPrimaryKey: false }
  );

  if (tableCfg.dataPerCompany) {
    columns.push({ columnName: "$Company", columnDataType: "varchar", columnLength: 250, isNullable: true, isPrimaryKey: false });
  }

  return {
    type: "FullInitialLoad",
    schema: "dbo",
    tableName: washName(tableCfg.tableName),
    columns,
    primaryKey: ["SystemId-2000000000"],
    watermarkColumn: "SystemModifiedAt-2000000003",
  };
}

async function uploadTextToMirror(connection, relativePath, content) {
  const credential = new ClientSecretCredential(connection.tenant, connection.clientId, connection.clientSecret);
  const serviceClient = createDataLakeServiceClient(connection.mirrorUrl, credential);
  const { fileSystemName, basePath } = parseMirrorUrl(connection.mirrorUrl);
  const fs = serviceClient.getFileSystemClient(fileSystemName);

  const fullPath = pathJoin(basePath, relativePath);
  const fileClient = fs.getFileClient(fullPath);
  
  // For files, ADLS Gen2/Fabric will automatically create parent directories
  // No explicit createIfNotExists needed on directories
  await fileClient.deleteIfExists();
  await fileClient.create();

  const payload = Buffer.from(String(content ?? ""), "utf8");
  if (payload.length > 0) {
    await fileClient.append(payload, 0, payload.length);
  }
  await fileClient.flush(payload.length);
}

async function uploadDdl(conn, token, companyId, connection, tableCfg) {
  const fields = await withTableRefFallback(tableCfg, (tableRef) => getTableFields(conn, token, companyId, tableRef));
  const resolvedTableName = resolveTableName(tableCfg, fields);
  const safeTableName = washName(resolvedTableName);
  const ddl = buildDdl({ ...tableCfg, tableName: resolvedTableName }, fields);
  const ddlPath = pathJoin("Tables", safeTableName, "_metadata", "DDL.json");
  await uploadTextToMirror(connection, ddlPath, JSON.stringify(ddl, null, 2));
}

function extractCsvPayload(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.result === "string") return result.result;
  if (typeof result.csv === "string") return result.csv;
  if (typeof result.data === "string") return result.data;
  if (Array.isArray(result.result)) return result.result.join("\n");
  return "";
}

async function runMirror(conn, token, companyId, tableId) {
  if (!tableId) throw new Error("tableId is required");

  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified") throw new Error("Verified mirror connection is required");

  const tables = await getStoredTables(conn, token, companyId);
  const tableCfg = tables.map(normalizeTableConfig).find((t) => Number(t.tableId) === Number(tableId));
  if (!tableCfg) throw new Error(`Table ${tableId} is not configured`);
  if (!tableCfg.active) throw new Error(`Table ${tableCfg.tableName} is inactive`);

  const previousTs = await getIntegrationTimestamp(conn, token, companyId, tableCfg.tableId);
  const endDt = new Date();
  const endIso = isoNoMs(endDt);

  await setIntegrationTimestamp(conn, token, companyId, tableCfg.tableId, endIso);

  try {
    const runTableView = buildRunTableView(tableCfg, previousTs, endIso);

    const runResult = await withTableRefFallback(tableCfg, async (tableRef) => {
      const tableSelector = parseTableRef(tableRef);
      const countResult = await dataRecordsGet(conn, token, companyId, {
        ...tableSelector,
        tableView: runTableView || undefined,
        skip: 0,
        take: 1,
        fieldNumbers: [1],
      });

      const noOfRecords = Number(countResult.noOfRecords || 0);
      if (noOfRecords === 0) {
        return { noOfRecords, csv: "" };
      }

      const csvResult = await bcTask(conn, token, companyId, "CSV.Records.Get", null, {
        ...tableSelector,
        tableView: runTableView || undefined,
        fieldNumbers: tableCfg.fieldNumbers && tableCfg.fieldNumbers.length ? tableCfg.fieldNumbers : undefined,
      });

      return { noOfRecords, csv: extractCsvPayload(csvResult) };
    });

    const noOfRecords = Number(runResult.noOfRecords || 0);
    if (noOfRecords === 0) {
      return {
        tableId: tableCfg.tableId,
        tableName: tableCfg.tableName,
        skipped: true,
        reason: "No records to mirror",
        endDateTime: endIso,
      };
    }

    const csv = runResult.csv;
    if (!csv) throw new Error("CSV.Records.Get returned no CSV payload");

    const yyyy = format(endDt, "yyyy");
    const mm = format(endDt, "MM");
    const dd = format(endDt, "dd");
    const stamp = formatMirrorFileStamp(endDt);
    const csvPath = pathJoin("Tables", washName(tableCfg.tableName), yyyy, mm, dd, `${stamp}.csv`);

    await uploadTextToMirror(connection, csvPath, csv);

    return {
      tableId: tableCfg.tableId,
      tableName: tableCfg.tableName,
      skipped: false,
      mirroredRecords: noOfRecords,
      endDateTime: endIso,
      filePath: csvPath,
    };
  } catch (error) {
    await reverseIntegrationTimestamp(conn, token, companyId, tableCfg.tableId);
    throw error;
  }
}

async function runAllActive(conn, token, companyId) {
  const tables = (await getStoredTables(conn, token, companyId)).map(normalizeTableConfig).filter((t) => t.active);
  const results = [];
  for (const table of tables) {
    try {
      const run = await runMirror(conn, token, companyId, table.tableId);
      results.push({ tableId: table.tableId, ok: true, ...run });
    } catch (error) {
      results.push({ tableId: table.tableId, ok: false, error: error.message });
    }
  }
  return { total: tables.length, results };
}
