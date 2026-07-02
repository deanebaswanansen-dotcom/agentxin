# Real API smoke test — short prompts, logs results to reports/
$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3000/api'
$reportDir = Join-Path $PSScriptRoot '..\reports\real-api'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$log = @()

function Log($name, $ok, $detail) {
  $script:log += [pscustomobject]@{ step = $name; ok = $ok; detail = $detail }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host "[$mark] $name — $detail"
}

try {
  $cfg = Invoke-RestMethod -Uri "$base/model-config" -Method GET
  if ($cfg.baseUrl -eq 'mock') { throw 'Backend still on mock — save DeepSeek config first' }
  Log 'model-config' $true "$($cfg.modelName) @ $($cfg.baseUrl)"

  $proj = Invoke-RestMethod -Uri "$base/projects" -Method POST -Body (@{ name = 'API实测-' + (Get-Date -Format 'HHmmss') } | ConvertTo-Json) -ContentType 'application/json; charset=utf-8'
  $projectId = $proj.id
  Log 'create-project' $true $projectId

  $body = @{ task = 'outline'; mode = 'reference'; prompt = '短篇：便利店夜班见鬼，三章内完结'; projectId = $projectId } | ConvertTo-Json
  $t0 = Get-Date
  $outline = Invoke-RestMethod -Uri "$base/agent/run" -Method POST -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 300
  $sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $mockHint = ($outline.summary + ($outline.steps -join '')) -match 'MOCK'
  Log 'agent-outline' (!$mockHint) "task=$($outline.task) steps=$($outline.steps.Count) ${sec}s summary=$($outline.summary.Substring(0, [Math]::Min(40, $outline.summary.Length)))..."

  $body2 = @{ task = 'diagnostic'; mode = 'reference'; prompt = '能否继续写第二章？'; projectId = $projectId } | ConvertTo-Json
  $diag = Invoke-RestMethod -Uri "$base/agent/run" -Method POST -Body $body2 -ContentType 'application/json; charset=utf-8' -TimeoutSec 300
  Log 'agent-diagnostic' ($diag.task -eq 'diagnostic') "artifacts=$($diag.artifacts.Count)"

  $ch = Invoke-RestMethod -Uri "$base/projects/$projectId/chapters" -Method POST -Body (@{ title = '第1章' } | ConvertTo-Json) -ContentType 'application/json; charset=utf-8'
  $cid = $ch.id
  Log 'create-chapter' $true $cid

  $writeBody = @{ operation = 'continue'; instruction = '续写两句，不要解释'; selectedText = '' } | ConvertTo-Json
  # Writing uses SSE — use curl or fetch; here test via inject-like minimal: update content manually first
  Invoke-RestMethod -Uri "$base/chapters/$cid/content" -Method PATCH -Body (@{ content = '夜班店员抬头，货架尽头站着穿寿衣的老人。' } | ConvertTo-Json) -ContentType 'application/json; charset=utf-8' | Out-Null
  Log 'chapter-save' $true 'PATCH content ok'

  $body3 = @{ task = 'polish'; mode = 'reference'; prompt = '更悬疑，少形容词'; projectId = $projectId; chapterId = $cid } | ConvertTo-Json
  $polish = Invoke-RestMethod -Uri "$base/agent/run" -Method POST -Body $body3 -ContentType 'application/json; charset=utf-8' -TimeoutSec 180
  Log 'agent-polish' ($polish.task -eq 'polish') "summary len=$($polish.summary.Length)"

  $worlds = Invoke-RestMethod -Uri "$base/projects/$projectId/worldSettings" -Method GET
  $chars = Invoke-RestMethod -Uri "$base/projects/$projectId/characters" -Method GET
  $outs = Invoke-RestMethod -Uri "$base/projects/$projectId/outlines" -Method GET
  Log 'refresh-read' ($worlds.Count -ge 1 -and $chars.Count -ge 1 -and $outs.Count -ge 1) "world=$($worlds.Count) char=$($chars.Count) outline=$($outs.Count)"

} catch {
  Log 'fatal' $false $_.Exception.Message
}

$outPath = Join-Path $reportDir ("smoke_{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$log | ConvertTo-Json -Depth 4 | Set-Content -Path $outPath -Encoding utf8
Write-Host "Report: $outPath"