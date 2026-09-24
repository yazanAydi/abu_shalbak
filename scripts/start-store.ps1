# Live shop - Docker on port 3000 + Windows receipt print agent
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

$ensureToken = Join-Path (Get-Location) "scripts\ensure-receipt-print-agent-token.ps1"
if (Test-Path $ensureToken) {
  & $ensureToken
}

# --env-file feeds Compose ${} substitution. Those values reach the container
# only because docker-compose.yml lists them under environment: / env_file.
if ($Build) {
  docker compose --env-file .env.store up -d --build
} else {
  docker compose --env-file .env.store up -d
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

docker compose --env-file .env.store ps

$agentScript = Join-Path (Get-Location) "scripts\start-receipt-print-agent.ps1"
if (Test-Path $agentScript) {
  & $agentScript
}

$startupScript = Join-Path (Get-Location) "scripts\install-receipt-print-agent-startup.ps1"
if (Test-Path $startupScript) {
  & $startupScript
}

$adminApp = Join-Path (Get-Location) "scripts\open-admin-app.ps1"
if (Test-Path $adminApp) {
  & $adminApp -CreateShortcut
}

Write-Host ""
Write-Host "Health: http://127.0.0.1:3000/api/v1/health" -ForegroundColor Yellow
Write-Host "Print agent (Windows, unused by POS checkout): Invoke-RestMethod http://127.0.0.1:17891/health" -ForegroundColor Yellow
Write-Host "Cashier receipt helper (17892) runs on the till, not this server. See docs/CASHIER_RECEIPT_PRINT_HELPER.md" -ForegroundColor Yellow
try {
  $fromDocker = docker exec supermarket-pos node -e "fetch('http://host.docker.internal:17891/health').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))"
  if ($fromDocker) {
    Write-Host "Print agent (Docker): $fromDocker" -ForegroundColor Green
  } else {
    Write-Host "Print agent (Docker): host.docker.internal:17891 not reachable yet. See data/receipt-print-agent.err.log" -ForegroundColor Yellow
  }
} catch {
  Write-Host "Print agent (Docker): could not exec wget inside supermarket-pos" -ForegroundColor DarkGray
}
