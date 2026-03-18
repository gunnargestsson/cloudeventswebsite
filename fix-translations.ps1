# Fix remaining corrupted/missing Icelandic translations
# Run with: powershell -File fix-translations.ps1

$translations = @(
    @{ sourceText = "Claude could not complete one of the Business Central tool calls."; targetText = "Claude gat ekki lokið einu af Business Central verkfæraköllunum." },
    @{ sourceText = "Client ID"; targetText = "Klientauðkenni" },
    @{ sourceText = "Configured Tables"; targetText = "Stilltar töflur" },
    @{ sourceText = "Mirror Not Verified"; targetText = "Spegill ekki staðfestur" },
    @{ sourceText = "Mirror run completed"; targetText = "Speglun lokið" },
    @{ sourceText = "Mirror Verified"; targetText = "Spegill staðfestur" },
    @{ sourceText = "Server mode"; targetText = "Þjónshamur" },
    @{ sourceText = "This customer has no invoiced items in the selected period."; targetText = "Þessi viðskiptamaður á engar reikningsfærðar vörur á völdu tímabili." },
    @{ sourceText = "Tenant"; targetText = "Leigjandi" }
)

$payload = @{
    jsonrpc = "2.0"
    id      = 1
    method  = "tools/call"
    params  = @{
        name      = "set_translations"
        arguments = @{
            source       = "BC Portal"
            lcid         = 1039
            translations = $translations
        }
    }
}

$bodyJson  = $payload | ConvertTo-Json -Depth 10 -Compress
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

$response = Invoke-WebRequest `
    -Uri         "https://dynamics.is/api/mcp" `
    -Method      POST `
    -ContentType "application/json; charset=utf-8" `
    -Body        $bodyBytes `
    -UseBasicParsing

Write-Host $response.Content
