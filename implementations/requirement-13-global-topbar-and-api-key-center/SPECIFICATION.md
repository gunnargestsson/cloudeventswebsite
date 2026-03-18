# Requirement 13: Global Top Bar Consistency + Central API Key Management

## Status: Implemented

---

## Overview

Standardize the top-bar experience across all website features so users always see the same core navigation and connection controls.

This requirement introduces:
- A shared top bar pattern across all feature pages
- A dedicated API key management page
- Removal of page-local API key entry UIs from pages that currently embed them

The goal is UI consistency, simpler navigation, and one single place for API key updates.

---

## User Requirement

When opening different features today, users see different top-bar controls:
- AI Sales Assistant shows API Key and Home
- BC Portal prominently shows Connected state
- Claude MCP Chat has its own API key input area

Required outcome:
- All feature pages expose the same three controls in top bar:
  - Home
  - Connected
  - API Key
- API key entry in AI Sales Assistant and Claude MCP Chat is removed
- A new dedicated page handles API key update/validation for supported assistants

---

## Goal

Create a consistent, reusable navigation/connection shell across the site while centralizing API key management in one place.

---

## Scope

### In Scope

1. Define and implement a shared top-bar contract used by all pages.
2. Add a dedicated API key settings page.
3. Remove API key input/edit UI from:
   - `sales-assistant.html`
   - `claude-mcp-chat.html`
4. Update navigation so all pages link to the dedicated API key page.
5. Keep existing BC connection configuration behavior (`settings.js`) unchanged unless explicitly required.

### Out of Scope

1. Functional changes to BC data operations.
2. Changes to Anthropic model/tool behavior.
3. Re-architecture of landing page cards.

---

## Affected Pages

Apply shared top-bar pattern to all current web pages:
- `index.html`
- `bc-portal.html`
- `bc-cloud-events-explorer.html`
- `bc-metadata-explorer.html`
- `bc-open-mirror.html`
- `sales-assistant.html`
- `claude-mcp-chat.html`

Add new page:
- `api-key-settings.html`

---

## UX Contract: Global Top Bar

Every page listed above must expose the same visible controls and order:

1. Home button
2. Connected button (status indicator)
3. API Key button

### Control Behavior

1. Home
- Navigates to `index.html`.

2. Connected
- Reflects BC connection status using existing `settings.js` state.
- States:
  - Connected: settings present/valid for current mode
  - Not Connected: missing required settings
- Clicking behavior:
  - Default route to `index.html` for connection management

3. API Key
- Opens dedicated API key page (`api-key-settings.html`)
- No inline API key forms in feature pages after this requirement

### Visual Rules

1. Same spacing, typography, and button style across all pages.
2. Same status wording and color semantics across all pages.
3. Same placement and order of controls across all pages.

---

## Dedicated API Key Page

### Purpose

Provide a single place to view/update assistant API keys used by web features.

### Minimum Features

1. API key form with masked input.
2. Save/update action.
3. Optional clear/remove key action.
4. Short key status text (e.g., Saved / Missing).
5. Link/button back to Home.
6. Reuse translation system (`UI_STRINGS` + `t(...)`) for all new user-facing strings.

### Storage Model (v1)

Use browser storage consistent with existing implementation patterns:
- Keep key storage in browser-side `localStorage` (cross-session persistence).
- Standardize on one shared key entry consumed by both:
  - AI Sales Assistant
  - Claude MCP Chat

Implementation should define one canonical storage key (for example `bc_portal_claude_api_key`) and migrate legacy keys if needed.

---

## Required Removals

### AI Sales Assistant

Remove page-local API key editing UI and interactions from `sales-assistant.html`:
- API key settings panel/button for key management
- Save key controls/messages tied to inline API key UI

The page must instead:
- Read API key from shared storage key
- If missing, show clear guidance and direct user to `api-key-settings.html`

### Claude MCP Chat

Remove page-local API key editing UI and interactions from `claude-mcp-chat.html`:
- Sidebar API key editor
- Save key button/indicator in page-local context

The page must instead:
- Read API key from shared storage key
- If missing, show clear guidance and direct user to `api-key-settings.html`

---

## Technical Design

### Shared Top-Bar Module

Create a reusable client-side module, e.g.:
- `topbar.js`

Responsibilities:
1. Render consistent top-bar controls.
2. Resolve current BC connection status using `settings.js`.
3. Provide shared click handlers/routes for Home and API Key.
4. Expose helper for page bootstrap:
   - `initGlobalTopbar({ currentPage, lcid })`

Alternative acceptable approach:
- Keep static HTML per page but enforce identical markup/classes/behavior via copy-safe template and test checklist.

### API Key Utilities

Create small shared helper module, e.g.:
- `api-key.js`

Responsibilities:
1. Get/set/clear API key from canonical storage key.
2. Optional legacy migration from existing keys used in older pages.
3. Return simple status for UI messages.

---

## Routing

Add route rewrite in `staticwebapp.config.json`:
- `/api-key-settings` -> `/api-key-settings.html`

Keep direct file route working as fallback.

---

## Translations

Per repo rule, every new English user-facing string added in HTML must:
1. Be added to `UI_STRINGS` in that page.
2. Be rendered through `t(...)`.
3. Receive Icelandic translation row in BC `Cloud Event Translation` table.

---

## Acceptance Criteria

1. All listed pages show Home, Connected, and API Key controls in the top bar.
2. Control order and styling are visually consistent across all pages.
3. Clicking API Key on any page opens dedicated API key page.
4. `sales-assistant.html` contains no page-local API key editor.
5. `claude-mcp-chat.html` contains no page-local API key editor.
6. Both assistants can still send requests successfully when key exists in shared storage.
7. If key is missing, both assistants show clear guidance to open API key page.
8. All new strings are translation-ready and Icelandic rows are created.

---

## Implementation Plan

1. Add new requirement page (`api-key-settings.html`) and route.
2. Add shared API key helper module and canonical storage key.
3. Add shared top-bar module or enforce common top-bar template across all pages.
4. Update all pages to use the new top-bar controls and routes.
5. Remove inline key management from AI Sales Assistant and Claude MCP Chat.
6. Add/update translations and verify all strings are in `UI_STRINGS`.
7. Run manual cross-page consistency check + functional smoke tests.

---

## Test Checklist

### Navigation and Consistency

1. Verify Home/Connected/API Key appears on each page in scope.
2. Verify visual consistency of top bar across desktop and mobile.
3. Verify Home button always returns to landing page.
4. Verify API Key button always opens dedicated API key page.

### Connection Status

1. With valid BC settings, Connected shows connected state on all pages.
2. With missing BC settings, Connected shows not-connected state on all pages.
3. Clicking Connected routes to connection management (landing page).

### API Key Behavior

1. Save key once on dedicated page.
2. Open AI Sales Assistant and send a message; verify no inline key form and request succeeds.
3. Open Claude MCP Chat and send a message; verify no inline key form and request succeeds.
4. Clear key on dedicated page; verify both assistants show missing-key guidance and do not send requests.

### Translation

1. Validate all new page strings are listed in `UI_STRINGS`.
2. Validate all new strings render via `t(...)`.
3. Validate Icelandic translations are created and visible when LCID=1039.

---

## Final Decisions

1. Dedicated API key page scope for v1:
- Claude key only.

2. API key storage:
- `localStorage` (cross-session).

3. Landing page consistency:
- `index.html` must also expose the same top-bar controls (`Home`, `Connected`, `API Key`).

---

## Dependencies

- Requirement 7 (`settings.js`) for connection status and shared BC settings
- Requirement 6 (AI Sales Assistant) for key-consumption migration
- Requirement 12 (Claude MCP Chat) for key-consumption migration
