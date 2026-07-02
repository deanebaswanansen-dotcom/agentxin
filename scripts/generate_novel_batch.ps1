# Generate ~2万字小说 + collect cache stats from backend logs
param(
  [int]$Chapters = 6,
  [int]$WordsPerChapter = 3200,
  [string]$Seed = '都市灵异：便利店夜班，主角小陈值夜，规则怪谈，三章内要有完整弧线'
)

$ErrorActionPreference = 'Continue'
$base = 'http://localhost:3000/api'
$reportDir = Join-Path $PSScriptRoot '..\reports\novel-run'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = @()
$cacheHits = @()
$projectId = ''

function Log($step, $ok, $detail) {
  $script:log += [pscustomobject]@{ step = $step; ok = $ok; detail = $detail; at = (Get-Date).ToString('o') }
  Write-Host "[$([datetime]::Now.ToString('HH:mm:ss'))] $step — $detail"
}

# Snapshot backend terminal before run (PID 50156 or find port 3000)
$termFiles = Get-ChildItem "$env:USERPROFILE\terminals\*.txt" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
$backendTerm = $termFiles | Where-Object { (Get-Content $_.FullName -TotalCount 15 -ErrorAction SilentlyContinue) -match '3000|backend' } | Select-Object -First 1

try {
  $cfg = Invoke-RestMethod -Uri "$base/model-config" -Method GET
  if ($cfg.baseUrl -eq 'mock') { throw 'Still on mock — switch to DeepSeek in settings' }
  Log 'config' $true "$($cfg.modelName)"

  $proj = Invoke-RestMethod -Uri "$base/projects" -Method POST -Body (@{ name = "长篇缓存实测-$runId" } | ConvertTo-Json) -ContentType 'application/json; charset=utf-8'
  $projectId = $proj.id
  Log 'project' $true $projectId

  $outlineBody = @{
    task = 'outline'
    mode = 'reference'
    prompt = $Seed
    projectId = $projectId
  } | ConvertTo-Json
  $t0 = Get-Date
  $null = Invoke-RestMethod -Uri "$base/agent/run" -Method POST -Body $outlineBody -ContentType 'application/json; charset=utf-8' -TimeoutSec 600
  Log 'outline' $true ("{0:N0}s" -f ((Get-Date) - $t0).TotalSeconds)

  $totalChars = 0
  for ($i = 1; $i -le $Chapters; $i++) {
    $hint = if ($i -eq 1) { '第一章开局，建立规则与恐惧' } elseif ($i -eq $Chapters) { '终章收束，揭开防空洞真相' } else { "第${i}章推进主线，触发一条新规则" }
    $body = @{
      task = 'auto_next'
      mode = 'draft'
      prompt = $hint
      projectId = $projectId
      options = @{ targetWords = $WordsPerChapter }
    } | ConvertTo-Json
    $tc = Get-Date
    try {
      $r = Invoke-RestMethod -Uri "$base/agent/run" -Method POST -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 900
      $chapters = Invoke-RestMethod -Uri "$base/projects/$projectId/chapters" -Method GET
      $last = $chapters | Sort-Object position | Select-Object -Last 1
      $len = if ($last.content) { ([string]$last.content).Length } else { 0 }
      $totalChars += [int]$len
      Log "ch$i" $true ("{0:N0}s chars={1} title={2}" -f ((Get-Date) - $tc).TotalSeconds, $len, $last.title)
    } catch {
      Log "ch$i" $false $_.Exception.Message
      break
    }
    Start-Sleep -Seconds 2
  }

  $allCh = Invoke-RestMethod -Uri "$base/projects/$projectId/chapters" -Method GET
  $sum = ($allCh | ForEach-Object { $_.content.Length } | Measure-Object -Sum).Sum
  Log 'total' $true ("chapters=$($allCh.Count) sumChars=$sum target~$($Chapters * $WordsPerChapter)")

} catch {
  Log 'fatal' $false $_.Exception.Message
}

try {
  $cache = Invoke-RestMethod -Uri 'http://localhost:3000/api/cache-stats' -Method GET
  Log 'cache-stats' $true ("hitRate=$($cache.hitRatePct)% hits=$($cache.cacheHitTokens) prompt=$($cache.promptTokens) calls=$($cache.calls)")
} catch {
  Log 'cache-stats' $false $_.Exception.Message
  $cache = $null
}

# Parse cache lines from backend terminal tail
if ($backendTerm) {
  $tail = Get-Content $backendTerm.FullName -Tail 800 -ErrorAction SilentlyContinue
  foreach ($line in $tail) {
    if ($line -match 'Cache HIT') {
      if ($line -match '(\d+) tokens cached \(([\d.]+)%') {
        $cacheHits += [pscustomobject]@{ tokens = [int]$matches[1]; pct = $matches[2]; line = $line }
      }
    }
    if ($line -match 'cache_hit: (\d+), cache_miss: (\d+)') {
      $h = [int]$matches[1]; $m = [int]$matches[2]
      if ($h -gt 0) { $script:cacheHits += [pscustomobject]@{ tokens = $h; miss = $m; line = $line } }
    }
  }
}

$report = @{
  runId = $runId
  projectId = $projectId
  chapters = $Chapters
  wordsPerChapter = $WordsPerChapter
  steps = $log
  cache = $cache
  cacheHitSamples = $cacheHits | Select-Object -First 30
  cacheHitCount = $cacheHits.Count
}
$out = Join-Path $reportDir "novel_$runId.json"
$report | ConvertTo-Json -Depth 6 | Set-Content -Path $out -Encoding utf8

if ($projectId) {
  try {
    $allCh = Invoke-RestMethod -Uri "$base/projects/$projectId/chapters" -Method GET
    $md = "# 长篇缓存实测 $runId`n`n"
    foreach ($c in ($allCh | Sort-Object position)) {
      $md += "## $($c.title)`n`n$($c.content)`n`n"
    }
    $mdPath = Join-Path $reportDir "novel_$runId.md"
    $md | Set-Content -Path $mdPath -Encoding utf8
    Write-Host "Novel MD: $mdPath"
  } catch { Write-Host "Export MD failed: $_" }
}

Write-Host "`nReport: $out"
Write-Host "Cache HIT log lines found: $($cacheHits.Count)"