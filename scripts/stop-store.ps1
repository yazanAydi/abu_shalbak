# Stop the Windows receipt print agent, then Docker store
Set-Location $PSScriptRoot\..

$dialogHelper = Join-Path (Get-Location) "scripts\stop-receipt-print-dialog-helper.ps1"
if (Test-Path $dialogHelper) {
  & $dialogHelper
}

$agentScript = Join-Path (Get-Location) "scripts\stop-receipt-print-agent.ps1"
if (Test-Path $agentScript) {
  & $agentScript
}

Write-Host "Stopping STORE (Docker)..." -ForegroundColor Green
docker compose --env-file .env.store down
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
