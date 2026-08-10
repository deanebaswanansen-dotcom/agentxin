$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RuntimeDir = Join-Path $Root ".agentxin\runtime"
$LogDir = Join-Path $Root "logs\dev"
$PidFile = Join-Path $RuntimeDir "dev-pids.json"

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null

$ExistingRecords = @()
if (Test-Path $PidFile) {
  try {
    $state = Get-Content $PidFile -Raw | ConvertFrom-Json
    $ExistingRecords = @($state.processes)
  } catch {
    $ExistingRecords = @()
  }
}

function Test-TcpPort {
  param([int]$Port)
  # Check both IPv4 and IPv6 localhost — Vite may bind either.
  foreach ($hostAddr in @("127.0.0.1", "::1")) {
    $client = $null
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $async = $client.BeginConnect($hostAddr, $Port, $null, $null)
      if ($async.AsyncWaitHandle.WaitOne(300)) {
        $client.EndConnect($async)
        if ($client.Connected) { return $true }
      }
    } catch {
      # try next host
    } finally {
      if ($client) { $client.Close() }
    }
  }
  return $false
}

function Wait-TcpPort {
  param([int]$Port, [int]$Seconds = 20)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -Port $Port) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
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
  } catch {
    # Fallback when Get-NetTCPConnection is unavailable
  }
  return @($pids | Select-Object -Unique)
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return }
  try {
    # /T = tree, /F = force
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  } catch {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-NodeModules {
  param([string]$Dir, [string]$Name)
  if (Test-Path (Join-Path $Dir "node_modules")) {
    Write-Host "[info] $Name dependencies already exist."
    return
  }
  Write-Host "[install] $Name dependencies missing; running npm install..."
  Push-Location $Dir
  try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed for $Name (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

function Find-RecordedProcess {
  param([int]$Port)
  foreach ($item in $ExistingRecords) {
    if ([int]$item.port -ne $Port) { continue }
    $process = Get-Process -Id ([int]$item.pid) -ErrorAction SilentlyContinue
    if ($process) { return $item }
  }
  return $null
}

function Start-ServiceProcess {
  param(
    [string]$Name,
    [string]$Dir,
    [int]$Port
  )
  if (Test-TcpPort -Port $Port) {
    $recorded = Find-RecordedProcess -Port $Port
    if ($recorded) {
      Write-Host "[reuse] $Name port $Port is already reachable; keeping PID $($recorded.pid)."
      return $recorded
    }
    # Port held by an orphan / external process — free it so we own the stack.
    $owners = Get-PortOwnerPids -Port $Port
    if ($owners.Count -gt 0) {
      Write-Host "[clean] $Name port $Port held by orphan PID(s): $($owners -join ', '); stopping..."
      foreach ($op in $owners) { Stop-ProcessTree -ProcessId $op }
      Start-Sleep -Milliseconds 500
    }
    if (Test-TcpPort -Port $Port) {
      throw "$Name port $Port is still in use after cleanup. Free it manually, then re-run start.bat."
    }
  }

  $stdout = Join-Path $LogDir "$Name.out.log"
  $stderr = Join-Path $LogDir "$Name.err.log"
  # Truncate previous logs so failures are obvious
  "" | Set-Content -Path $stdout -Encoding UTF8
  "" | Set-Content -Path $stderr -Encoding UTF8

  Write-Host "[start] $Name -> http://127.0.0.1:$Port"
  $process = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "npm run dev") `
    -WorkingDirectory $Dir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  if (-not (Wait-TcpPort -Port $Port -Seconds 45)) {
    $errTail = ""
    if (Test-Path $stderr) {
      $errTail = (Get-Content $stderr -Raw -ErrorAction SilentlyContinue)
    }
    $outTail = ""
    if (Test-Path $stdout) {
      $outTail = (Get-Content $stdout -Raw -ErrorAction SilentlyContinue)
    }
    Stop-ProcessTree -ProcessId $process.Id
    throw ("$Name failed to listen on port $Port within 45s.`n--- stderr ---`n$errTail`n--- stdout ---`n$outTail")
  }

  return @{ name = $Name; pid = $process.Id; port = $Port; stdout = $stdout; stderr = $stderr }
}

# Auto-bootstrap: Node (system / winget / portable) + npm install
$ensureScript = Join-Path $PSScriptRoot "ensure-env.ps1"
if (-not (Test-Path $ensureScript)) {
  throw "Missing scripts\ensure-env.ps1"
}
Write-Host "[start] Checking environment (Node / dependencies)..."
& $ensureScript
if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
  throw "Environment setup failed (exit $LASTEXITCODE)."
}

# Portable Node may only be on PATH for this process tree
$portableNodeDir = Join-Path $Root ".agentxin\node"
if (Test-Path (Join-Path $portableNodeDir "node.exe")) {
  $env:Path = "$portableNodeDir;" + $env:Path
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js still not available after auto-setup. Install from https://nodejs.org and re-run."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue) -and -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "npm still not available after auto-setup."
}

$backendDir = Join-Path $Root "backend"
$frontendDir = Join-Path $Root "frontend"

# Keep legacy helper as no-op safety (ensure-env already installed)
Ensure-NodeModules -Dir $backendDir -Name "backend"
Ensure-NodeModules -Dir $frontendDir -Name "frontend"

$records = @()
$backend = Start-ServiceProcess -Name "backend" -Dir $backendDir -Port 3000
if ($backend) { $records += $backend }
$frontend = Start-ServiceProcess -Name "frontend" -Dir $frontendDir -Port 5173
if ($frontend) { $records += $frontend }

$payload = @{
  startedAt = (Get-Date).ToString("o")
  root = "$Root"
  processes = $records
}
$payload | ConvertTo-Json -Depth 4 | Set-Content -Path $PidFile -Encoding UTF8

if (Wait-TcpPort -Port 5173 -Seconds 5) {
  Start-Process "http://127.0.0.1:5173"
} else {
  Write-Host "[warn] Frontend is not reachable at http://127.0.0.1:5173"
}

Write-Host ""
Write-Host "[done] Workbench: http://127.0.0.1:5173"
Write-Host "[logs] $LogDir"
Write-Host "[note] Python LangGraph core required for agent/blueprint tasks (via web_bridge)."
Write-Host "[stop] Run stop.bat to stop background processes started by this script."
