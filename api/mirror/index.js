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



const _tokenCache = new Map();

module.exports = async function (context, req) {
  try {
    const action = req.body?.action;
    const companyId = req.body?.companyId || req.headers?.["x-bc-company"] || req.headers?.["x-company-id"];
    const lcid = Number(req.body?.lcid) || 1033;

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
        result = await activateTable(conn, token, companyId, req.body?.configId);
        break;
      case "deactivateTable":
        result = await deactivateTable(conn, token, companyId, req.body?.configId);
        break;
      case "runMirror":
      case "runNow":
        result = await runMirror(conn, token, companyId, req.body?.configId, lcid);
        break;
      case "startQueueMirror":
        result = await startQueueMirror(conn, token, companyId, req.body?.configId, lcid);
        break;
      case "checkQueueStatus":
        result = await checkQueueStatus(conn, token, companyId, req.body?.queueId);
        break;
      case "cancelQueueMirror":
        result = await cancelQueueMirror(conn, token, companyId, req.body?.queueId);
        break;
      case "fetchQueueData":
        result = await fetchQueueData(conn, token, companyId, req.body?.queueId, req.body?.configId, lcid);
        break;
      case "runAllActive":
        result = await runAllActive(conn, token, companyId, lcid);
        break;
      case "upload-ddl":
        result = await uploadDdlOnly(conn, token, companyId, req.body?.configId);
        break;
      case "initializeTable":
        result = await initializeTable(conn, token, companyId, req.body?.configId);
        break;
      case "listTables":
        result = await listTables(conn, token, companyId, lcid);
        break;
      case "getTableFields":
        result = await getTableFieldsAction(conn, token, companyId, req.body?.table, lcid);
        break;
      case "getTableInfo":
        result = await getTableInfo(conn, token, companyId, req.body?.table);
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

function httpsJsonWithStatus(hostname, path, method, headers, bodyObj) {
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
          // Return both status code and parsed body (or null for 204 No Content)
          const data = raw ? ((() => { try { return JSON.parse(raw); } catch { return null; } })()) : null;
          resolve({ statusCode: res.statusCode, data });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsText(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "GET", headers: { ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
            return;
          }
          resolve(raw);
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function bcTask(conn, token, companyId, type, subject, data, asText = false) {
  const { tenantId, environment } = conn;
  const taskId = crypto.randomUUID();
  const envelope = { specversion: "1.0", id: taskId, type, source: SOURCE };
  if (subject !== undefined && subject !== null) envelope.subject = String(subject);
  if (data !== undefined && data !== null) envelope.data = JSON.stringify(data);

  const taskPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
  const task = await httpsJson(BC_HOST, taskPath, "POST", { Authorization: `Bearer ${token}` }, envelope);

  if (task.status === "Error") throw new Error(task.error || "BC task failed");
  if (!task.data || !String(task.data).startsWith("https://")) return task;

  const taskUrl = new URL(task.data);
  if (asText) {
    const raw = await httpsText(taskUrl.hostname, taskUrl.pathname + taskUrl.search, { Authorization: `Bearer ${token}` });
    // After the CSV is ready, GET the queue record to read the BC-updated 'time'.
    // BC sets this to the modification timestamp of the last record included in the CSV —
    // the correct value to store as the integration timestamp for next-batch incremental sync.
    let bcTime = null;
    try {
      const queuePath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues(${taskId})`;
      const queueRecord = await httpsJson(BC_HOST, queuePath, "GET", { Authorization: `Bearer ${token}` }, null);
      bcTime = queueRecord.time || null;
    } catch {
      // Queue GET failed — bcTime stays null; caller falls back to local clock.
    }
    return { data: raw, time: bcTime };
  }
  const result = await httpsJson(taskUrl.hostname, taskUrl.pathname + taskUrl.search, "GET", { Authorization: `Bearer ${token}` }, null);
  if (result.status === "Error") throw new Error(result.error || "BC result failed");
  return result;
}

async function bcQueue(conn, token, companyId, type, subject, data) {
  const { tenantId, environment } = conn;
  const queueId = crypto.randomUUID();
  const envelope = { specversion: "1.0", id: queueId, type, source: SOURCE };
  if (subject !== undefined && subject !== null) envelope.subject = String(subject);
  if (data !== undefined && data !== null) envelope.data = JSON.stringify(data);

  const queuePath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues`;
  
  console.log(`[bcQueue] Requesting CSV file - Type: ${type}, Queue ID: ${queueId}`);
  console.log(`[bcQueue] Payload:`, JSON.stringify(data, null, 2));
  
  await httpsJson(BC_HOST, queuePath, "POST", { Authorization: `Bearer ${token}` }, envelope);
  console.log(`[bcQueue] Queue request posted successfully`);

  // Poll for status using Microsoft.NAV.GetStatus
  const getStatusPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues(${queueId})/Microsoft.NAV.GetStatus`;
  const queueRecordPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues(${queueId})`;
  const maxAttempts = 108; // 9 minutes max (108 × 5 sec = 540 sec) - fits within Azure Function 10-min timeout
  const pollIntervalMs = 5000; // 5 seconds between polls

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    console.log(`[bcQueue] Poll attempt ${attempt + 1}/${maxAttempts} for queue ${queueId}`);
    
    // Call GetStatus action - returns HTTP status code indicating queue state
    const statusResponse = await httpsJsonWithStatus(BC_HOST, getStatusPath, "POST", { Authorization: `Bearer ${token}` }, null);
    console.log(`[bcQueue] GetStatus HTTP ${statusResponse.statusCode}`);

    // BC returns status as HTTP status codes:
    // 201 Created = still running
    // 200 OK = completed (Updated)
    // 204 No Content = deleted or not found
    if (statusResponse.statusCode === 204) {
      console.error(`[bcQueue] Queue entry deleted or not found (HTTP 204)`);
      throw new Error("Queue entry deleted or not found");
    }

    if (statusResponse.statusCode === 200) {
      // Queue task is complete - now GET the queue record to retrieve timestamp and data URL
      console.log(`[bcQueue] Queue completed (HTTP 200), retrieving queue record`);
      const queueRecord = await httpsJson(BC_HOST, queueRecordPath, "GET", { Authorization: `Bearer ${token}` }, null);
      
      const dataUrl = queueRecord.data;
      if (!dataUrl || !String(dataUrl).startsWith("https://")) {
        console.error(`[bcQueue] Queue completed but no valid data URL: ${dataUrl}`);
        throw new Error("Queue completed but no valid data URL returned");
      }

      console.log(`[bcQueue] Fetching result from URL: ${dataUrl}`);
      const url = new URL(dataUrl);
      
      // Read datacontenttype from queue record to determine response format
      const dataContentType = queueRecord.datacontenttype || "";
      console.log(`[bcQueue] Queue datacontenttype: ${dataContentType}`);
      
      // Route based on datacontenttype from queue record (no HEAD request needed)
      if (dataContentType.includes("json")) {
        // JSON response (e.g., count queries, record data)
        const jsonResult = await httpsJson(url.hostname, url.pathname + url.search, "GET", { Authorization: `Bearer ${token}` }, null);
        console.log(`[bcQueue] Received JSON result - noOfRecords: ${jsonResult.noOfRecords || 'N/A'}, BC Time: ${queueRecord.time || 'null'}`);
        return {
          ...jsonResult,
          time: queueRecord.time || null,
        };
      } else {
        // CSV or text content (bulk export)
        const csvData = await httpsText(url.hostname, url.pathname + url.search, { Authorization: `Bearer ${token}` });
        const csvSize = csvData ? csvData.length : 0;
        const csvLines = csvData ? csvData.split('\n').length : 0;
        console.log(`[bcQueue] Received CSV - Size: ${csvSize} bytes, Lines: ${csvLines}, BC Time: ${queueRecord.time || 'null'}`);
        return {
          data: csvData,
          time: queueRecord.time || null,
        };
      }
    }

    // Status 201 Created = still running, continue polling
    console.log(`[bcQueue] Queue still running (HTTP ${statusResponse.statusCode}), waiting ${pollIntervalMs}ms before next poll`);
  }

  console.error(`[bcQueue] Queue task timed out after ${maxAttempts} attempts (${maxAttempts * pollIntervalMs / 1000 / 60} minutes)`);
  throw new Error(`Queue task timed out after ${maxAttempts} attempts`);
}

async function dataRecordsGet(conn, token, companyId, payload) {
  return bcTask(conn, token, companyId, "Data.Records.Get", null, payload);
}

async function dataRecordsGetAsync(conn, token, companyId, payload) {
  return bcQueue(conn, token, companyId, "Data.Records.Get", null, payload);
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
  const tables = Array.isArray(parsed) ? parsed : [];
  // Auto-assign configIds for configs created before configId was introduced
  let needsSave = false;
  for (const t of tables) {
    if (!t.configId) {
      t.configId = crypto.randomUUID();
      needsSave = true;
    }
  }
  if (needsSave) await setStoredTables(conn, token, companyId, tables);
  return tables;
}

async function setStoredTables(conn, token, companyId, tables) {
  await setConfig(conn, token, companyId, CONFIG_TABLES_ID, JSON.stringify(tables));
}

function normalizeWhereFilter(raw) {
  // Store only the WHERE(...) clause. Strip any SORTING/ORDER prefix the user may have included.
  const s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/WHERE\(.*\)\s*$/i);
  return m ? m[0].trim() : s;
}

function normalizeTableConfig(table) {
  return {
    configId: table.configId || crypto.randomUUID(),
    tableId: Number(table.tableId),
    tableName: String(table.tableName || ""),
    dataPerCompany: Boolean(table.dataPerCompany),
    fieldNumbers: Array.isArray(table.fieldNumbers) ? table.fieldNumbers.map(Number).filter((n) => n >= 1 && n <= 1999999999) : [],
    tableView: normalizeWhereFilter(table.tableView),
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
      { name: "configId", label: "Config ID", type: "text" },
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
  const [connection, tableConfigs] = await Promise.all([
    getMirrorConnection(conn, token, companyId),
    getTableConfigs(conn, token, companyId),
  ]);

  return {
    connection: connection || {
      mirrorUrl: "",
      tenant: "",
      clientId: "",
      clientSecret: "",
      status: "unverified",
    },
    tables: tableConfigs.mirrors,
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
  const normalized = tables.map(normalizeTableConfig);
  const mirrors = await Promise.all(
    normalized.map(async (t) => {
      const lastRunAt = await getIntegrationTimestamp(conn, token, companyId, t.tableName, t.configId).catch(() => null);
      return { ...t, lastRunAt };
    })
  );
  return { mirrors, count: mirrors.length };
}

async function getTableConfig(conn, token, companyId, configId) {
  const tables = await getStoredTables(conn, token, companyId);
  const table = tables.find((t) => t.configId === configId);
  if (!table) return null;
  return normalizeTableConfig(table);
}

async function saveTableConfigs(conn, token, companyId, tables) {
  if (!Array.isArray(tables)) throw new Error("tables must be an array");
  const normalized = tables.map(normalizeTableConfig);
  await setStoredTables(conn, token, companyId, normalized);
  return { saved: true, count: normalized.length, mirrors: normalized };
}

async function activateTable(conn, token, companyId, configId) {
  if (!configId) throw new Error("configId is required");
  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified") {
    throw new Error("Mirror connection must be verified before activation");
  }

  const tables = await getStoredTables(conn, token, companyId);
  const idx = tables.findIndex((t) => t.configId === configId);
  if (idx < 0) throw new Error(`Config ${configId} is not configured`);

  const tableCfg = normalizeTableConfig(tables[idx]);
  await uploadDdl(conn, token, companyId, connection, tableCfg);

  tableCfg.active = true;
  tables[idx] = tableCfg;
  await setStoredTables(conn, token, companyId, tables);

  return { activated: true, configId, tableId: tableCfg.tableId, tableName: tableCfg.tableName };
}

async function deactivateTable(conn, token, companyId, configId) {
  if (!configId) throw new Error("configId is required");
  const tables = await getStoredTables(conn, token, companyId);
  const idx = tables.findIndex((t) => t.configId === configId);
  if (idx < 0) throw new Error(`Config ${configId} is not configured`);
  tables[idx] = { ...normalizeTableConfig(tables[idx]), active: false };
  await setStoredTables(conn, token, companyId, tables);
  return { deactivated: true, configId, tableId: Number(tables[idx].tableId) };
}

async function uploadDdlOnly(conn, token, companyId, configId) {
  if (!configId) throw new Error("configId is required");
  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified") throw new Error("Verified mirror connection is required");
  const tables = await getStoredTables(conn, token, companyId);
  const cfg = tables.find((t) => t.configId === configId);
  if (!cfg) throw new Error(`Config ${configId} is not configured`);
  await uploadDdl(conn, token, companyId, connection, normalizeTableConfig(cfg));
  return { uploaded: true, configId };
}

async function initializeTable(conn, token, companyId, configId) {
  if (!configId) throw new Error("configId is required");
  const tables = await getStoredTables(conn, token, companyId);
  const cfg = tables.find((t) => t.configId === configId);
  if (!cfg) throw new Error(`Config ${configId} is not configured`);
  const tableCfg = normalizeTableConfig(cfg);
  const reversed = await reverseAllIntegrationTimestamps(conn, token, companyId, tableCfg);
  return { initialized: true, configId, tableName: tableCfg.tableName, reversedEntries: reversed };
}

function integrationSource(tableName, configId) {
  return `${tableName}-${configId}`;
}

function ciTableView(tableName, configId) {
  const source = integrationSource(tableName, configId);
  return `SORTING(Source,Table Id,Date & Time) ORDER(Descending) WHERE(Source=CONST(${source}),Reversed=CONST(false))`;
}

async function getIntegrationTimestamp(conn, token, companyId, tableName, configId) {
  const result = await dataRecordsGet(conn, token, companyId, {
    tableName: CI_TABLE,
    tableView: ciTableView(tableName, configId),
    skip: 0,
    take: 1,
  });
  const records = result.result || result.value || [];
  if (!records.length) return null;
  return records[0]?.primaryKey?.DateTime || null;
}

async function setIntegrationTimestamp(conn, token, companyId, tableCfg, dateTime) {
  const source = integrationSource(tableCfg.tableName, tableCfg.configId);
  await dataRecordsSet(conn, token, companyId, CI_TABLE, {
    data: [{
      primaryKey: {
        Source: source,
        TableId: Number(tableCfg.tableId),
        DateTime: String(dateTime),
      },
      fields: { Reversed: "false" },
    }],
  });
}

async function reverseIntegrationTimestamp(conn, token, companyId, tableCfg) {
  const result = await dataRecordsGet(conn, token, companyId, {
    tableName: CI_TABLE,
    tableView: ciTableView(tableCfg.tableName, tableCfg.configId),
    skip: 0,
    take: 1,
  });
  const records = result.result || result.value || [];
  if (!records.length) return;
  const dateTime = records[0]?.primaryKey?.DateTime;
  if (!dateTime) return;

  const source = integrationSource(tableCfg.tableName, tableCfg.configId);
  await dataRecordsSet(conn, token, companyId, CI_TABLE, {
    mode: "modify",
    data: [{
      primaryKey: {
        Source: source,
        TableId: Number(tableCfg.tableId),
        DateTime: String(dateTime),
      },
      fields: { Reversed: "true" },
    }],
  });
}

async function reverseAllIntegrationTimestamps(conn, token, companyId, tableCfg) {
  const allView = `SORTING(Source,Table Id,Date & Time) ORDER(Descending) WHERE(Source=CONST(${integrationSource(tableCfg.tableName, tableCfg.configId)}),Reversed=CONST(false))`;
  const result = await dataRecordsGet(conn, token, companyId, {
    tableName: CI_TABLE,
    tableView: allView,
    skip: 0,
    take: 1000,
  });
  const records = result.result || result.value || [];
  if (!records.length) return 0;

  const source = integrationSource(tableCfg.tableName, tableCfg.configId);
  await dataRecordsSet(conn, token, companyId, CI_TABLE, {
    mode: "modify",
    data: records.map((r) => ({
      primaryKey: {
        Source: source,
        TableId: Number(tableCfg.tableId),
        DateTime: String(r.primaryKey?.DateTime),
      },
      fields: { Reversed: "true" },
    })),
  });
  return records.length;
}



function isoNoMs(dateObj) {
  return dateObj.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildWhereClause(storedWhere, extraClause) {
  // storedWhere is already a bare WHERE(...) string or empty.
  if (!storedWhere && !extraClause) return "";
  if (!storedWhere) return `WHERE(${extraClause})`;
  if (!extraClause) return storedWhere;
  // Append extraClause inside the existing WHERE(...)
  return storedWhere.replace(/\)\s*$/i, `,${extraClause})`);
}

function buildRunTableView(tableCfg) {
  // Date filtering is handled via startDateTime/endDateTime in the JSON payload,
  // not embedded in tableView. Only sorting + user-configured WHERE filter here.
  const suffix = tableCfg.tableView ? ` ${tableCfg.tableView}` : "";
  return `SORTING(SystemModifiedAt) ORDER(Ascending)${suffix}`;
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

function mapFabricType(fieldType) {
  switch (String(fieldType)) {
    case "Text":
    case "Code":
    case "Option":
    case "DateFormula":
    case "Guid":
      return "String";
    case "Integer":
      return "Int32";
    case "BigInteger":
    case "Duration":
      return "Int64";
    case "Decimal":
      return "Double";
    case "Boolean":
      return "Boolean";
    case "Date":
      return "IDate";
    case "Time":
      return "ITime";
    case "DateTime":
      return "DateTime";
    default:
      return null;
  }
}

async function listTables(conn, token, companyId, lcid) {
  const result = await bcTask(conn, token, companyId, "Help.Tables.Get", null, null);
  const tables = result.result || result.value || result.tables || (Array.isArray(result) ? result : []);
  return { tables, total: tables.length };
}

async function getTableInfo(conn, token, companyId, tableRef) {
  if (!tableRef) throw new Error("Parameter 'table' is required");
  const result = await bcTask(conn, token, companyId, "Help.Tables.Get", String(tableRef), null);
  const table = (result.result && result.result[0]) || result;
  return { table };
}

async function getTableFieldsAction(conn, token, companyId, tableRef, lcid) {
  if (!tableRef) throw new Error("Parameter 'table' is required");
  const result = await bcTask(conn, token, companyId, "Help.Fields.Get", String(tableRef), null);
  const fields = result.result || result.value || (Array.isArray(result) ? result : []);
  return { fields, fieldCount: fields.length };
}

async function getTableFields(conn, token, companyId, tableRef) {
  const result = await bcTask(conn, token, companyId, "Help.Fields.Get", String(tableRef), null);
  return result.result || result.value || (Array.isArray(result) ? result : []);
}

function buildDdl(tableCfg, fields) {
  const selectedFieldSet = new Set((tableCfg.fieldNumbers || []).map(Number));
  const useSelection = selectedFieldSet.size > 0;

  const userColumns = fields
    .filter((f) => {
      const no = Number(f.number || f.fieldNo || f.no || f.id);
      const fieldType = String(f.type || "");
      const fieldClass = String(f.class || "Normal");
      if (!(no >= 1 && no <= 1999999999)) return false;
      if (fieldClass !== "Normal") return false;
      if (!mapFabricType(fieldType)) return false;
      if (useSelection && !selectedFieldSet.has(no)) return false;
      return true;
    })
    .map((f) => {
      const name = String(f.name || f.caption || `Field${f.number || f.id}`);
      return {
        Name: washName(name),
        DataType: mapFabricType(String(f.type || "")),
        IsNullable: true,
      };
    });

  const systemColumns = [
    { Name: "timestamp",        DataType: "Int64",    IsNullable: true },
    { Name: "systemId",         DataType: "String" },
    { Name: "SystemCreatedAt",  DataType: "DateTime", IsNullable: true },
    { Name: "SystemCreatedBy",  DataType: "String",   IsNullable: true },
    { Name: "SystemModifiedAt", DataType: "DateTime", IsNullable: true },
    { Name: "SystemModifiedBy", DataType: "String",   IsNullable: true },
  ];

  if (Number(tableCfg.tableId) === 17) {
    systemColumns.push({ Name: "ClosingDate", DataType: "Boolean", IsNullable: true });
  }

  if (tableCfg.dataPerCompany) {
    systemColumns.push({ Name: "$Company", DataType: "String" });
  }

  const keyColumns = tableCfg.dataPerCompany
    ? ["systemId", "$Company"]
    : ["systemId"];

  return {
    keyColumns,
    fileDetectionStrategy: "LastUpdateTimeFileDetection",
    SchemaDefinition: {
      Columns: [...userColumns, ...systemColumns],
    },
    fileFormat: "csv",
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
  const ddlPath = pathJoin(safeTableName, "_metadata.json");
  await uploadTextToMirror(connection, ddlPath, JSON.stringify(ddl, null, 2));
}

async function getDeletedRecordCount(conn, token, companyId, tableCfg, startIso, endIso) {
  const tableSelector = tableCfg.tableName
    ? { tableName: tableCfg.tableName }
    : { tableNumber: tableCfg.tableId };

  const payload = {
    ...tableSelector,
    skip: 0,
    take: 1,
  };
  if (startIso) payload.startDateTime = startIso;
  if (endIso) payload.endDateTime = endIso;

  const result = await bcQueue(conn, token, companyId, "Deleted.RecordIds.Get", null, payload);
  return Number(result.noOfRecords || 0);
}

async function getCsvDeletedRecords(conn, token, companyId, tableCfg, startIso, endIso, lcid) {
  const tableSelector = tableCfg.tableName
    ? { tableName: tableCfg.tableName }
    : { tableNumber: tableCfg.tableId };

  const payload = {
    ...tableSelector,
  };
  if (startIso) payload.startDateTime = startIso;
  if (endIso) payload.endDateTime = endIso;
  if (lcid !== undefined && lcid !== 1033) payload.lcid = Number(lcid);

  const result = await bcQueue(conn, token, companyId, "CSV.DeletedRecords.Get", null, payload);
  return extractCsvPayload(result);
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

// ══════════════════════════════════════════════════════════════════════════════
// FRONTEND POLLING ARCHITECTURE - Separate queue start, status check, data fetch
// ══════════════════════════════════════════════════════════════════════════════

async function startQueueMirror(conn, token, companyId, configId, lcid = 1033) {
  if (!configId) throw new Error("configId is required");

  // Parallel fetch: connection + table config (independent getConfig calls)
  const [connection, tableCfg] = await Promise.all([
    getMirrorConnection(conn, token, companyId),
    getTableConfig(conn, token, companyId, configId),
  ]);

  if (!connection || connection.status !== "verified")
    throw new Error("Verified mirror connection is required");
  if (!tableCfg) throw new Error(`Config not found: ${configId}`);

  const logs = [];
  logs.push(`Starting queue for ${tableCfg.tableName}...`);

  // Get last sync timestamp from integration table
  const previousTs = await getIntegrationTimestamp(conn, token, companyId, tableCfg.tableName, tableCfg.configId).catch(() => null);

  const endDt = new Date();
  const endIso = isoNoMs(endDt);

  // Async record count before queuing CSV — never use synchronous bcTask for counts
  const countPayload = {
    tableName: tableCfg.tableName,
    tableView: buildRunTableView(tableCfg),
    take: 0,
  };
  if (previousTs) countPayload.startDateTime = previousTs;
  if (endIso) countPayload.endDateTime = endIso;

  const countResult = await dataRecordsGetAsync(conn, token, companyId, countPayload);
  const recordCount = Number(countResult.noOfRecords || 0);
  logs.push(`Record count: ${recordCount}`);

  if (recordCount === 0) {
    logs.push(`No records modified — skipping CSV export`);
    return { tableId: tableCfg.tableId, tableName: tableCfg.tableName, skipped: true, reason: "No records to mirror", logs };
  }

  const { tenantId, environment } = conn;
  const queueId = crypto.randomUUID();
  
  const csvPayload = {
    tableName: tableCfg.tableName,
    tableView: buildRunTableView(tableCfg),
    fieldNumbers: tableCfg.fieldNumbers && tableCfg.fieldNumbers.length ? tableCfg.fieldNumbers : undefined,
  };
  if (previousTs) csvPayload.startDateTime = previousTs;
  if (endIso) csvPayload.endDateTime = endIso;
  if (lcid !== undefined && lcid !== 1033) csvPayload.lcid = Number(lcid);

  const envelope = {
    specversion: "1.0",
    id: queueId,
    type: "CSV.Records.Get",
    source: SOURCE,
    data: JSON.stringify(csvPayload),
  };

  const queuePath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues`;
  await httpsJson(BC_HOST, queuePath, "POST", { Authorization: `Bearer ${token}` }, envelope);

  logs.push(`Queue started: ${queueId}`);

  return {
    tableId: tableCfg.tableId,
    tableName: tableCfg.tableName,
    queueId,
    logs,
  };
}

async function checkQueueStatus(conn, token, companyId, queueId) {
  if (!queueId) throw new Error("queueId is required");

  const { tenantId, environment } = conn;
  const getStatusPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues(${queueId})/Microsoft.NAV.GetStatus`;

  // Call GetStatus action - returns HTTP status code indicating queue state
  const statusResponse = await httpsJsonWithStatus(BC_HOST, getStatusPath, "POST", { Authorization: `Bearer ${token}` }, null);

  // BC returns status as HTTP status codes:
  // 201 Created = still running
  // 200 OK = completed (Updated)
  // 204 No Content = deleted or not found
  if (statusResponse.statusCode === 204) {
    return { status: "deleted", message: "Queue entry deleted or not found" };
  }

  if (statusResponse.statusCode === 200) {
    return { status: "completed", message: "Queue task completed" };
  }

  // 201 = still running
  return { status: "running", message: "Queue task is still running" };
}

async function cancelQueueMirror(conn, token, companyId, queueId) {
  if (!queueId) throw new Error("queueId is required");

  const { tenantId, environment } = conn;
  const cancelPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues(${queueId})/Microsoft.NAV.CancelTask`;

  const cancelResponse = await httpsJsonWithStatus(BC_HOST, cancelPath, "POST", { Authorization: `Bearer ${token}` }, null);

  // BC returns:
  // 200 OK (Updated) = task was cancelled successfully
  // 204 No Content (Deleted) = no task was scheduled
  // 204 No Content (None) = cancellation failed
  if (cancelResponse.statusCode === 200) {
    return { status: "cancelled", message: "Queue task cancelled" };
  }

  return { status: "none", message: "No task to cancel or cancellation failed" };
}

async function fetchQueueData(conn, token, companyId, queueId, configId, lcid = 1033) {
  if (!queueId) throw new Error("queueId is required");
  if (!configId) throw new Error("configId is required");

  // Parallel fetch: connection + table config (independent getConfig calls)
  const [connection, tableCfg] = await Promise.all([
    getMirrorConnection(conn, token, companyId),
    getTableConfig(conn, token, companyId, configId),
  ]);

  if (!connection || connection.status !== "verified")
    throw new Error("Verified mirror connection is required");
  if (!tableCfg) throw new Error(`Config not found: ${configId}`);

  const logs = [];
  const { tenantId, environment } = conn;

  // Get the queue record to retrieve data URL and timestamp
  const queueRecordPath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues(${queueId})`;
  const queueRecord = await httpsJson(BC_HOST, queueRecordPath, "GET", { Authorization: `Bearer ${token}` }, null);

  const dataUrl = queueRecord.data;
  if (!dataUrl || !String(dataUrl).startsWith("https://")) {
    // No data URL means BC had no records to export — treat as skipped
    logs.push("No records to mirror");
    return {
      tableId: tableCfg.tableId,
      tableName: tableCfg.tableName,
      skipped: true,
      reason: "No records to mirror",
      mirroredRecords: 0,
      deletedRecords: 0,
      logs,
    };
  }

  const dataContentType = queueRecord.datacontenttype || "";
  logs.push(`Fetching CSV data from BC (${dataContentType})...`);

  // Fetch the CSV data
  const url = new URL(dataUrl);
  const csv = await httpsText(url.hostname, url.pathname + url.search, { Authorization: `Bearer ${token}` });
  
  const csvSize = csv ? csv.length : 0;
  const csvLines = csv ? csv.split('\n').length - 1 : 0; // -1 for header
  logs.push(`Downloaded CSV: ${csvSize} bytes, ${csvLines} data rows`);

  // Get confirmed timestamp from BC
  let confirmedIso = null;
  let confirmedDt = null;
  if (queueRecord.time) {
    confirmedDt = new Date(queueRecord.time);
    confirmedIso = isoNoMs(confirmedDt);
  }

  // Get previous timestamp for deleted records check from integration table
  const previousTs = await getIntegrationTimestamp(conn, token, companyId, tableCfg.tableName, tableCfg.configId).catch(() => null);

  // Count and fetch deleted records
  const noOfDeleted = await getDeletedRecordCount(conn, token, companyId, tableCfg, previousTs, confirmedIso);
  logs.push(`Found ${noOfDeleted} deleted record(s)`);

  let deletedCsv = "";
  if (noOfDeleted > 0) {
    deletedCsv = await getCsvDeletedRecords(conn, token, companyId, tableCfg, previousTs, confirmedIso, lcid);
  }

  // Upload to Open Mirror
  const stamp = formatMirrorFileStamp(confirmedDt || new Date());
  const safeTableName = washName(tableCfg.tableName);
  let csvPath = null;
  let deletedFilePath = null;
  const mirroredRecords = csv ? csv.split('\n').length - 1 : 0; // -1 for header
  const deletedRecords = noOfDeleted;

  if (csv) {
    csvPath = pathJoin(safeTableName, `${stamp}.csv`);
    await uploadTextToMirror(connection, csvPath, csv);
  }

  if (deletedCsv) {
    deletedFilePath = pathJoin(safeTableName, `${stamp}_deleted.csv`);
    await uploadTextToMirror(connection, deletedFilePath, deletedCsv);
  }

  const filePath = csvPath || deletedFilePath;
  logs.push(`Uploaded to Open Mirror: ${filePath}`);
  logs.push(`${mirroredRecords} records mirrored, ${deletedRecords} deleted`);

  // Save sync timestamp to BC integration table
  const tsToSave = confirmedIso || previousTs;
  if (tsToSave) {
    await setIntegrationTimestamp(conn, token, companyId, tableCfg, tsToSave);
  }

  return {
    tableId: tableCfg.tableId,
    tableName: tableCfg.tableName,
    mirroredRecords,
    deletedRecords,
    filePath,
    endDateTime: confirmedIso,
    logs,
  };
}

async function runMirror(conn, token, companyId, configId, lcid = 1033) {
  if (!configId) throw new Error("configId is required");

  const connection = await getMirrorConnection(conn, token, companyId);
  if (!connection || connection.status !== "verified")
    throw new Error("Verified mirror connection is required");

  const tables = await getStoredTables(conn, token, companyId);
  const tableCfg = tables
    .map(normalizeTableConfig)
    .find((t) => t.configId === configId);
  if (!tableCfg) throw new Error(`Config ${configId} is not configured`);
  if (!tableCfg.active) throw new Error(`Table ${tableCfg.tableName} is inactive`);

  // Get last sync timestamp from integration table
  const previousTs = await getIntegrationTimestamp(conn, token, companyId, tableCfg.tableName, tableCfg.configId).catch(() => null);
  const endDt = new Date();
  const endIso = isoNoMs(endDt);
  const runTableView = buildRunTableView(tableCfg);

  // ── Step 1: Fetch modified records via async queue ───────────────────────────
  let csv = "";
  let confirmedDt = endDt;
  let confirmedIso = endIso;
  const logs = [];

  logs.push(`Starting CSV export for ${tableCfg.tableName}...`);

  // Async record count before queuing CSV
  const countPayload = {
    tableName: tableCfg.tableName,
    ...(runTableView ? { tableView: runTableView } : {}),
    take: 0,
  };
  if (previousTs) countPayload.startDateTime = previousTs;
  if (endIso) countPayload.endDateTime = endIso;

  const countResult = await dataRecordsGetAsync(conn, token, companyId, countPayload);
  const recordCount = Number(countResult.noOfRecords || 0);
  logs.push(`Record count: ${recordCount}`);

  let csvResult = null;
  if (recordCount > 0) {
    const csvPayload = {
      tableName: tableCfg.tableName,
      ...(runTableView ? { tableView: runTableView } : {}),
      fieldNumbers:
        tableCfg.fieldNumbers && tableCfg.fieldNumbers.length
          ? tableCfg.fieldNumbers
          : undefined,
    };
    if (previousTs) csvPayload.startDateTime = previousTs;
    if (endIso) csvPayload.endDateTime = endIso;
    if (lcid !== undefined && lcid !== 1033) csvPayload.lcid = Number(lcid);

    csvResult = await bcQueue(conn, token, companyId, "CSV.Records.Get", null, csvPayload);
  }

  csv = csvResult ? extractCsvPayload(csvResult) : "";
  if (csvResult && csvResult.time) {
    confirmedDt = new Date(csvResult.time);
    confirmedIso = isoNoMs(confirmedDt);
  }
  const noOfRecords = csv ? csv.split('\n').length - 1 : 0; // -1 for header
  logs.push(`Found ${noOfRecords} record(s) to mirror`);

  // ── Step 2: Count deleted records (Deleted.RecordIds.Get) then fetch CSV ─────
  const noOfDeleted = await getDeletedRecordCount(
    conn, token, companyId, tableCfg, previousTs, confirmedIso
  );

  let deletedCsv = "";
  if (noOfDeleted > 0) {
    deletedCsv = await getCsvDeletedRecords(
      conn, token, companyId, tableCfg, previousTs, confirmedIso, lcid
    );
  }

  // ── Step 3: Skip if nothing to mirror ────────────────────────────────────────
  if (noOfRecords === 0 && noOfDeleted === 0) {
    return {
      tableId: tableCfg.tableId,
      tableName: tableCfg.tableName,
      skipped: true,
      reason: "No records to mirror",
      endDateTime: null,
      logs,
    };
  }

  if (noOfRecords > 0 && !csv)
    throw new Error("CSV.Records.Get returned no CSV payload");

  // ── Step 4: Confirm timestamp and upload ─────────────────────────────────────
  if (confirmedIso) {
    await setIntegrationTimestamp(conn, token, companyId, tableCfg, confirmedIso);
  }

  try {
    const stamp = formatMirrorFileStamp(confirmedDt);
    const safeTableName = washName(tableCfg.tableName);

    let csvPath = null;
    let deletedFilePath = null;

    if (noOfRecords > 0) {
      csvPath = pathJoin(safeTableName, `${stamp}.csv`);
      await uploadTextToMirror(connection, csvPath, csv);
    }

    if (noOfDeleted > 0) {
      deletedFilePath = pathJoin(safeTableName, `${stamp}_deleted.csv`);
      await uploadTextToMirror(connection, deletedFilePath, deletedCsv);
    }

    return {
      tableId: tableCfg.tableId,
      tableName: tableCfg.tableName,
      skipped: false,
      mirroredRecords: noOfRecords,
      deletedRecords: noOfDeleted,
      endDateTime: confirmedIso,
      filePath: csvPath,
      deletedFilePath,
      logs,
    };
  } catch (error) {
    await reverseIntegrationTimestamp(conn, token, companyId, tableCfg).catch(() => {});
    throw error;
  }
}

async function runAllActive(conn, token, companyId, lcid = 1033) {
  const tables = (await getStoredTables(conn, token, companyId)).map(normalizeTableConfig).filter((t) => t.active);
  const results = [];
  for (const table of tables) {
    try {
      const run = await runMirror(conn, token, companyId, table.configId, lcid);
      results.push({ configId: table.configId, tableId: table.tableId, ok: true, ...run });
    } catch (error) {
      results.push({ configId: table.configId, tableId: table.tableId, ok: false, error: error.message });
    }
  }
  return { total: tables.length, results };
}
