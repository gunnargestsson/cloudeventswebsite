# Requirement 10: Trim SKILL.md after MCP Resources and Prompts are live

## Overview

**Prerequisite:** Requirement 8 §9 (MCP Resources) and §10 (MCP Prompts) must be fully
implemented and deployed before this requirement is started. Once the MCP server exposes live,
instance-accurate table and field data via Resources and Prompts, several sections of the
`SKILL.md` developer skill become redundant static snapshots.

This requirement removes or replaces those redundant sections, shrinking the skill document and
directing both human developers and AI coding assistants to the authoritative live source instead.

The file to edit is `.github/skills/bc-cloud-events/SKILL.md`.

---

## Why this matters

`SKILL.md` is loaded as context into AI coding assistant sessions. Every line costs context
window. Sections that are now superseded by live MCP data:

1. **Increase prompt cost** — they occupy precious context that could be spent on actual code
2. **Drift from reality** — static snapshots become stale as BC versions change field numbers
   or add tables; the MCP server always reflects the instance being targeted

---

## What must NOT change

The following sections contain **protocol knowledge** — how to build a Cloud Events HTTP
request, error handling, field naming rules, enum handling, pagination math, and code patterns.
This knowledge is essential for an AI to *write* integration code. It is not runtime data and
cannot be served by the MCP server. **Leave these sections entirely unchanged:**

| Sections | Content |
|---|---|
| §1–§6 | API overview, base URL, 3 endpoints, request envelope, field name normalisation rules |
| §7 | All message type names, parameters, and response shapes |
| §8–§11 | Pagination, special field conversions (Currency, DimensionSetID, BLOB, Media, MediaSet), enum handling, tableView filter syntax |
| §13 | Webhook patterns |
| §15–§16 | JS/TS helper patterns, common mistakes |
| §18 (patterns) | Binary field read/write patterns |

---

## Changes to make

### Change 1 — Replace §17.1 static table list with MCP pointer

**Section:** §17 > §17.1 (Dynamic Schema Discovery — Tables)

**Current content:** `bc-metadata-all-tables-is.md` reference + a bullet list of commonly used
table numbers hard-coded in the skill + a "Key tables for common integration work" markdown table.

**Action:** Remove the hard-coded table number bullet list and the "Key tables" table entirely.
Replace the `bc-metadata-all-tables-is.md` reference paragraph with a short note pointing at the
MCP server.

**Replacement text:**
```markdown
### 17.1 Listing all tables

Use the MCP server tool `list_tables` or read the `bc://tables` resource for a live,
instance-accurate table catalogue. Both return `{ id, name, caption }` for every table in
the targeted BC company.

To narrow the result:
- Pass `filter` (substring match on name/caption) to reduce response size.
- Pass `take` / `skip` for paging (default: first 200 tables).

> The static snapshot file `bc-metadata-all-tables-is.md` previously referenced here is
> superseded by the MCP server and should not be consulted for field numbers or table IDs.
```

---

### Change 2 — Replace §17.2 static field reference with MCP pointer

**Section:** §17 > §17.2 (Fields for a specific table)

**Current content:** Instructions to consult the static snapshot for field numbers plus example
hard-coded field constant arrays such as `CUSTOMER_LIST_FIELDS = [1, 2, 5, 8, 23, 35]`.

**Action:** Remove the hard-coded constant arrays. Replace with a note to use `get_table_fields`
or the `bc://tables/{name}` resource, which returns `jsonName` (the exact JSON key to use in
requests), `type`, and `number` for every field.

**Replacement text:**
```markdown
### 17.2 Fields for a specific table

Use the MCP tool `get_table_fields` (or resource `bc://tables/{tableName}`) to retrieve all
fields for a table. Each field entry includes:

| Property | Description |
|---|---|
| `number` | BC field number (use in `fieldNumbers` arrays) |
| `name` | AL field name |
| `jsonName` | The JSON key used in Cloud Events `fields` payloads |
| `type` | BC data type |
| `isPartOfPrimaryKey` | Boolean |
| `enum` | Present for Option/Enum fields; lists all captions and values |

To get field numbers for the most commonly needed fields, call:
`get_table_fields({ table: "Customer" })` (or "Item", "Sales Header", etc.)

There is no need to hard-code field number constants — the MCP server provides live,
version-accurate values for the specific BC instance being integrated.
```

---

### Change 3 — Replace §17.4 static message type list with MCP pointer

**Section:** §17 > §17.4 (Available message types)

**Current content:** Instructions to call `Help.MessageTypes.Get` directly plus an example
response shape and a note about what types the CRONUS demo company exposes.

**Action:** Keep the explanation that `Help.MessageTypes.Get` is the underlying mechanism.
Remove any hard-coded type name lists or CRONUS-specific examples. Add a pointer to the MCP
`list_message_types` tool and `bc://message-types` resource.

**Replacement text for the pointer paragraph:**
```markdown
Use the MCP tool `list_message_types` (or resource `bc://message-types`) to retrieve the
full message catalogue for the targeted BC instance. Pass an optional `filter` string for
substring matching. The underlying Cloud Events call is `Help.MessageTypes.Get`.
```

---

### Change 4 — Replace §11a lookup patterns with MCP Prompt pointer

**Section:** §11a (Customer/item lookup code patterns)

**Current content:** Static code examples showing how to build a `Data.Records.Get` request
for Customer and Item tables, including hard-coded field number arrays.

**Action:** Shorten to a brief description + MCP Prompt pointer. Keep the sentence explaining
the pattern conceptually (filter syntax, field selection) but replace the code blocks with a
direct pointer to the live MCP prompts.

**Replacement text:**
```markdown
### 11a. Customer and item lookup patterns

To look up a customer by number or name, send `Data.Records.Get` with `tableName: "Customer"`
and a `tableView` filter. To look up an item, use `tableName: "Item"`.

For a ready-to-use, instance-accurate guide with live field names for *this* BC instance,
invoke the MCP prompts:

- `customer_lookup_pattern` — returns filter examples and the full Customer field table
- `item_lookup_pattern` — returns filter examples and the full Item field table

Both prompts fetch live field metadata and substitute it into the guide, so the field
numbers and `jsonName` values are guaranteed accurate for the connected BC instance.
```

---

### Change 5 — Replace §12 sales order workflow with MCP Prompt pointer

**Section:** §12 (Sales order creation workflow)

**Current content:** Full 3-step workflow description with static code blocks using placeholder
field names derived from the CRONUS demo company.

**Action:** Keep the high-level 3-step description (it is protocol knowledge — it explains
*why* three calls are needed and what each step does conceptually). Replace the static code
blocks with a pointer to the MCP Prompt.

**Replacement text for the code-block section:**
```markdown
For a ready-to-use workflow description pre-populated with the live `jsonName` values and
field table for *this* BC instance, invoke the MCP prompt `sales_order_creation_workflow`.
It calls `get_table_fields` for both `Sales Header` and `Sales Line` and injects the results
into a step-by-step guide.
```

---

### Change 6 — Update the §17 section intro to mention MCP

**Section:** §17 intro paragraph

Add a sentence at the top of §17 noting that the preferred discovery mechanism is the MCP
server, and that direct `Help.*` calls remain valid for production integrations that want
to avoid the MCP dependency.

**Replacement intro:**
```markdown
## 17. Dynamic Schema Discovery

The preferred discovery path is the **MCP server** (see Requirement 8), which wraps these
calls and exposes results as Tools and Resources. The raw `Help.*` Cloud Events calls
documented here remain valid for production integrations where MCP is not available.
```

---

## Verification checklist

After making all changes, verify:

- [ ] §17.1 no longer contains any hard-coded table number lists
- [ ] §17.2 no longer contains `CUSTOMER_LIST_FIELDS`, `ITEM_LIST_FIELDS`, or similar constants
- [ ] §17.4 no longer contains CRONUS-specific message type lists
- [ ] §11a now points to `customer_lookup_pattern` / `item_lookup_pattern` prompts
- [ ] §12 static code blocks replaced with pointer to `sales_order_creation_workflow` prompt
- [ ] All protocol knowledge (§1–§11, §13, §15–§16) is untouched
- [ ] SKILL.md still loads cleanly as a GitHub Copilot skill (no broken front-matter)
- [ ] The MCP server is reachable and both `customer_lookup_pattern` and `sales_order_creation_workflow` return non-empty responses before trimming

---

## File locations

| File | Action |
|---|---|
| `.github/skills/bc-cloud-events/SKILL.md` | Edit: changes 1–6 above |
| `bc-metadata-all-tables-is.md` (if present) | No change required — it is superseded but keeping it causes no harm |

---

## Implementation order

1. Confirm Requirement 8 §9 and §10 are deployed and working (test `prompts/get` for `customer_lookup_pattern`)
2. Apply Change 6 (§17 intro) — lowest risk, purely additive
3. Apply Changes 1–3 (§17 subsections) — remove static snapshots
4. Apply Changes 4–5 (§11a and §12) — replace code blocks with MCP Prompt pointers
5. Run verification checklist
