const https = require("https");

module.exports = async function (context, req) {
  const tenantId = process.env.BC_TENANT_ID;
  const environment = process.env.BC_ENVIRONMENT || "UAT";

  // --- Get path param, e.g. /api/bc?path=companies
  const bcPath = req.query.path;
  if (!bcPath) {
    context.res = { status: 400, body: { error: "Missing 'path' query parameter." } };
    return;
  }

  // --- Get Bearer token from Authorization header forwarded by frontend
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    context.res = { status: 401, body: { error: "Missing or invalid Authorization header." } };
    return;
  }

  const bcBase = `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${environment}/api/v2.0`;
  const url = `${bcBase}/${bcPath}`;

  try {
    if (req.method === "POST") {
      const result = await bcRequest("POST", url, authHeader, req.body);
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: result };
    } else {
      const result = await bcRequest("GET", url, authHeader, null);
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: result };
    }
  } catch (e) {
    context.res = { status: 502, body: { error: e.message } };
  }
};

function bcRequest(method, url, authHeader, bodyData) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = bodyData ? JSON.stringify(bodyData) : null;
    const headers = {
      Authorization: authHeader,
      Accept: "application/json",
    };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`BC API ${res.statusCode}: ${data}`));
            return;
          }
          try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid BC response")); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
