"use strict";

const http = require("http");
const https = require("https");

const { callAnthropic, parseJson } = require("../shared/bcClient");

const MAX_TURNS = 10;
const TOOL_RESULT_MAX_CHARS = 20000;
const TOOL_DENYLIST = new Set(["encrypt_data", "decrypt_data"]);
const LANGUAGE_NAMES = { 1039: "Icelandic", 1030: "Danish", 1044: "Norwegian" };
const AUTO_MODEL_FALLBACK = "claude-sonnet-4-20250514";

function parseUrlHost(value) {
  if (!value) return "";
  try {
    if (/^https?:\/\//i.test(String(value))) return new URL(String(value)).hostname.toLowerCase();
  } catch {}
  return String(value).split(",")[0].trim().split(":")[0].toLowerCase();
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return "https://dynamics.is";

  const originHost = parseUrlHost(origin);
  const requestHost = parseUrlHost(req.headers["x-forwarded-host"] || req.headers.host || process.env.WEBSITE_HOSTNAME || "");
  if (originHost === requestHost || originHost === "dynamics.is" || originHost === "localhost" || originHost === "127.0.0.1") {
    return origin;
  }
  return "https://dynamics.is";
}

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": getAllowedOrigin(req),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function buildSystemPrompt(lcid) {
  const language = LANGUAGE_NAMES[Number(lcid) || 1033];
  const languageInstruction = language ? `\n\nIMPORTANT: The user selected ${language}. Reply in ${language} throughout this conversation.` : "";
  return (
    "You are a Business Central assistant for dynamics.is. " +
    "You can use Business Central MCP tools to answer questions with live data and metadata.\n\n" +
    "RULES:\n" +
    "1. Use MCP tools whenever the answer depends on live Business Central data, metadata, or configuration.\n" +
    "2. Prefer read operations before write operations.\n" +
    "3. Before calling any mutation tool, explain what will change and ask the user for confirmation unless the user has already clearly confirmed the exact action in the current conversation.\n" +
    "4. Keep answers concise and business-facing unless the user asks for technical detail.\n" +
    "5. If a tool fails, say what failed in plain language and continue only if there is a safe fallback.\n" +
    "6. When a result comes from a tool, make that clear in your answer.\n" +
    "7. Do not mention secrets, credentials, API keys, or internal configuration values in replies."
  ) + languageInstruction;
}

function normalizeMessage(message) {
  if (!message || !message.role) return null;
  if (typeof message.content === "string") {
    return { role: message.role, content: [{ type: "text", text: message.content }] };
  }
  if (Array.isArray(message.content)) {
    return { role: message.role, content: message.content };
  }
  return null;
}

function sanitizeErrorMessage(message) {
  return String(message || "Unknown error")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-token]")
    .slice(0, 500);
}

function truncateToolResult(text) {
  const value = String(text || "");
  if (value.length <= TOOL_RESULT_MAX_CHARS) return value;
  return value.slice(0, TOOL_RESULT_MAX_CHARS) + "\n\n[Tool output truncated for size]";
}

function resolveAnthropicApiKey(body) {
  return (body.claudeApiKey || body.apiKey || "").trim();
}

function resolveModel() {
  const configured = String(process.env.ANTHROPIC_MODEL || "").trim();
  return configured || AUTO_MODEL_FALLBACK;
}

function buildBcConfig(input) {
  const source = input || {};
  const mode = source.mode === "custom" ? "custom" : "server";
  return {
    mode,
    companyId: source.companyId || "",
    companyName: source.companyName || "",
    lcid: Number(source.lcid) || 1033,
    tenantId: mode === "custom" ? (source.tenantId || "") : "",
    environment: mode === "custom" ? (source.environment || "") : "",
    clientId: mode === "custom" ? (source.clientId || "") : "",
    clientSecret: mode === "custom" ? (source.clientSecret || "") : "",
  };
}

function validateBcConfig(bcConfig) {
  if (!bcConfig.companyId) throw new Error("bcConfig.companyId is required");
  if (bcConfig.mode === "custom" && (!bcConfig.tenantId || !bcConfig.environment || !bcConfig.clientId || !bcConfig.clientSecret)) {
    throw new Error("Custom mode requires tenantId, environment, clientId, and clientSecret");
  }
}

function makeJsonRpcBody(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function getSelfBaseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || process.env.WEBSITE_HOSTNAME || "localhost:7071";
  const protoHeader = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = protoHeader || (/localhost|127\.0\.0\.1/i.test(host) ? "http" : "https");
  return `${protocol}://${host}`;
}

async function callMcp(req, body, extraHeaders = {}) {
  const url = new URL("/api/mcp", getSelfBaseUrl(req));
  const client = url.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body, "utf8"),
        ...extraHeaders,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode >= 400) {
          reject(new Error(`MCP HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(parseJson(raw, "MCP server"));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function listMcpTools(req, bcConfig) {
  const response = await callMcp(
    req,
    makeJsonRpcBody("tools/list", {}, 1),
    bcConfig.companyId ? { "x-company-id": bcConfig.companyId } : {},
  );
  if (response.error) throw new Error(response.error.message || "Could not load Business Central tools.");
  return ((response.result || {}).tools || []).filter((tool) => !TOOL_DENYLIST.has(tool.name));
}

function toAnthropicTools(mcpTools) {
  return mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function mergeToolArguments(input, bcConfig) {
  const args = { ...(input || {}) };
  if (bcConfig.companyId && args.companyId == null) args.companyId = bcConfig.companyId;
  if (bcConfig.lcid && args.lcid == null) args.lcid = bcConfig.lcid;
  if (bcConfig.mode === "custom") {
    if (bcConfig.tenantId && args.tenantId == null) args.tenantId = bcConfig.tenantId;
    if (bcConfig.environment && args.environment == null) args.environment = bcConfig.environment;
    if (bcConfig.clientId && args.clientId == null) args.clientId = bcConfig.clientId;
    if (bcConfig.clientSecret && args.clientSecret == null) args.clientSecret = bcConfig.clientSecret;
  }
  return args;
}

async function callTool(req, toolName, toolInput, bcConfig, requestId) {
  const response = await callMcp(
    req,
    makeJsonRpcBody("tools/call", { name: toolName, arguments: mergeToolArguments(toolInput, bcConfig) }, requestId),
    bcConfig.companyId ? { "x-company-id": bcConfig.companyId } : {},
  );

  if (response.error) throw new Error(response.error.message || `Unknown MCP error calling ${toolName}`);
  if (response.result?.isError) throw new Error(`MCP tool ${toolName} returned an error`);
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  return truncateToolResult(text || "{}");
}

async function runClaudeLoop(req, apiKey, messages, bcConfig) {
  const anthropicTools = toAnthropicTools(await listMcpTools(req, bcConfig));
  const conversation = messages.map(normalizeMessage).filter(Boolean);
  const toolTrace = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await callAnthropic(apiKey, {
      model: resolveModel(),
      max_tokens: 4096,
      system: buildSystemPrompt(bcConfig.lcid),
      tools: anthropicTools,
      messages: conversation,
    });

    totalInputTokens += Number(response.usage?.input_tokens || 0);
    totalOutputTokens += Number(response.usage?.output_tokens || 0);

    const content = Array.isArray(response.content) ? response.content : [];
    const toolUseBlocks = content.filter((block) => block.type === "tool_use");

    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      const reply = content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n").trim();
      return {
        reply: reply || "",
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        toolTrace,
      };
    }

    conversation.push({ role: "assistant", content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const startedAt = Date.now();
      try {
        const resultText = await callTool(req, block.name, block.input, bcConfig, 100 + turn);
        toolTrace.push({ tool: block.name, status: "success", durationMs: Date.now() - startedAt });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
      } catch (error) {
        const safeMessage = sanitizeErrorMessage(error.message);
        toolTrace.push({ tool: block.name, status: "error", durationMs: Date.now() - startedAt, error: safeMessage });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${safeMessage}`, is_error: true });
      }
    }

    conversation.push({ role: "user", content: toolResults });
  }

  return {
    reply: "The conversation hit the tool-call limit before finishing.",
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    toolTrace,
  };
}

module.exports = async function (context, req) {
  const headers = corsHeaders(req);

  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers, body: "" };
    return;
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const bcConfig = buildBcConfig(body.bcConfig);
  const apiKey = resolveAnthropicApiKey(body);

  if (!messages || !messages.length) {
    context.res = { status: 400, headers, body: JSON.stringify({ error: "messages array is required" }) };
    return;
  }

  try {
    validateBcConfig(bcConfig);
    if (!apiKey) throw new Error("Please enter your Claude API key first.");

    const result = await runClaudeLoop(req, apiKey, messages, bcConfig);
    context.res = { status: 200, headers, body: JSON.stringify(result) };
  } catch (error) {
    context.log.warn("[claude-chat]", sanitizeErrorMessage(error.message));
    context.res = {
      status: error.message === "Please enter your Claude API key first." ? 400 : 502,
      headers,
      body: JSON.stringify({ error: sanitizeErrorMessage(error.message) }),
    };
  }
};