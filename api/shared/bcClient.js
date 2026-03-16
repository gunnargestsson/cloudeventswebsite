/**
 * Shared Business Central Cloud Events client for Azure Functions.
 * Uses native https module — no external dependencies.
 */
"use strict";

const https = require("https");

const BC_HOST   = "api.businesscentral.dynamics.com";
const MSFT_HOST = "login.microsoftonline.com";

// ── Low-level HTTPS helper ─────────────────────────────────────────────────────

function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body != null
      ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8"))
      : null;

    const reqHeaders = {
      Accept: "application/json",
      ...headers,
      ...(bodyBuf != null ? {
        "Content-Type":   headers["Content-Type"] || "application/json",
        "Content-Length": bodyBuf.length,
      } : {}),
    };

    const req = https.request({ hostname, path, method, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, headers: res.headers, raw });
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function parseJson(raw, context) {
  try { return JSON.parse(raw); }
  catch { throw new Error(`Non-JSON response from ${context}: ${raw.slice(0, 200)}`); }
}

// ── Token acquisition ──────────────────────────────────────────────────────────

async function getToken(tenantId, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         "https://api.businesscentral.dynamics.com/.default",
  }).toString();

  const { raw } = await httpsRequest(
    MSFT_HOST,
    `/${tenantId}/oauth2/v2.0/token`,
    "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    Buffer.from(body, "utf8"),
  );

  const parsed = parseJson(raw, "Microsoft identity platform");
  if (parsed.error) throw new Error(`Token error (${parsed.error}): ${parsed.error_description || ""}`);
  if (!parsed.access_token) throw new Error("Microsoft identity platform returned no access_token");
  return parsed.access_token;
}

// ── BC task helper (two-step: POST /tasks → GET data URL) ─────────────────────

async function bcTask(tenantId, env, companyId, auth, type, subject, data) {
  const envelope = { specversion: "1.0", type, source: "dynamics.is AI Assistant v1.0" };
  if (subject !== undefined && subject !== null) envelope.subject = subject;
  if (data    !== undefined && data    !== null) envelope.data = JSON.stringify(data);

  const taskPath = `/v2.0/${tenantId}/${env}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
  const { raw: taskRaw } = await httpsRequest(BC_HOST, taskPath, "POST", { Authorization: auth }, envelope);
  const task = parseJson(taskRaw, "BC /tasks");

  // Direct error or inbound-only type — no data URL
  if (task.status === "Error") throw new Error(task.error || JSON.stringify(task));
  if (!task.data || !String(task.data).startsWith("https://api.businesscentral.dynamics.com/")) {
    return task;
  }

  // Fetch result from data URL
  const dataUrl = new URL(task.data);
  const { raw: resultRaw } = await httpsRequest(
    dataUrl.hostname,
    dataUrl.pathname + dataUrl.search,
    "GET",
    { Authorization: auth },
    null,
  );
  const result = parseJson(resultRaw, "BC data URL");
  if (result.status === "Error") throw new Error(result.error || JSON.stringify(result));
  return result;
}

// ── Input sanitisation — prevent tableView filter injection ───────────────────
// Strips characters that have meaning in BC tableView FILTER/CONST expressions.

function sanitizeFilter(s) {
  return String(s)
    .replace(/[()]/g, " ")            // parentheses used in FILTER/CONST syntax
    .replace(/\b(CONST|FILTER|FIELD|SORTING|WHERE|AND|OR)\b/gi, "")
    .trim()
    .slice(0, 250);
}

// ── Anthropic Messages API helper ──────────────────────────────────────────────

async function callAnthropic(apiKey, payload) {
  const bodyBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const { statusCode, raw } = await httpsRequest(
    "api.anthropic.com",
    "/v1/messages",
    "POST",
    {
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    bodyBuf,
  );
  const parsed = parseJson(raw, "Anthropic API");
  if (statusCode >= 400) {
    throw new Error(parsed.error?.message || `Anthropic HTTP ${statusCode}: ${raw.slice(0, 200)}`);
  }
  return parsed;
}

module.exports = { getToken, bcTask, sanitizeFilter, callAnthropic, httpsRequest, parseJson };
