// emailService.js — Client-side email sending service for dynamics.is
// Posts to the /api/email Azure Function which signs the request with
// Entra ID client credentials server-side.
//
// Usage:
//   const result = await sendEmail({ to, subject, body, isHtml, attachments });
//   if (!result.success) console.error(result.error);
"use strict";

/**
 * Email attachment descriptor.
 * @typedef {{ filename: string, contentType: string, base64: string }} EmailAttachment
 */

/**
 * Send an email via the /api/email Azure Function.
 *
 * @param {{ to: string, subject: string, body: string, isHtml?: boolean, attachments?: EmailAttachment[] }} opts
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendEmail({ to, subject, body, isHtml = false, attachments = [] }) {
  const endpoint = (typeof EMAIL_FUNCTION_URL !== "undefined" && EMAIL_FUNCTION_URL)
    ? EMAIL_FUNCTION_URL
    : "/api/email";

  try {
    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ to, subject, body, isHtml, attachments }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      return { success: false, error: json.error || `HTTP ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || "Network error" };
  }
}
