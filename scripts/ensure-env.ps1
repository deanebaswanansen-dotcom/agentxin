#Requires -Version 5.1
<#
.SYNOPSIS
  Ensure Node.js + npm + project dependencies exist for AgentXin.
  Safe to re-run. Prefer portable Node under .agentxin\node when system Node is missing.
#>
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RuntimeDir = Join-Path $Root ".agentxin"
$PortableNodeRoot = Join-Path $RuntimeDir "node"
$LogDir = Join-Path $Root "logs\dev"
New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null

# Node 20 LTS win-x64 portable (official distribution)
$NodeVersion = "v20.18.1"
$NodeZipName = "node-$NodeVersion-win-x64"
$NodeZipUrl = "https://nodejs.org/dist/$NodeVersion/$NodeZipName.zip"
$MinMajor = 18

function Write-Step([string]$Message) {
  Write-Host "[env] $Message"
}

function Get-NodeMajor([string]$NodeExe) {
  try {
    $raw = & $NodeExe -v 2>$null
    if ($raw -match 'v?(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

function Add-PathFront([string]$Dir) {
  if (-not (Test-Path $Dir)) { return }
  $env:Path = "$Dir;" + ($env:Path -replace [regex]::Escape($Dir + ";"), "")
}

function Find-NodeCommand {
  # Prefer system node if modern enough
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys) {
    $major = Get-NodeMajor $sys.Source
    if ($major -ge $MinMajor) {
      return @{ kind = "system"; node = $sys.Source; npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
    }
    Write-Step "System Node is too old (need >= $MinMajor): $($sys.Source)"
  }

  $portableNode = Join-Path $PortableNodeRoot "node.exe"
  if (Test-Path $portableNode) {
    Add-PathFront $PortableNodeRoot
    $npmCmd = Join-Path $PortableNodeRoot "npm.cmd"
    return @{ kind = "portable"; node = $portableNode; npm = $npmCmd }
  }
  return $null
}

function Install-PortableNode {
  Write-Step "Downloading portable Node.js $NodeVersion ..."
  $tmpZip = Join-Path $env:TEMP "agentxin-node-$NodeVersion.zip"
  $tmpExtract = Join-Path $env:TEMP "agentxin-node-extract-$NodeVersion"

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    # Prefer Invoke-WebRequest; BITS as fallback
    try {
      Invoke-WebRequest -Uri $NodeZipUrl -OutFile $tmpZip -UseBasicParsing
    } catch {
      Write-Step "Invoke-WebRequest failed, trying BitsTransfer..."
      Import-Module BitsTransfer -ErrorAction SilentlyContinue
      Start-BitsTransfer -Source $NodeZipUrl -Destination $tmpZip
    }

    if (-not (Test-Path $tmpZip)) {
      throw "Failed to download Node.js from $NodeZipUrl"
    }

    if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force

    $extracted = Join-Path $tmpExtract $NodeZipName
    if (-not (Test-Path (Join-Path $extracted "node.exe"))) {
      # Some zips nest differently
      $found = Get-ChildItem -Path $tmpExtract -Recurse -Filter "node.exe" | Select-Object -First 1
      if (-not $found) { throw "node.exe not found in downloaded archive." }
      $extracted = $found.Directory.FullName
    }

    if (Test-Path $PortableNodeRoot) {
      Remove-Item $PortableNodeRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $PortableNodeRoot) | Out-Null
    Move-Item -Path $extracted -Destination $PortableNodeRoot
    Write-Step "Portable Node installed to: $PortableNodeRoot"
  } finally {
    if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue }
    if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Try-WingetInstallNode {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { return $false }
  Write-Step "Trying winget install OpenJS.NodeJS.LTS ..."
  try {
    & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    # Refresh PATH from machine + user
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
    $sys = Get-Command node -ErrorAction SilentlyContinue
    if ($sys -and (Get-NodeMajor $sys.Source) -ge $MinMajor) {
      Write-Step "Node installed via winget."
      return $true
    }
  } catch {
    Write-Step "winget install failed: $($_.Exception.Message)"
  }
  return $false
}

function Ensure-Node {
  $found = Find-NodeCommand
  if ($found) {
    Write-Step "Node ready ($($found.kind)): $(& $found.node -v)"
    return $found
  }

  Write-Step "Node.js not found. Will auto-install (no admin needed for portable mode)."
  if (Try-WingetInstallNode) {
    $found = Find-NodeCommand
    if ($found) { return $found }
  }

  Install-PortableNode
  Add-PathFront $PortableNodeRoot
  $found = Find-NodeCommand
  if (-not $found) {
    throw "Auto-install Node.js failed. Please install Node 18+ from https://nodejs.org and re-run start.bat"
  }
  Write-Step "Node ready ($($found.kind)): $(& $found.node -v)"
  return $found
}

function Needs-NpmInstall {
  param([string]$Dir)
  $nm = Join-Path $Dir "node_modules"
  $pkg = Join-Path $Dir "package.json"
  $lock = Join-Path $Dir "package-lock.json"
  if (-not (Test-Path $nm)) { return $true }
  if (-not (Test-Path $pkg)) { return $false }

  $nmTime = (Get-Item $nm).LastWriteTimeUtc
  $pkgTime = (Get-Item $pkg).LastWriteTimeUtc
  if ($pkgTime -gt $nmTime) { return $true }
  if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTimeUtc -gt $nmTime)) { return $true }

  # Marker that install finished
  $marker = Join-Path $nm ".package-lock.json"
  if (-not (Test-Path $marker) -and -not (Test-Path (Join-Path $nm ".bin"))) {
    return $true
  }
  return $false
}

function Ensure-Deps {
  param([string]$Dir, [string]$Name)
  if (-not (Test-Path (Join-Path $Dir "package.json"))) {
    throw "Missing package.json under $Dir"
  }
  if (-not (Needs-NpmInstall -Dir $Dir)) {
    Write-Step "$Name dependencies OK."
    return
  }
  Write-Step "Installing $Name dependencies (npm install) — first run may take several minutes..."
  Push-Location $Dir
  try {
    # Use npm.cmd on Windows for proper spawn
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw "npm not found after Node install." }

    & $npm.Source install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed for $Name (exit $LASTEXITCODE). Check network / registry."
    }
  } finally {
    Pop-Location
  }
  Write-Step "$Name dependencies installed."
}

# ---- main ----
$nodeInfo = Ensure-Node
# Ensure npm on PATH for child processes
if ($nodeInfo.kind -eq "portable") {
  Add-PathFront $PortableNodeRoot
}

$backendDir = Join-Path $Root "backend"
$frontendDir = Join-Path $Root "frontend"
Ensure-Deps -Dir $backendDir -Name "backend"
Ensure-Deps -Dir $frontendDir -Name "frontend"

Write-Step "Environment ready."
return 0
