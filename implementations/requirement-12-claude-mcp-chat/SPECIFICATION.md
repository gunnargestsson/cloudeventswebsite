# Requirement 12: Claude Website Chat via MCP

## Status: Implemented

---

## Overview

Add a new website page that lets the user chat with Anthropic Claude while using the existing
Business Central MCP server at `/api/mcp` as Claude's tool backend.

This requirement is intentionally broader than the existing Sales Order Assistant:
- The assistant is not limited to sales orders.
- Claude can use the MCP tool catalogue already exposed by Requirement 8.
- The website must forward the active BC access configuration to the MCP server so tool calls run
  against the same BC environment and company the user selected on the site.

The feature consists of:
- A new standalone page, `claude-mcp-chat.html`
- A new Azure Function chat bridge, `/api/claude-chat`
- A server-side MCP bridge inside that function which calls `/api/mcp` `tools/list` and `tools/call`
- Reuse of `settings.js` so BC connection state comes from the existing landing page / shared settings

---

## Goal

Allow a user to ask Claude general Business Central questions from the website, while Claude can
invoke the site's own MCP tools for metadata, records, message types, translations, and other BC
operations.

Examples:
- "List all companies and tell me which one I am connected to"
- "Show me the Customer fields in Icelandic"
- "Find item 1000 and summarize pricing-related fields"
- "Create a translation row for this UI string"
- "Call the Customer.Balance.Get message type for customer 10000"

---

## Core Decision

**Yes, this is feasible** with the current architecture, but the website should not call Claude and
MCP directly from the browser.

Instead, use a **server-side chat bridge**:

```text
Browser (claude-mcp-chat.html)
  -> POST /api/claude-chat
      -> Anthropic Messages API
      -> /api/mcp tools/list
      -> /api/mcp tools/call
      -> return assistant reply + tool trace summary
```

Reasons:
- Keeps the Anthropic API key out of browser JavaScript when server mode is used
- Centralises MCP protocol handling in one place
- Lets us forward BC configuration to MCP in a controlled format
- Keeps future rate limiting, audit logging, and guardrails on the server side

---

## Design Decisions

| # | Question | Answer |
|---|----------|--------|
| D1 | Claude invocation location | Server-side in new `/api/claude-chat` Azure Function |
| D2 | MCP transport | Existing Streamable HTTP endpoint at `/api/mcp` |
| D3 | Tool discovery | Load tools dynamically from `/api/mcp` via `tools/list` on first chat turn per session |
| D4 | Tool execution | `/api/claude-chat` performs Claude tool loop and calls `/api/mcp` `tools/call` |
| D5 | BC settings source | Reuse `settings.js` and current landing-page configuration |
| D6 | BC config forwarding | Forward website BC config to MCP on every tool call |
| D7 | Server mode behaviour | No client credentials sent if site is in server mode; MCP falls back to env vars, but selected company is still forwarded |
| D8 | Custom mode behaviour | Website sends custom BC credentials to `/api/claude-chat`; bridge forwards them to MCP per tool call |
| D9 | Claude API key | Required from the web page (same pattern as AI Sales Assistant) |
| D10 | Chat history persistence | Browser session only for v1 |
| D11 | File uploads | Out of scope for v1; text-only chat |
| D12 | Tool scope | Start with all safe existing MCP tools except explicit deny-list for dangerous or admin-only operations |

---

## User Experience

### New Page

Create `claude-mcp-chat.html` as a peer to:
- `bc-portal.html`
- `bc-metadata-explorer.html`
- `bc-cloud-events-explorer.html`
- `bc-open-mirror.html`

The page must:
- Reuse the site's visual language
- Reuse `settings.js`
- Redirect to `index.html` if `bcSettingsReady()` is false
- Show the currently selected company and mode (`server` or `custom`)
- Provide a simple chat interface with message history, input box, send button, clear button, and tool activity panel

### Layout

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Header: Home | Claude Chat | Connected company | Mode               │
├───────────────────────────────────────┬──────────────────────────────┤
│ Chat history                          │ Tool activity                │
│                                       │                              │
│ User: Show me item categories         │ tools/list loaded 18 tools   │
│ Claude: I'll inspect the metadata...  │ get_records(Customer)        │
│ Claude: Here is a summary...          │ get_table_fields(Item)       │
│                                       │                              │
├───────────────────────────────────────┴──────────────────────────────┤
│ [ message input........................................ ] [ Send ]   │
└──────────────────────────────────────────────────────────────────────┘
```

### Minimum UX Requirements

- Streaming is optional for v1; standard request/response is acceptable
- Show a working indicator while Claude is processing
- Show which MCP tool Claude used, with start/success/error states
- Show clear, non-technical error messages for:
  - missing Claude key
  - missing BC configuration
  - MCP tool failure
  - MCP timeout
  - Anthropic API error
- Add a "Clear chat" action that resets local session history

---

## Routing

Add a new navigation card from the landing page:
- Title: `Claude Chat`
- Description: `Chat with Claude using Business Central MCP tools`
- Route: `/claude-mcp-chat`

Add a rewrite rule in `staticwebapp.config.json` if needed so `/claude-mcp-chat` resolves to
`claude-mcp-chat.html`.

---

## Architecture

### Frontend

**File:** `claude-mcp-chat.html`

Responsibilities:
- Load BC settings via `bcSettingsLoad()`
- Detect current mode from `localStorage` (`bc_portal_mode`)
- Build request body for `/api/claude-chat`
- Maintain local chat transcript in memory or `sessionStorage`
- Render assistant replies and tool activity

### Backend

**File:** `api/claude-chat/index.js`

Responsibilities:
- Validate chat request
- Resolve Claude API key
- Build system prompt
- Fetch MCP tool definitions from `/api/mcp`
- Convert MCP tools to Anthropic tool format
- Run the Claude tool loop
- Forward BC config to MCP on each tool call
- Return final assistant reply plus structured tool trace

### Shared Helpers

Reuse existing helpers where practical:
- `api/shared/bcClient.js` for Anthropic HTTP calling patterns
- shared HTTP helper for calling local `/api/mcp`

---

## Request Contract: `/api/claude-chat`

### Request Body

```json
{
  "messages": [
    { "role": "user", "content": "Show me the Customer table fields" }
  ],
  "claudeApiKey": "browser-supplied-key",
  "bcConfig": {
    "mode": "custom",
    "tenantId": "...",
    "environment": "Production",
    "clientId": "...",
    "clientSecret": "...",
    "companyId": "...",
    "companyName": "CRONUS IS",
    "lcid": 1039
  }
}
```

### Response Body

```json
{
  "reply": "I inspected the Customer table and found 132 fields...",
  "usage": {
    "inputTokens": 1234,
    "outputTokens": 456
  },
  "toolTrace": [
    {
      "tool": "get_table_fields",
      "status": "success",
      "durationMs": 312
    }
  ]
}
```

---

## BC Access Configuration Flow

This is the key requirement for the feature.

### Source of truth

The website already stores BC configuration in shared local storage via `settings.js`:
- `tenant`
- `env`
- `clientId`
- `clientSecret`
- `companyId`
- `companyName`
- `lcid`

`claude-mcp-chat.html` must read those values using `bcSettingsLoad()` and include them in the
`bcConfig` object sent to `/api/claude-chat`.

### Forwarding rules

The backend must forward BC configuration from the website to the MCP server as follows.

#### Custom mode

When `bc_portal_mode === "custom"`, `/api/claude-chat` must include the user's BC credentials on
every MCP `tools/call` request.

Preferred forwarding payload inside MCP tool arguments:

```json
{
  "tenantId": "...",
  "environment": "Production",
  "clientId": "...",
  "clientSecret": "...",
  "companyId": "...",
  "lcid": 1039,
  "table": "Customer"
}
```

This matches Requirement 8, which already supports per-call credential overrides.

#### Server mode

When `bc_portal_mode === "server"`:
- Do not send tenant/client/secret from the browser, because they are not available client-side
- `/api/claude-chat` must still forward the selected `companyId` and `lcid`
- `/api/mcp` then uses its own env vars for BC credentials

Forwarding payload:

```json
{
  "companyId": "1998a733-7a01-f111-a1f9-6045bd750e1f",
  "lcid": 1039,
  "table": "Customer"
}
```

### Company targeting

Every MCP tool call from the Claude bridge must target the currently selected company from the
website, not "first company" fallback behaviour.

Requirement 8 currently documents support for `x-company-id` and company-aware credential handling.
Implementation for this feature should use one of these consistently:
- include `companyId` in tool arguments if the MCP tool layer supports it directly
- or send `x-company-id` header from `/api/claude-chat` to `/api/mcp`

For v1, choose one path and apply it to **all** Claude-driven MCP calls.

### Optional encrypted forwarding

If plaintext forwarding becomes a concern, `/api/claude-chat` may first call MCP `encrypt_data` and
then use `encryptedConn` or `x-encrypted-conn` on subsequent MCP requests.

That is optional for this requirement. The minimum requirement is that the website-selected BC
configuration reaches MCP correctly and deterministically.

---

## Claude Tool Loop

### Step 1: Load tool catalogue

On the first user message of a chat session, `/api/claude-chat` calls MCP:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

Convert each MCP tool to Anthropic tool format:
- `name` -> `name`
- `description` -> `description`
- `inputSchema` -> `input_schema`

### Step 2: Call Claude

Send:
- system prompt
- chat history
- translated MCP tool definitions

### Step 3: Execute tool calls

When Claude returns `tool_use` blocks, `/api/claude-chat` must:
1. Read the tool name and input
2. Merge in BC config from the website
3. Call `/api/mcp` `tools/call`
4. Return the tool result to Claude as a `tool_result`
5. Continue until Claude returns a final assistant message or max turn limit is hit

### Turn limit

Use a max of **10 Claude turns** per user message for v1, matching the pattern used in the Sales
Order Assistant.

### Tool deny-list

Start with a deny-list for tools that should not be exposed to a general-purpose website chat until
explicitly approved. Initial deny-list:
- `encrypt_data`
- `decrypt_data`

Other write tools may remain enabled, but the system prompt must instruct Claude to confirm before
mutation operations such as:
- `set_records`
- `set_translations`
- `set_integration_timestamp`
- `reverse_integration_timestamp`

An acceptable v1 alternative is a stricter allow-list of read-only tools plus `set_translations`.

---

## System Prompt Requirements

The Claude system prompt must instruct the model to:
- Use MCP tools whenever the answer depends on live BC data or metadata
- Prefer read operations before write operations
- Ask for confirmation before calling mutation tools
- Keep answers concise and business-facing unless the user asks for technical detail
- Respect the selected language when `lcid` maps to a known language
- Mention when data came from a tool call versus when the answer is general guidance

Language handling should mirror the pattern already used in `api/chat/index.js`:
- `1039` -> Icelandic
- `1030` -> Danish
- `1044` -> Norwegian
- otherwise default to English

---

## Frontend Behaviour Details

### Boot sequence

1. Load `settings.js`
2. If `bcSettingsReady()` is false, redirect to `index.html`
3. Read mode and company info from `bcSettingsLoad()`
4. Render connection badge:
   - `Server mode · CRONUS IS`
   - or `Custom mode · CRONUS IS`
5. Restore prior session messages if available

### Send flow

1. User types a message
2. Frontend appends local user bubble immediately
3. Frontend POSTs to `/api/claude-chat`
4. Frontend renders returned assistant reply
5. Frontend updates tool activity panel from `toolTrace`

### Clear flow

Clears:
- in-memory transcript
- `sessionStorage` chat state for this page

Does not clear:
- BC connection settings in `localStorage`

---

## Security

### Required

- CORS restricted to the site origin, matching existing Azure Functions patterns
- Anthropic API key never echoed back in responses
- MCP errors sanitized before returning to the browser
- No raw BC credentials written to browser-visible logs
- No raw BC credentials included in Claude prompt text

### Recommended

- Keep using browser-supplied API key (same UX pattern as AI Sales Assistant)
- Add per-IP or per-session rate limiting to `/api/claude-chat`
- Add request timeout around MCP tool calls
- Add server-side allow-list for exposed MCP tools

---

## Files to Add / Change

### New files

- `claude-mcp-chat.html`
- `api/claude-chat/index.js`
- `api/claude-chat/function.json`

### Existing files to update

- `index.html` — add Claude Chat navigation card
- `staticwebapp.config.json` — add route mapping if necessary
- `implementations/README.md` — add this requirement entry

### Optional shared helper updates

- `settings.js` — only if a small helper is needed to expose mode or build a chat-safe BC config object
- `api/shared/bcClient.js` — only if Anthropic helper reuse reduces duplication cleanly

---

## Example MCP Call From `/api/claude-chat`

### `tools/call` request

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "get_table_fields",
    "arguments": {
      "table": "Customer",
      "lcid": 1039,
      "tenantId": "...",
      "environment": "Production",
      "clientId": "...",
      "clientSecret": "...",
      "companyId": "1998a733-7a01-f111-a1f9-6045bd750e1f"
    }
  }
}
```

### Claude-facing tool result

```json
{
  "company": "CRONUS IS",
  "table": { "id": 18, "name": "Customer", "caption": "Customer" },
  "permissions": { "read": true, "write": true },
  "fieldCount": 132,
  "fields": [ ... ]
}
```

---

## Error Handling

### Frontend-visible errors

| Condition | Message |
|---|---|
| No BC settings selected | `Select a Business Central connection on the home page first.` |
| No Claude API key and no env var configured | `Claude is not configured for this site.` |
| MCP `tools/list` failed | `Could not load Business Central tools.` |
| MCP tool call failed | `Claude could not complete one of the Business Central tool calls.` |
| Anthropic request failed | `Claude did not respond successfully.` |
| Max turns reached | `The conversation hit the tool-call limit before finishing.` |

### Backend logging

Log:
- request ID
- tool names used
- per-tool durations
- Anthropic status code
- MCP status code

Do not log:
- `clientSecret`
- raw Claude API key
- full browser request body when it contains secrets

---

## Out of Scope for v1

- File upload / document chat
- Long-running streaming responses
- Multi-user shared chat history
- Approval workflow UI for destructive tool calls
- Fine-grained per-tool RBAC
- Direct browser-to-MCP or browser-to-Anthropic integration

---

## Testing Checklist

### Basic flow

- Open `claude-mcp-chat.html` after connecting on the landing page
- Verify selected company and mode are displayed correctly
- Ask a metadata question and confirm Claude uses MCP tools
- Ask a records question and confirm answers reflect live BC data

### BC config forwarding

- In server mode, verify chat works without browser-supplied BC credentials
- In server mode, verify selected company is honoured
- In custom mode, switch to a different BC environment and verify Claude queries that environment
- In custom mode, switch company and verify MCP results come from the new company

### Language

- With `lcid = 1039`, verify Claude responds in Icelandic
- With `lcid = 1030`, verify Claude responds in Danish
- With unsupported LCID, verify fallback to English

### Safety

- Verify `encrypt_data` and `decrypt_data` are not exposed if deny-listed
- Verify write operations require confirmation in the conversation before execution
- Verify secrets are not present in browser UI or Azure Function logs

### Failure modes

- Remove Claude API key and verify graceful error
- Break MCP endpoint and verify graceful tool-load failure
- Send invalid custom credentials and verify MCP tool errors are surfaced cleanly

---

## Acceptance Criteria

The requirement is complete when:
- A user can open a dedicated Claude chat page from the website
- The page uses the existing site connection context from `settings.js`
- `/api/claude-chat` can load MCP tools and execute them in a Claude tool loop
- BC access configuration from the website is forwarded to MCP correctly
- The selected company on the website is honoured for Claude-driven MCP tool calls
- The user receives a normal conversational answer plus visible tool activity
- The feature works in both server mode and custom mode
