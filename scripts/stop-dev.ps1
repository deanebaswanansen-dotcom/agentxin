$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidFile = Join-Path $Root ".agentxin\runtime\dev-pids.json"

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return }
  try {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  } catch {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-PortOwnerPids {
  param([int]$Port)
  $pids = @()
  try {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess -and $c.OwningProcess -ne 0) {
        $pids += [int]$c.OwningProcess
      }
    }
  } catch { }
  return @($pids | Select-Object -Unique)
}

$stopped = 0

if (Test-Path $PidFile) {
  try {
    $state = Get-Content $PidFile -Raw | ConvertFrom-Json
    foreach ($item in @($state.processes)) {
      $pidValue = [int]$item.pid
      $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($process) {
        Stop-ProcessTree -ProcessId $pidValue
        $stopped += 1
        Write-Host "[stop] $($item.name) PID=$pidValue (process tree)"
      } else {
        Write-Host "[skip] $($item.name) PID=$pidValue already exited"
      }
    }
  } catch {
    Write-Host "[warn] Could not parse $PidFile : $($_.Exception.Message)"
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "[info] No background process record found."
}

# Also free default ports in case orphans were left from older runs / crashes.
foreach ($port in @(3000, 5173, 5174, 5175, 5176)) {
  $owners = Get-PortOwnerPids -Port $port
  foreach ($op in $owners) {
    $proc = Get-Process -Id $op -ErrorAction SilentlyContinue
    $cmd = ""
    try {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$op" -ErrorAction SilentlyContinue).CommandLine
    } catch { }
    if ($cmd -and ($cmd -match 'agentxin|vite|tsx|novel-writing')) {
      Write-Host "[clean] port $port orphan PID=$op"
      Stop-ProcessTree -ProcessId $op
      $stopped += 1
    }
  }
}

Write-Host "[done] Stopped $stopped process tree(s). Ports 3000/5173 should be free."
