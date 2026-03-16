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
  const tenantId     = req.headers["x-bc-tenant"]        || process.env.BC_TENANT_ID;
  const clientId     = req.headers["x-bc-client-id"]     || process.env.BC_CLIENT_ID;
  const clientSecret = req.headers["x-bc-client-secret"] || process.env.BC_CLIENT_SECRET;
  const environment  = req.headers["x-bc-environment"]   || process.env.BC_ENVIRONMENT;
  const companyId    = req.headers["x-bc-company"];
  const endpoint     = (req.headers["x-bc-endpoint"] || "tasks").toLowerCase();

  if (!tenantId || !clientId || !clientSecret || !environment || !companyId) {
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing credentials: x-bc-company is always required; provide x-bc-tenant/id/secret/environment headers or configure server environment variables" }),
    };
    return;
  }

  if (!["tasks", "queues", "queue-status", "queue-retry", "history", "fetch-result", "fetch-request"].includes(endpoint)) {
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "x-bc-endpoint must be 'tasks', 'queues', 'queue-status', 'queue-retry', 'history', 'fetch-result', or 'fetch-request'" }),
    };
    return;
  }

  // ── Queue management actions (GetStatus / RetryTask) ──────────────────────
  // These don't use a CloudEvents envelope — they act on an existing queue item.
  if (endpoint === "queue-status" || endpoint === "queue-retry") {
    const queueId = req.headers["x-bc-queue-id"] || "";
    if (!queueId) {
      context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing x-bc-queue-id header" }) };
      return;
    }
    try {
      const token = await getToken(tenantId, clientId, clientSecret);
      const auth  = `Bearer ${token}`;
      const basePath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})`;

      if (endpoint === "queue-retry") {
        const result = await bcJson("POST", `${basePath}/queues(${queueId})/Microsoft.NAV.RetryTask`, auth, {});
        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
        return;
      }

      // queue-status: POST GetStatus, then if Updated fetch the result data URL
      const statusRes = await bcJson("POST", `${basePath}/queues(${queueId})/Microsoft.NAV.GetStatus`, auth, {});
      const statusValue = statusRes.value || statusRes.status || statusRes.statusValue || "";

      if (statusValue === "Updated") {
        // Fetch the queue record to get the data URL
        const queueRecord = await bcJson("GET", `${basePath}/queues(${queueId})`, auth, null);
        if (queueRecord.data && String(queueRecord.data).startsWith("https://api.businesscentral.dynamics.com/")) {
          if (queueRecord.datacontenttype && queueRecord.datacontenttype.includes("pdf")) {
            const { buffer, contentType } = await bcBinary(queueRecord.data, auth);
            context.res = { status: 200, headers: { "Content-Type": contentType || "application/pdf", "x-queue-status": "Updated" }, body: buffer, isRaw: true };
            return;
          }
          const dataPath = new URL(queueRecord.data).pathname + new URL(queueRecord.data).search;
          const result = await bcJson("GET", dataPath, auth, null);
          context.res = { status: 200, headers: { "Content-Type": "application/json", "x-queue-status": "Updated" }, body: JSON.stringify(result) };
          return;
        }
      }

      // Not done yet (Created) or gone (Deleted/None) — return status info
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json", "x-queue-status": statusValue },
        body: JSON.stringify({ _queueStatus: statusValue, _raw: statusRes }),
      };
    } catch (e) {
      context.res = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: e.message }) };
    }
    return;
  }

  // ── Fetch original request payload (/requests) ────────────────────────────
  if (endpoint === "fetch-request") {
    const itemId = req.headers["x-bc-item-id"] || "";
    // Basic GUID-shape validation to prevent path injection
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
      context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "x-bc-item-id must be a valid GUID" }) };
      return;
    }
    try {
      const token = await getToken(tenantId, clientId, clientSecret);
      const auth  = `Bearer ${token}`;
      const basePath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})`;
      // Call /requests({id})/data directly — no need to fetch the envelope first.
      const result = await bcJson("GET", `${basePath}/requests(${itemId})/data`, auth, null);
      // Normalise: the payload may come back as an object or a JSON string.
      const data = typeof result === "string" ? result : JSON.stringify(result);
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) };
    } catch (e) {
      context.res = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: e.message }) };
    }
    return;
  }

  // ── History listing (GET /tasks + GET /queues, combined & sorted) ──────────
  if (endpoint === "history") {
    try {
      const token = await getToken(tenantId, clientId, clientSecret);
      const auth  = `Bearer ${token}`;
      const basePath = `/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})`;
      const [tasksRes, queuesRes] = await Promise.all([
        bcJson("GET", `${basePath}/tasks`, auth, null).catch(() => ({ value: [] })),
        bcJson("GET", `${basePath}/queues`, auth, null).catch(() => ({ value: [] })),
      ]);
      const items = [
        ...(Array.isArray(tasksRes.value)  ? tasksRes.value  : []).map(i => ({ ...i, _endpoint: "tasks" })),
        ...(Array.isArray(queuesRes.value) ? queuesRes.value : []).map(i => ({ ...i, _endpoint: "queues" })),
      ].sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0)).slice(0, 100);
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) };
    } catch (e) {
      context.res = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: e.message }) };
    }
    return;
  }

  // ── Fetch result by data URL (for history replay) ─────────────────────────
  if (endpoint === "fetch-result") {
    const dataUrl = req.headers["x-bc-data-url"] || "";
    const dataContentType = req.headers["x-bc-datacontenttype"] || "";
    // SSRF guard — only allow Business Central API host
    if (!dataUrl.startsWith("https://api.businesscentral.dynamics.com/")) {
      context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "x-bc-data-url must be a businesscentral.dynamics.com URL" }) };
      return;
    }
    try {
      const token = await getToken(tenantId, clientId, clientSecret);
      const auth  = `Bearer ${token}`;
      if (dataContentType.includes("pdf")) {
        const { buffer, contentType } = await bcBinary(dataUrl, auth);
        context.res = { status: 200, headers: { "Content-Type": contentType || "application/pdf" }, body: buffer, isRaw: true };
      } else {
        const result = await bcJson("GET", dataUrl, auth, null);
        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
      }
    } catch (e) {
      context.res = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: e.message }) };
    }
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
        const ct = res.headers["content-type"] || "";
        // If BC returns plain text / markdown (e.g. Help.Implementation.Get), wrap it
        if (!ct.includes("application/json") && !data.trimStart().startsWith("{") && !data.trimStart().startsWith("[")) {
          resolve({ status: "Success", documentation: data });
          return;
        }
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
