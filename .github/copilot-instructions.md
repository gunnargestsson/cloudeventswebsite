# GitHub Copilot Instructions — BC Portal

## Translation rule

**Every English user-facing string added to any `.html` file in this repo must have a
corresponding Icelandic translation in the Business Central `Cloud Event Translation` table.**

### How the translation system works

All translatable strings are registered in a `UI_STRINGS` array near the top of each page's
`<script>` block. At runtime, `loadUiTranslations()` fetches the matching rows from the
`Cloud Event Translation` table (primary key: `Source`, `WindowsLanguageID`, `SourceText`)
and stores them in `uiTranslations`. The `t('...')` helper function then returns the
translated string or falls back to English.

### When you add a new string

1. **Add it to `UI_STRINGS`** in the relevant HTML file.
2. **Wrap every use in `t('...')`** so the translation is applied at runtime.
3. **Create the Icelandic translation record in BC** using the MCP `set_translations` tool:

```json
{
  "source": "BC Portal",
  "lcid": 1039,
  "translations": [
    { "sourceText": "<your English string>", "targetText": "<Icelandic translation>" }
  ]
}
```

Call the MCP endpoint at `https://dynamics.is/api/mcp`:

```jsonc
// POST https://dynamics.is/api/mcp
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "set_translations",
    "arguments": {
      "source": "BC Portal",
      "lcid": 1039,
      "translations": [
        { "sourceText": "My new string", "targetText": "Íslenska þýðing" }
      ]
    }
  }
}
```

Or via PowerShell:

```powershell
$body = @{
  jsonrpc = "2.0"; id = 1; method = "tools/call"
  params  = @{
    name      = "set_translations"
    arguments = @{
      source       = "BC Portal"
      lcid         = 1039
      translations = @(
        @{ sourceText = "My new string"; targetText = "Íslenska þýðing" }
      )
    }
  }
} | ConvertTo-Json -Depth 10 -Compress

Invoke-WebRequest -Uri "https://dynamics.is/api/mcp" -Method POST `
  -ContentType "application/json" -Body $body -UseBasicParsing
```

### Check for missing translations

Use the `list_translations` MCP tool to find any strings that still need translating:

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_translations","arguments":{"source":"BC Portal","lcid":1039,"missingOnly":true}}}'
Invoke-WebRequest -Uri "https://dynamics.is/api/mcp" -Method POST -ContentType "application/json" -Body $body -UseBasicParsing | Select-Object -ExpandProperty Content
```

### LCID reference

| Language | LCID |
|---|---|
| English (default, no translation needed) | 1033 |
| Icelandic | 1039 |
| Danish | 1030 |
| Norwegian | 1044 |

### What NOT to translate

- Technical codes like `"BC Portal"` (the `source` identifier itself)
- Format placeholders: `{0}`, `{no}`, `{name}` — preserve these exactly in `targetText`
- CSS class names, HTML attributes, API field names
- Strings that are already BC-native captions (field labels from `get_table_fields` are
  returned pre-translated for the active `lcid`)
