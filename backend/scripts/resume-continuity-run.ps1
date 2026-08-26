$ErrorActionPreference = "Stop"
if (-not $env:LLM_API_KEY) {
  throw "LLM_API_KEY is required in environment."
}
$env:LLM_BASE_URL = "https://api.deepseek.com"
$env:LLM_MODEL = "deepseek-v4-flash-vision-exp"
$env:LLM_TEMPERATURE = "0.75"

$backend = Split-Path -Parent $PSScriptRoot
Set-Location $backend

npm run acceptance:continuity -- `
  --chapters 250 `
  --words 2000 `
  --batch 10 `
  --max-batches 21 `
  --checkpoints 50,100 `
  --out ../reports/continuity-acceptance/run-20260628-v2

exit $LASTEXITCODE
