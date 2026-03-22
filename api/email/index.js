"use strict";

const https = require("https");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "https://dynamics.is",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Simple email regex — validates structure without allowing injection via `to`
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Module-level token cache — survives across warm invocations of the same function instance
let _cachedToken = null;
let _tokenExpiry  = 0;

async function getGraphToken(tenantId, clientId, clientSecret) {
  if (_cachedToken && Date.now() < _tokenExpiry - 60000) return _cachedToken;

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         "https://graph.microsoft.com/.default",
  }).toString();

  const data = await httpsPost(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    body,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  if (data.error) {
    throw new Error(`Graph token error (${data.error}): ${data.error_description || ""}`);
  }
  if (!data.access_token) {
    throw new Error("Microsoft identity platform returned no access_token");
  }

  _cachedToken = data.access_token;
  _tokenExpiry  = Date.now() + data.expires_in * 1000;
  return _cachedToken;
}

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS_HEADERS, body: "" };
    return;
  }

  const tenantId     = process.env.EMAIL_TENANT_ID;
  const clientId     = process.env.EMAIL_CLIENT_ID;
  const clientSecret = process.env.EMAIL_CLIENT_SECRET;
  const senderMailbox = process.env.EMAIL_SENDER || "uat@dynamics.is";

  if (!tenantId || !clientId || !clientSecret) {
    context.res = {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server configuration missing." }),
    };
    return;
  }

  const { to, subject, body, isHtml = false, attachments = [] } = req.body || {};

  // Input validation
  if (!to)      return badRequest(context, "Missing required field: to");
  if (!subject) return badRequest(context, "Missing required field: subject");
  if (!body)    return badRequest(context, "Missing required field: body");
  if (!EMAIL_PATTERN.test(to)) return badRequest(context, "Invalid email address: to");

  try {
    const token = await getGraphToken(tenantId, clientId, clientSecret);

    const message = {
      subject,
      body: {
        contentType: isHtml ? "HTML" : "Text",
        content:     body,
      },
      toRecipients: [
        { emailAddress: { address: to } },
      ],
    };

    if (attachments.length) {
      message.attachments = attachments.map((a) => ({
        "@odata.type":  "#microsoft.graph.fileAttachment",
        name:           a.filename,
        contentType:    a.contentType,
        contentBytes:   a.base64,
      }));
    }

    const graphBody = JSON.stringify({ message, saveToSentItems: true });

    await httpsPost(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderMailbox)}/sendMail`,
      graphBody,
      {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      202  // Graph sendMail returns 202 Accepted with empty body on success
    );

    context.res = {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ success: true }),
    };
  } catch (e) {
    context.res = {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function badRequest(context, message) {
  context.res = {
    status: 400,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}

/**
 * HTTPS POST helper. Returns the parsed JSON body, or an empty object for
 * responses that have no body (e.g. Graph 202 Accepted on sendMail).
 *
 * @param {string} url
 * @param {string} body       String body (form-encoded or JSON)
 * @param {object} headers
 * @param {number} [expectedStatus]  If provided, throw if status !== expectedStatus
 */
function httpsPost(url, body, headers, expectedStatus) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   "POST",
        headers:  { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (expectedStatus !== undefined && res.statusCode !== expectedStatus) {
            // Surface the error body from Graph (never contains secrets)
            return reject(new Error(`Graph API error ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          if (!data.trim()) return resolve({});
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
