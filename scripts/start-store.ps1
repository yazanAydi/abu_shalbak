# Live shop — Docker on port 3000
Set-Location $PSScriptRoot\..

if (-not (Test-Path ".env.store")) {
  Write-Host "Missing .env.store — copy .env.store.example to .env.store first." -ForegroundColor Red
  exit 1
}

Write-Host "Starting STORE (Docker :3000)..." -ForegroundColor Green
Write-Host "Config: .env.store — POS/Admin at http://YOUR_LAN_IP:3000" -ForegroundColor DarkGray

docker compose up -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

docker compose ps
Write-Host ""
Write-Host "Health: http://127.0.0.1:3000/api/v1/health" -ForegroundColor Yellow
