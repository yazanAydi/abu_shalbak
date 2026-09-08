# Stop the Windows receipt print agent, then Docker store
Set-Location $PSScriptRoot\..

$agentScript = Join-Path (Get-Location) "scripts\stop-receipt-print-agent.ps1"
if (Test-Path $agentScript) {
  & $agentScript
}

Write-Host "Stopping STORE (Docker)..." -ForegroundColor Green
docker compose down
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
