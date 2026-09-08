# Live shop — Docker on port 3000 + Windows receipt print agent
param(
  [switch]$Build
)

Set-Location $PSScriptRoot\..

if (-not (Test-Path ".env.store")) {
  Write-Host "Missing .env.store — copy .env.store.example to .env.store first." -ForegroundColor Red
  exit 1
}

Write-Host "Starting STORE (Docker :3000)..." -ForegroundColor Green
Write-Host "Config: .env.store — POS/Admin at http://YOUR_LAN_IP:3000" -ForegroundColor DarkGray

if ($Build) {
  docker compose up -d --build
} else {
  docker compose up -d
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

docker compose ps

$agentScript = Join-Path (Get-Location) "scripts\start-receipt-print-agent.ps1"
if (Test-Path $agentScript) {
  & $agentScript
}

Write-Host ""
Write-Host "Health: http://127.0.0.1:3000/api/v1/health" -ForegroundColor Yellow
Write-Host "Print agent: http://127.0.0.1:17891/health" -ForegroundColor Yellow
