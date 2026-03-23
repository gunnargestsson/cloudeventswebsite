---
name: bc-cloud-events
description: >
  Domain knowledge for building integration code that calls the Origo Cloud Events
  API on Microsoft Business Central. Use when a developer asks to: connect to BC via
  Cloud Events, call any Data / Help / Customer / Item / Sales message type, implement
  sync or async task submission, handle pagination, read/write record data, handle
  field name normalization, or convert enum values. Also covers: dynamic schema
  discovery via the BC Metadata MCP server at https://dynamics.is/api/mcp (tools:
  list_tables, get_table_fields, get_table_info, list_companies, list_message_types,
  get_records, get_record_count, get_decimal_total, search_customers, search_items, list_translations, set_translations,
  get_integration_timestamp, set_integration_timestamp, reverse_integration_timestamp,
  set_config, get_config, encrypt_data, decrypt_data;
  resources: bc://tables, bc://tables/{name}, bc://message-types, bc://companies;
  prompts: customer_lookup_pattern, item_lookup_pattern, sales_order_creation_workflow,
  describe_table, find_tables_for_entity, data_model_overview), selecting only needed
  fields with fieldNumbers, tableView filtering and sorting in BC AL syntax (WHERE/
  FILTER/CONST/SORTING/ORDER with skip+take for sorted paging), UI translations via the
  Cloud Event Translation table, integration timestamps via the Cloud Events Integration
  table, field metadata caching, webhooks, special field conversions (BLOB, Media, Dimension Set,
  Currency Code), CSV bulk export via CSV.Records.Get (Open Mirroring format, no pagination,
  column naming convention {name}-{no}, system fields always appended, $Company column),
  and creating sales orders via the generic Data.Records.Set workflow.
---

# BC Cloud Events Skill — Remote Loader

> **This skill is maintained remotely and is updated independently of this repository.**
> Always fetch the latest version before using it.

## REQUIRED: Load Latest Skill Content

**Before answering any request that uses this skill, use the `fetch_webpage` tool to
download the current skill content from the canonical URL below, then use the
downloaded content as your authoritative reference for all BC Cloud Events API patterns,
message types, field naming, and integration rules:**

```
https://origopublic.blob.core.windows.net/help/Cloud%20Events/bc27/en-US/SKILL.md
```

The fetched content supersedes anything in this local file.
