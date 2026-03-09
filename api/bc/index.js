const https = require("https");

// Module-level token cache — survives across warm invocations of the same function instance
let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken(tenantId, clientId, clientSecret) {
  if (_cachedToken && Date.now() < _tokenExpiry - 60000) return _cachedToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://api.businesscentral.dynamics.com/.default",
  }).toString();

  const data = await post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    body,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  if (data.error) {
    throw new Error(`Token error (${data.error}): ${data.error_description || ""}`);
  }
  if (!data.access_token) {
    throw new Error("Microsoft identity platform returned no access_token");
  }

  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _cachedToken;
}

module.exports = async function (context, req) {
  const tenantId = process.env.BC_TENANT_ID;
  const clientId = process.env.BC_CLIENT_ID;
  const clientSecret = process.env.BC_CLIENT_SECRET;
  const environment = process.env.BC_ENVIRONMENT || "UAT";

  if (!tenantId || !clientId || !clientSecret) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server configuration missing." }),
    };
    return;
  }

  const bcPath = req.query.path;
  if (!bcPath) {
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing 'path' query parameter." }),
    };
    return;
  }

  try {
    const accessToken = await getToken(tenantId, clientId, clientSecret);
    const bcBase = `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${environment}/api/v2.0`;
    const url = `${bcBase}/${bcPath}`;
    const authHeader = `Bearer ${accessToken}`;

    if (req.method === "POST") {
      const result = await bcRequest("POST", url, authHeader, req.body);
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      };
    } else {
      const result = await bcRequest("GET", url, authHeader, null);
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      };
    }
  } catch (e) {
    context.res = {
      status: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message }),
    };
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
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid response from Business Central API"));
          }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid response from Microsoft identity platform"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
