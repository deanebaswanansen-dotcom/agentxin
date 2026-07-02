# Dump raw DeepSeek usage fields — two identical-prefix calls
$ErrorActionPreference = 'Stop'
$cfg = Invoke-RestMethod 'http://localhost:3000/api/model-config' -Method GET
# Key only via internal test endpoint — use store-backed proxy instead
$body1 = @{
  model = $cfg.modelName
  messages = @(
    @{ role = 'system'; content = ('STATIC_PREFIX_' * 200) + 'You are a novelist.' }
    @{ role = 'user'; content = 'Say hello in 5 Chinese characters.' }
  )
  stream = $true
  max_tokens = 32
} | ConvertTo-Json -Depth 6

# Read key from backend store (local only)
$store = Get-Content (Join-Path $PSScriptRoot '..\backend\data\store.json') -Raw | ConvertFrom-Json
$key = $store.modelConfig.apiKey
$url = ($cfg.baseUrl.TrimEnd('/')) + '/chat/completions'

function Invoke-StreamUsage($label, $userMsg) {
  $payload = @{
    model = $cfg.modelName
    messages = @(
      @{ role = 'system'; content = ('STATIC_PREFIX_' * 200) + 'You are a novelist. Keep style consistent.' }
      @{ role = 'user'; content = $userMsg }
    )
    stream = $true
    max_tokens = 64
  }
  $json = $payload | ConvertTo-Json -Depth 6
  $resp = Invoke-WebRequest -Uri $url -Method POST -Headers @{
    Authorization = "Bearer $key"
    'Content-Type' = 'application/json'
    Accept = 'text/event-stream'
  } -Body $json -TimeoutSec 120
  $usageLines = @()
  foreach ($line in ($resp.Content -split "`n")) {
    if ($line -match '^data:\s*(.+)$') {
      $data = $Matches[1].Trim()
      if ($data -eq '[DONE]') { continue }
      try {
        $obj = $data | ConvertFrom-Json
        if ($obj.usage) {
          $usageLines += $obj.usage | ConvertTo-Json -Compress
        }
      } catch {}
    }
  }
  Write-Host "`n=== $label ==="
  if ($usageLines.Count -eq 0) { Write-Host 'NO usage chunk in stream' }
  else { $usageLines | ForEach-Object { Write-Host $_ } }
}

Invoke-StreamUsage 'CALL_1_first' 'Say hello in 5 Chinese characters.'
Start-Sleep -Seconds 2
Invoke-StreamUsage 'CALL_2_same_prefix' 'Say goodbye in 5 Chinese characters.'