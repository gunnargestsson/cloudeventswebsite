"use strict";

const https = require("https");

const BC_HOST   = "api.businesscentral.dynamics.com";
const MSFT_HOST = "login.microsoftonline.com";

async function getToken(tenantId, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         "https://api.businesscentral.dynamics.com/.default",
  }).toString();
  const buf = Buffer.from(body, "utf8");

  const raw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: MSFT_HOST,
      path:     `/${tenantId}/oauth2/v2.0/token`,
      method:   "POST",
      headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": buf.length },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });

  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`Token error (${parsed.error}): ${parsed.error_description || ""}`);
  if (!parsed.access_token) throw new Error("No access_token returned");
  return parsed.access_token;
}

async function httpsGet(hostAndPath, auth) {
  const url = new URL(hostAndPath.startsWith("https://") ? hostAndPath : `https://${BC_HOST}${hostAndPath}`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   "GET",
      headers:  { Accept: "application/json", Authorization: auth },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, raw: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bc-tenant, x-bc-client-id, x-bc-client-secret, x-bc-environment",
};

module.exports = async function (context, req) {
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS };
    return;
  }

  const tenantId     = req.headers["x-bc-tenant"]        || process.env.BC_TENANT_ID;
  const clientId     = req.headers["x-bc-client-id"]     || process.env.BC_CLIENT_ID;
  const clientSecret = req.headers["x-bc-client-secret"] || process.env.BC_CLIENT_SECRET;
  const environment  = req.headers["x-bc-environment"]   || process.env.BC_ENVIRONMENT;

  if (!tenantId || !clientId || !clientSecret || !environment) {
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
      body: JSON.stringify({ error: "Missing credentials: provide x-bc-* headers or configure server environment variables" }),
    };
    return;
  }

  try {
    const token = await getToken(tenantId, clientId, clientSecret);
    const { statusCode, raw } = await httpsGet(
      `/v2.0/${tenantId}/${environment}/api/v2.0/companies`,
      `Bearer ${token}`,
    );

    if (statusCode !== 200) {
      context.res = {
        status: statusCode,
        headers: { "Content-Type": "application/json", ...CORS },
        body: JSON.stringify({ error: `BC returned HTTP ${statusCode}: ${raw.slice(0, 300)}` }),
      };
      return;
    }

    const data      = JSON.parse(raw);
    const companies = (data.value || []).map(c => ({ id: c.id, name: c.name, displayName: c.displayName }));
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
      body: JSON.stringify({ companies }),
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
