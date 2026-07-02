param(
  [string]$ProjectId = '2e984c8f-66cf-4813-9fa5-a26c5826e530',
  [int]$FromChapter = 2,
  [int]$ToChapter = 5,
  [int]$TargetWords = 3500
)
$base = 'http://localhost:3000/api'
for ($i = $FromChapter; $i -le $ToChapter; $i++) {
  $hint = "第${i}章：推进规则怪谈，节奏加快"
  $body = @{ task = 'auto_next'; mode = 'draft'; prompt = $hint; projectId = $ProjectId; options = @{ targetWords = $TargetWords } } | ConvertTo-Json
  Write-Host "[$(Get-Date -Format HH:mm:ss)] Chapter $i starting..."
  $t0 = Get-Date
  try {
    $r = Invoke-RestMethod -Uri "$base/agent/run" -Method POST -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 900
    $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 0)
    Write-Host "  OK ${secs}s — $($r.summary)"
  } catch {
    Write-Host "  FAIL — $($_.Exception.Message)"
    break
  }
}
$ch = Invoke-RestMethod "$base/projects/$ProjectId/chapters"
$sum = 0
foreach ($c in $ch) { $sum += ([string]$c.content).Length }
$cache = Invoke-RestMethod "$base/api/cache-stats" -ErrorAction SilentlyContinue
if (-not $cache) { $cache = Invoke-RestMethod "http://localhost:3000/api/cache-stats" }
Write-Host "Total chapters=$($ch.Count) chars=$sum cacheHitRate=$($cache.hitRatePct)%"