"use strict";

const Busboy     = require("busboy");
const XLSX       = require("xlsx");
const { callAnthropic } = require("../shared/bcClient");

let pdfParse;
try { pdfParse = require("pdf-parse/lib/pdf-parse"); } catch (_) {
  try { pdfParse = require("pdf-parse"); } catch (_2) { /* optional — falls back to document block */ }
}

let pdfjsLib;
try { pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js"); } catch (_) {
  try { pdfjsLib = require("pdfjs-dist/build/pdf.js"); } catch (_2) { /* optional */ }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "https://dynamics.is",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const EXTRACT_PROMPT =
  "Extract customer and order line information from this document. " +
  "The document may be a sales order, purchase order, draft invoice, quote, email, or any business document. " +
  "Return a JSON object with: customerName (string or null), customerNo (string or null), " +
  "orderLines (array of { itemNo, description, quantity, unitOfMeasure }), " +
  "requestedDeliveryDate (ISO date string or null), and notes (string or null). " +
  "Always extract as much as possible. " +
  "Only return { \"intent\": \"none\" } if the document is completely unreadable or contains zero business-relevant text. " +
  "Respond with ONLY the JSON object, no explanation.";

const DESCRIBE_PROMPT =
  "Please describe the contents of this document in plain text. " +
  "List any customer name, customer number, company name, item descriptions, quantities, prices, dates, and any other relevant business information you can see. " +
  "Be as specific as possible.";

// ── Parse multipart/form-data using busboy ─────────────────────────────────────

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let fileSizeExceeded = false;
    const fields = {};
    const files  = {};

    const bb = Busboy({
      headers: req.headers,
      limits:  { fileSize: MAX_FILE_BYTES },
    });

    bb.on("field", (name, value) => { fields[name] = value; });

    bb.on("file", (name, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on("data",  (c) => chunks.push(c));
      stream.on("limit", () => { fileSizeExceeded = true; });
      stream.on("close", () => {
        files[name] = { filename, mimeType, buffer: Buffer.concat(chunks) };
      });
    });

    bb.on("close", () => {
      if (fileSizeExceeded) {
        reject(new Error(`File exceeds the ${MAX_FILE_BYTES / 1048576} MB limit`));
      } else {
        resolve({ fields, files });
      }
    });

    bb.on("error", reject);

    // Azure Functions provides raw body as req.rawBody (string) or req.body (Buffer/string)
    const raw = req.rawBody ?? req.body;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? "", "binary");
    bb.write(buf);
    bb.end();
  });
}

// ── File → Claude content block(s) ────────────────────────────────────────────

async function fileToContent(file) {
  const { mimeType, buffer, filename } = file;
  const ext = (filename || "").split(".").pop().toLowerCase();

  // Excel
  if (mimeType.includes("spreadsheetml") || mimeType.includes("excel") || ext === "xlsx" || ext === "xls") {
    const wb   = XLSX.read(buffer, { type: "buffer" });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    const text = `Excel file: ${filename}\n\n${JSON.stringify(rows, null, 2)}`;
    return [{ type: "text", text }];
  }

  // PDF
  if (mimeType.includes("pdf") || ext === "pdf") {
    // Try pdfjs-dist direct extraction (more thorough than pdf-parse wrapper)
    if (pdfjsLib) {
      try {
        const data = new Uint8Array(buffer);
        const doc  = await pdfjsLib.getDocument({ data }).promise;
        let text = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const page    = await doc.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(item => item.str).join(" ") + "\n";
        }
        text = text.trim();
        if (text.length > 10) {
          return [{ type: "text", text: `PDF file: ${filename}\n\n${text.slice(0, 16000)}` }];
        }
      } catch (_) { /* fall through */ }
    }
    // Try pdf-parse as second option
    if (pdfParse) {
      try {
        const parsed = await pdfParse(buffer);
        const text = (parsed.text || "").trim();
        if (text.length > 10) {
          return [{ type: "text", text: `PDF file: ${filename}\n\n${text.slice(0, 16000)}` }];
        }
      } catch (_) { /* fall through to document block */ }
    }
    // Fallback: send as native document block (works for image-based PDFs with OCR-capable models)
    return [{
      type:   "document",
      source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
    }];
  }

  // Image
  if (mimeType.includes("jpeg") || mimeType.includes("jpg") || mimeType.includes("png") || ext === "jpg" || ext === "png") {
    const imgMime = (mimeType.includes("png") || ext === "png") ? "image/png" : "image/jpeg";
    return [{
      type:   "image",
      source: { type: "base64", media_type: imgMime, data: buffer.toString("base64") },
    }];
  }

  // .eml — strip MIME headers to just key fields + plain text body
  if (mimeType.includes("message/rfc822") || ext === "eml") {
    const raw  = buffer.toString("utf8");
    const important = ["From", "To", "Subject", "Date"];
    const headerLines = raw.split(/\r?\n/)
      .filter(l => important.some(h => l.startsWith(h + ":")));
    const bodyStart = raw.indexOf("\r\n\r\n") > -1 ? raw.indexOf("\r\n\r\n") + 4 : raw.indexOf("\n\n") + 2;
    const bodyText  = raw.slice(bodyStart, bodyStart + 8000); // cap at 8 KB
    const text = `Email:\n${headerLines.join("\n")}\n\n${bodyText}`;
    return [{ type: "text", text }];
  }

  // .msg — use msg-parser if available, fall back to raw text
  if (mimeType.includes("message") || ext === "msg") {
    try {
      const { MsgReader } = require("@kenjiuno/msgreader"); // optional dependency
      const reader    = new MsgReader(buffer);
      const info      = reader.getFileData();
      const text = `Email:\nSubject: ${info.subject || ""}\nFrom: ${info.senderName || ""} <${info.senderEmail || ""}>\n\n${info.body || ""}`;
      return [{ type: "text", text }];
    } catch {
      // msg-parser not available or parse failed — treat as binary text best-effort
      return [{ type: "text", text: `MSG file: ${filename} (could not parse body)` }];
    }
  }

  // Fallback: treat as plain text
  return [{ type: "text", text: buffer.toString("utf8").slice(0, 16000) }];
}

// ── Azure Function entry point ─────────────────────────────────────────────────

module.exports = async function (context, req) {
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS_HEADERS, body: "" };
    return;
  }

  const contentType = (req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    context.res = {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Expected multipart/form-data" }),
    };
    return;
  }

  try {
    const { fields, files } = await parseMultipart(req);

    const apiKey = fields.apiKey;
    if (!apiKey) {
      context.res = {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "apiKey field is required" }),
      };
      return;
    }

    const file = files.file;
    if (!file) {
      context.res = {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "file field is required" }),
      };
      return;
    }

    // Override mimeType with client hint if more specific
    if (fields.mimeType) file.mimeType = fields.mimeType;

    const contentBlocks = await fileToContent(file);

    // Use beta header for document blocks — required for some model versions, harmless for others
    const hasPdf = contentBlocks.some(b => b.type === "document");
    const extraHeaders = hasPdf ? { "anthropic-beta": "pdfs-2024-09-25" } : {};
    const modelPayload = (blocks, prompt) => ({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages:   [{ role: "user", content: [...blocks, { type: "text", text: prompt }] }],
    });

    // Step 1: structured extraction
    const response = await callAnthropic(apiKey, modelPayload(contentBlocks, EXTRACT_PROMPT), extraHeaders);
    const textBlock = (response.content || []).find(b => b.type === "text");
    const raw       = (textBlock?.text || "").trim();

    let extracted;
    try {
      const jsonStr = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
      extracted     = JSON.parse(jsonStr);
    } catch {
      extracted = { intent: "none", parseError: raw.slice(0, 200) };
    }

    // Step 2: if structured extraction failed, do a plain-text description fallback
    if (!extracted || extracted.intent === "none") {
      try {
        const descResp  = await callAnthropic(apiKey, modelPayload(contentBlocks, DESCRIBE_PROMPT), extraHeaders);
        const descBlock = (descResp.content || []).find(b => b.type === "text");
        const descText  = (descBlock?.text || "").trim();
        // Check if Claude is saying the document is unreadable
        const BLANK_SIGNALS = ["completely blank", "no visible content", "entirely white", "no text", "cannot see", "no content", "blank page", "empty page", "unreadable"];
        const appearsBlank = BLANK_SIGNALS.some(s => descText.toLowerCase().includes(s));
        if (descText && !appearsBlank) {
          extracted = { intent: "description", description: descText };
        } else {
          extracted = { intent: "unreadable", description: descText };
        }
      } catch (_) { /* fallback failed — keep intent:none */ }
    }

    context.res = {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ extractedData: extracted, rawText: raw }),
    };
  } catch (e) {
    context.res = {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
