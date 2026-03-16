const https = require("https");

const BC_HOST = "api.businesscentral.dynamics.com";
const MSFT_HOST = "login.microsoftonline.com";

async function getToken(tenantId, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://api.businesscentral.dynamics.com/.default",
  }).toString();

  const data = await httpsPost(
    MSFT_HOST,
    `/${tenantId}/oauth2/v2.0/token`,
    { "Content-Type": "application/x-www-form-urlencoded" },
    body
  );

  if (data.error) throw new Error(`Token error (${data.error}): ${data.error_description || ""}`);
  if (!data.access_token) throw new Error("Microsoft identity platform returned no access_token");
  return data.access_token;
}

module.exports = async function (context, req) {
  const tenantId    = req.headers["x-bc-tenant"];
  const clientId    = req.headers["x-bc-client-id"];
  const clientSecret = req.headers["x-bc-client-secret"];
  const environment = req.headers["x-bc-environment"];
  const companyId   = req.headers["x-bc-company"];
  const endpoint    = (req.headers["x-bc-endpoint"] || "tasks").toLowerCase();

  if (!tenantId || !clientId || !clientSecret || !environment || !companyId) {
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing required headers: x-bc-tenant, x-bc-client-id, x-bc-client-secret, x-bc-environment, x-bc-company" }),
    };
    return;
  }

  if (endpoint !== "tasks" && endpoint !== "queues") {
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "x-bc-endpoint must be 'tasks' or 'queues'" }),
    };
    return;
  }

  const envelope = req.body;
  if (!envelope || !envelope.type) {
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Request body must be a CloudEvents envelope with a 'type' field." }),
    };
    return;
  }

  try {
    const token = await getToken(tenantId, clientId, clientSecret);
    const auth  = `Bearer ${token}`;
    const basePath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})`;

    if (endpoint === "queues") {
      const result = await bcJson("POST", `${basePath}/queues`, auth, envelope);
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
      return;
    }

    // tasks — two-step pattern per SKILL.md §3.1
    const task = await bcJson("POST", `${basePath}/tasks`, auth, envelope);

    // Direct error or no follow-up URL (some inbound types)
    if (task.status === "Error" || !task.data || !String(task.data).startsWith("https://api.businesscentral.dynamics.com/")) {
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(task) };
      return;
    }

    // PDF — return binary (SKILL.md §7.3 PDF types)
    if (task.datacontenttype && task.datacontenttype.includes("pdf")) {
      const { buffer, contentType } = await bcBinary(task.data, auth);
      context.res = { status: 200, headers: { "Content-Type": contentType || "application/pdf" }, body: buffer, isRaw: true };
      return;
    }

    // Step 2: fetch result from data URL
    const dataPath = new URL(task.data).pathname + new URL(task.data).search;
    const result = await bcJson("GET", dataPath, auth, null);
    context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };

  } catch (e) {
    context.res = {
      status: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function bcJson(method, urlOrPath, auth, body) {
  return new Promise((resolve, reject) => {
    const isFullUrl = urlOrPath.startsWith("https://");
    const u = isFullUrl ? new URL(urlOrPath) : null;
    const hostname = u ? u.hostname : BC_HOST;
    const path     = u ? (u.pathname + u.search) : urlOrPath;

    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = {
      Authorization: auth,
      Accept: "application/json",
      ...(bodyStr != null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}),
    };

    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch {
          reject(new Error(`Non-JSON response from BC (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function bcBinary(url, auth) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: { Authorization: auth } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error("Invalid response from Microsoft identity platform")); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
