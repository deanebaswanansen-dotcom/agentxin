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
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
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
    Write-Host "[reuse] $Name port $Port is already reachable; no new process recorded."
    return $null
  }
  $stdout = Join-Path $LogDir "$Name.out.log"
  $stderr = Join-Path $LogDir "$Name.err.log"
  Write-Host "[start] $Name -> http://127.0.0.1:$Port"
  $process = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "npm run dev") `
    -WorkingDirectory $Dir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  if (-not (Wait-TcpPort -Port $Port -Seconds 30)) {
    Write-Host "[warn] $Name port $Port was not ready within 30 seconds; check $stderr"
  }
  return @{ name = $Name; pid = $process.Id; port = $Port; stdout = $stdout; stderr = $stderr }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Install Node.js 18 or newer first."
}

$backendDir = Join-Path $Root "backend"
$frontendDir = Join-Path $Root "frontend"

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

if (Wait-TcpPort -Port 5173 -Seconds 10) {
  Start-Process "http://127.0.0.1:5173"
}

Write-Host "[done] Workbench: http://127.0.0.1:5173"
Write-Host "[logs] $LogDir"
Write-Host "[note] Python LangGraph core required for agent/blueprint tasks (via web_bridge). Use 'python -m novel_agent.cli' as primary CLI."
Write-Host "[stop] Run stop.bat to stop background processes started by this script."
