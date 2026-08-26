# Detached long-run continuity acceptance (survives IDE shell timeout).
param(
  [string]$OutDir = "../reports/continuity-acceptance/run-20260628-v2",
  [int]$Chapters = 250,
  [int]$Words = 2000,
  [int]$Batch = 10,
  [int]$MaxBatches = 1,
  [string]$Checkpoints = "5,10"
)

$ErrorActionPreference = "Stop"
$backend = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $backend
$out = Join-Path $root ($OutDir -replace '^\.\./', '')
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out "runner.log"

$env:LLM_BASE_URL = "https://api.deepseek.com"
if (-not $env:LLM_API_KEY) {
  throw "LLM_API_KEY is required in environment."
}
if (-not $env:LLM_MODEL) { $env:LLM_MODEL = "deepseek-v4-flash-vision-exp" }
$env:LLM_TEMPERATURE = "0.75"

"[$((Get-Date).ToString('o'))] starting continuity acceptance" | Out-File -FilePath $log -Encoding utf8
Set-Location $backend
npm run acceptance:continuity -- `
  --chapters $Chapters `
  --words $Words `
  --batch $Batch `
  --max-batches $MaxBatches `
  --checkpoints $Checkpoints `
  --out $OutDir *>> $log
$code = $LASTEXITCODE
"[$((Get-Date).ToString('o'))] finished exit=$code" | Out-File -FilePath $log -Append -Encoding utf8
exit $code
