# Requirement 21: IOBWS Proxy Tester Page

## Overview

A dedicated website page — `iobws-proxy-tester.html` — for interactively testing the
five IOBWS proxy Azure Functions introduced in Requirements 16–20. Users can select a
target bank, choose a predefined operation template or write a custom SOAP body, supply
credentials and the API key, submit the request, and inspect the raw SOAP response or
error side-by-side.

**Implement after Requirements 15–20** (the page calls real proxy endpoints).

---

## Status

**Status:** ✅ Implemented
**Priority:** 🟡 Medium
**Dependencies:** Requirements 15–20 (IOBWS proxy functions must be deployed)

---

## Goal

Give developers and testers a browser-based tool to verify each bank proxy without
writing curl scripts or importing Postman collections. The page should make it trivial
to:

- Confirm a bank proxy is reachable and the API key is accepted.
- Verify WS-Security signing works end-to-end against bank test environments.
- Spot-check a SOAP operation by selecting a template and filling in real values.
- Diagnose SOAP faults returned by the bank without leaving the browser.

---

## Design Decisions

| # | Question | Answer |
|---|---|---|
| D1 | Page file name | `iobws-proxy-tester.html` |
| D2 | Target endpoints | `/api/landsbankinn`, `/api/arionbanki`, `/api/islandsbanki`, `/api/sparisjodur`, `/api/kvika` |
| D3 | API key source | Text input pre-populated from `settings.js` `getApiKey()` if available; user can override |
| D4 | Request origin | Direct browser `fetch` to the same-origin Azure Function — no extra backend needed |
| D5 | Response display | Raw text (XML) rendered in a syntax-highlighted, scrollable `<pre>` block |
| D6 | SOAP fault handling | HTTP 200 with `<s:Fault>` body is shown verbatim; page highlights the `<faultstring>` |
| D7 | Error display | HTTP 4xx / 5xx JSON errors shown as a formatted error card |
| D8 | UI language | Follows existing site conventions; translatable via `t()` / `UI_STRINGS` / `loadUiTranslations()` |
| D9 | Settings header | Reuse `settings.js`; show/hide topbar depending on `bcSettingsReady()` |
| D10 | BC settings dependency | **Not required.** This page tests bank proxies, not BC. It must work even when BC settings are absent |
| D11 | Request history | Browser-session memory only (no persistence); last 10 requests shown in a collapsible history panel |
| D12 | Operation templates | Each bank ships a set of minimal pre-filled templates (see §Templates) |

---

## Page Layout

```
┌─────────────────────────────────────────────────────────────┐
│  HEADER  (logo + nav — same as other portal pages)          │
├────────────────┬────────────────────────────────────────────┤
│  LEFT PANEL    │  RIGHT PANEL                               │
│  ─ Bank select │  ─ Response viewer (raw XML / error card)  │
│  ─ Environment │                                            │
│  ─ API key     │  ─ SOAP fault highlight if present         │
│  ─ Service URL │                                            │
│  ─ SOAP action │  ─ Request history (collapsible)           │
│  ─ Username    │                                            │
│  ─ Password    │                                            │
│  ─ Body editor │                                            │
│  ─ [Send]      │                                            │
└────────────────┴────────────────────────────────────────────┘
```

The two-column layout collapses to a single column on narrow viewports.

---

## Left Panel — Request Builder

### Bank selector

A radio-button group or segmented control with one option per supported bank:

| Label | Endpoint slug | Req |
|---|---|---|
| Landsbankinn | `landsbankinn` | 16 |
| Arionbanki | `arionbanki` | 17 |
| Íslandsbanki | `islandsbanki` | 18 |
| Sparisjóðir | `sparisjodur` | 19 |
| Kvika banki | `kvika` | 20 |

Selecting a bank:
1. Updates the **Service URL** and **SOAP action** fields to match the bank's default
   template for the currently selected operation.
2. Updates the **Body** textarea with the matching template XML.
3. Updates the form's endpoint path (shown as read-only hint below the bank selector).

### Environment selector

A dropdown for the IOBWS environment to use. Selecting an environment replaces the
host portion of the service URL automatically.

| Label | Host |
|---|---|
| Production | `ws.b2b.is` |
| Test | `ws-test.b2b.is` |
| Integration | `ws-int.b2b.is` |
| Development | `ws-dev.b2b.is` |

When the **Landsbankinn** bank is selected a second row appears for the proprietary
schema environment:

| Label | Host |
|---|---|
| Landsbankinn Production | `netbanki.landsbankinn.is` |

When **Íslandsbanki** is selected:

| Label | Host |
|---|---|
| Íslandsbanki Production | `netbanki.islandsbanki.is` |

When **Sparisjóðir** is selected the dropdown shows a list of supported savings banks
(each has its own `heimabanki.is` subdomain); the host in the URL is updated
accordingly.

### Operation template picker

A `<select>` populated per bank with the list of representative operations. Selecting
one pre-fills **Service URL**, **SOAP action**, and **Body** with a minimal working
template (see §Templates).

The last option in every bank's list is always **Custom** — choosing it clears the
body and lets the user type freely without further auto-filling.

### Request fields

| Field | Type | Pre-fill |
|---|---|---|
| API key | `<input type="password">` | `getApiKey()` from `settings.js` if available |
| Service URL | `<input type="text">` | From selected template |
| SOAP action | `<input type="text">` | From selected template |
| Username | `<input type="text">` | Empty; user fills in |
| Password | `<input type="password">` | Empty; user fills in |
| Body | `<textarea>` (6+ rows) | From selected template; editable |

All fields have a "Copy" icon button on the right edge.

### Send button

Clicking **Send** assembles the JSON payload and POSTs to
`/api/{bankSlug}?key={apiKey}`. The API key is sent in the query-string (matching the
proxy function contract from Req 15).

While the request is in flight the button is disabled and shows a spinner. Response
time is displayed next to the button after each call.

---

## Right Panel — Response Viewer

### Success (HTTP 200)

- The raw XML is displayed in a monospace `<pre>` block with a horizontal scrollbar.
- If `<s:Fault>` is detected anywhere in the body, a amber warning card is shown above
  the raw XML with the extracted `<faultstring>` content.
- A **Copy** and a **Download as .xml** button appear above the `<pre>` block.
- Response size (bytes) and status code are shown in a small status bar.

### Function-level errors (HTTP 4xx / 5xx)

- A red error card shows the HTTP status, status text, and the parsed `error` field
  from the JSON body.
- The raw JSON body is still shown in the `<pre>` block beneath the card.

### Empty state

A centered placeholder with an icon and the text:
> "Select a bank, fill in the request fields, and click Send."

---

## Request History Panel

A collapsible section at the bottom of the right panel labelled **Request History**.

Each history entry shows:
- Timestamp (HH:MM:SS)
- Bank slug
- Operation template name (or "Custom")
- HTTP status code / response time
- A **Replay** button that re-populates the left panel with that entry's exact inputs

Up to 10 entries are retained per browser session. Oldest entries are discarded when
the limit is reached.

---

## Operation Templates

Each template contains pre-filled values for `serviceUrl`, `soapAction`, and `body`.
The body uses `<!-- REPLACE -->` comment placeholders where the user must supply real
values before sending.

### Landsbankinn

| Template name | Sambankaskema | Operation |
|---|---|---|
| GetAccountStatement | 2013 | `GetAccountStatement` on `AccountService.svc` |
| QueryClaims | 2013 | `QueryClaims` on `ClaimService.svc` |
| GetCurrencyRates | 2013 | `GetCurrencyRates` on `CurrencyRatesService.svc` |
| LI_Claim_get | Landsbankaskema | `LI_Claim_get` on `netbanki.landsbankinn.is` |
| LI_Fyrirspurn_reikningsyfirlit | Landsbankaskema | Account statement query |

### Arionbanki

| Template name | Schema | Operation |
|---|---|---|
| GetAccountStatement | 20131015 | `GetAccountStatement` on `AccountService.svc` |
| QueryClaims | 20131015 | `QueryClaims` on `ClaimService.svc` |
| GetCurrencyRates | 20131015 | `GetCurrencyRates` on `CurrencyRatesService.svc` |
| GetBillStatement | 20130201 | `GetBillStatement` on `BillService.svc` |

### Íslandsbanki

| Template name | Schema | Operation |
|---|---|---|
| GetAccountStatement | 20131015 | `GetAccountStatement` on `AccountService.svc` |
| QueryClaims | 20131015 | `QueryClaims` on `ClaimService.svc` |
| GetCurrencyRates | 20131015 | `GetCurrencyRates` on `CurrencyRatesService.svc` |
| Account balance (proprietary) | Íslandsbankaskema | Proprietary balance query |

### Sparisjóðir

| Template name | Schema | Operation |
|---|---|---|
| GetAccountStatement | IOBS | `GetAccountStatement` on savings bank host |
| QueryClaims | IOBS | `QueryClaims` on savings bank host |

### Kvika banki

| Template name | Schema | Operation |
|---|---|---|
| GetAccountStatement | 20131015 | `GetAccountStatement` on `AccountService.svc` |
| QueryClaims | 20131015 | `QueryClaims` on `ClaimService.svc` |
| GetCurrencyRates | 20131015 | `GetCurrencyRates` on `CurrencyRatesService.svc` |

All template bodies are minimal well-formed SOAP body fragments — the opening element
only, with the required child elements as empty stubs or `<!-- REPLACE -->` notes.
The proxy wraps them in the full SOAP envelope and WS-Security header.

---

## UI Strings (Translatable)

All user-facing strings must be registered in `UI_STRINGS` and wrapped in `t()`.
Icelandic translations must be written to BC via `set_translations` (source `BC Portal`,
lcid `1039`).

| English string | Icelandic |
|---|---|
| IOBWS Proxy Tester | IOBWS Proxy Prófun |
| Select bank | Veldu banka |
| Environment | Umhverfi |
| Operation | Aðgerð |
| API Key | API-lykill |
| Service URL | Þjónustu-slóð |
| SOAP Action | SOAP-aðgerð |
| Username | Notandanafn |
| Password | Lykilorð |
| SOAP Body | SOAP-meginmál |
| Send | Senda |
| Sending… | Sendi… |
| Copy | Afrita |
| Download as XML | Sækja sem XML |
| Response | Svar |
| SOAP Fault detected | SOAP-villa greind |
| Request History | Sögu beiðna |
| Replay | Endursenda |
| ms | ms |
| Select a bank, fill in the request fields, and click Send. | Veldu banka, fylltu inn reitina og smelltu á Senda. |
| Custom | Sérsniðið |
| Production | Framleiðsla |
| Test | Próf |
| Integration | Samþætting |
| Development | Þróun |
| Landsbankinn Production | Landsbankinn Framleiðsla |
| Íslandsbanki Production | Íslandsbanki Framleiðsla |

---

## Visual Design

Follow the existing site conventions exactly:

- **Fonts**: `Syne` (headings / logo) + `DM Mono` (body / code)
- **Colours**: Use the same CSS custom properties as all other portal pages
  (`--bg`, `--surface`, `--surface2`, `--border`, `--accent`, `--green`, `--red`, `--amber`, etc.)
- **Grid background**: Fixed grid pattern via `body::before` pseudo-element
- **Header**: Sticky, blurred, same logo and nav as other pages
- **Cards / panels**: `var(--surface)` background, `var(--border)` border, `var(--radius)` corners
- **Body textarea / pre blocks**: `var(--surface2)` background, `var(--accent)` caret, `DM Mono` font
- **Buttons**: Same gradient-accent primary style as other pages; destructive/secondary actions use outline style

---

## Security Considerations

- The API key is sent as a query-string parameter only (matching the existing proxy
  contract). It must never be logged or written to `localStorage`.
- `username` and `password` fields use `type="password"` to prevent accidental
  shoulder-surfing; these are bank system credentials, not the portal's own credentials.
- The body `<textarea>` accepts free-form XML. No server-side reflection or evaluation
  of the body content occurs in the page itself.
- Service URL is free-form on the page but is subject to the SSRF allowlist enforced
  by each proxy function.

---

## Navigation Integration

Add a link to `iobws-proxy-tester.html` in `index.html` under a new **Banking** or
**IOBWS** section alongside the other tool cards. Add the page to
`staticwebapp.config.json` if route rewrites are needed (follow the pattern of other
pages in that file).

---

## File to Create

| File | Purpose |
|---|---|
| `iobws-proxy-tester.html` | Complete standalone page (HTML + embedded CSS + embedded JS) |

No additional Azure Function or backend changes are required.
