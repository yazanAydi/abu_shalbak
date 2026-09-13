# Live shop - Docker on port 3000
# Receipts print from each cashier's Edge window. Do not start the Windows print agent.
# Do not apply Edge print policies here (that belongs on each cashier PC, never on a dev machine automatically).
param(
  [switch]$Build
)

Set-Location $PSScriptRoot\..

if (-not (Test-Path ".env.store")) {
  Write-Host "Missing .env.store - copy .env.store.example to .env.store first." -ForegroundColor Red
  exit 1
}

Write-Host "Starting STORE (Docker :3000)..." -ForegroundColor Green
Write-Host "Config: .env.store - POS/Admin at http://YOUR_LAN_IP:3000" -ForegroundColor DarkGray

$uninstallAgent = Join-Path (Get-Location) "scripts\uninstall-receipt-print-agent-startup.ps1"
if (Test-Path $uninstallAgent) {
  & $uninstallAgent
}

$stopAgent = Join-Path (Get-Location) "scripts\stop-receipt-print-agent.ps1"
if (Test-Path $stopAgent) {
  & $stopAgent
}

if ($Build) {
  docker compose up -d --build
} else {
  docker compose up -d
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

docker compose ps

$adminApp = Join-Path (Get-Location) "scripts\open-admin-app.ps1"
if (Test-Path $adminApp) {
  & $adminApp -CreateShortcut
}

$posApp = Join-Path (Get-Location) "scripts\open-pos-app.ps1"
if (Test-Path $posApp) {
  & $posApp -CreateShortcut
}

Write-Host ""
Write-Host "Health: http://127.0.0.1:3000/api/v1/health" -ForegroundColor Yellow
Write-Host "Cashier PCs: run scripts\setup-edge-silent-print.ps1 (elevated, once) and open POS from 'POS - Abu Shalbak'." -ForegroundColor Yellow
Write-Host "Office PCs: open AboShalbak-Admin.lnk (admin and accountant). See docs/BARCODE_SCANNER.md if a scan opens DevTools." -ForegroundColor Yellow
