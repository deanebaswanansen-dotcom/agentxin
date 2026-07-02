$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidFile = Join-Path $Root ".agentxin\runtime\dev-pids.json"

if (-not (Test-Path $PidFile)) {
  Write-Host "[info] No background process record found."
  exit 0
}

$state = Get-Content $PidFile -Raw | ConvertFrom-Json
$stopped = 0
foreach ($item in @($state.processes)) {
  $pidValue = [int]$item.pid
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $pidValue -Force
    $stopped += 1
    Write-Host "[stop] $($item.name) PID=$pidValue"
  }
}

Remove-Item $PidFile -Force
Write-Host "[done] Stopped $stopped background process(es) started by start.bat."
