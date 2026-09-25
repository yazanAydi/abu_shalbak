# Local Telegram test on the normal dev ports.
# Loads only .env.telegram-local for the approvals bot. Does not edit .env.store or .env.development.
# Return to normal development with: npm run dev
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$db = Join-Path $env:TEMP "abu-telegram-local\approvals.db"
if (-not (Test-Path -LiteralPath $db)) {
  throw "Disposable Telegram-test database is missing: $db"
}
$envFile = Join-Path $root ".env.telegram-local"
if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Missing .env.telegram-local"
}

$env:ABO_ENV = "development"
$env:NODE_ENV = "development"
$env:ABO_TELEGRAM_LOCAL = "1"
Remove-Item Env:PORT -ErrorAction SilentlyContinue
Remove-Item Env:HOST -ErrorAction SilentlyContinue
$env:DATABASE_PATH = $db
$env:DISABLE_AUTO_BACKUP = "1"
$env:DISABLE_EXPIRY_TELEGRAM_ALERT = "1"

Get-Content -LiteralPath $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $parts = $_.Split('=', 2)
  Set-Item -Path ("Env:" + $parts[0].Trim()) -Value $parts[1].Trim()
}
foreach ($name in @(
  "TELEGRAM_REFUND_BOT_TOKEN",
  "TELEGRAM_SULAF_BOT_TOKEN",
  "TELEGRAM_EXPIRY_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_REFUND_WEBHOOK_SECRET",
  "TELEGRAM_SULAF_WEBHOOK_SECRET",
  "TELEGRAM_EXPIRY_WEBHOOK_SECRET"
)) {
  Set-Item -Path "Env:$name" -Value ""
}

if ($env:TELEGRAM_USE_POLLING -ne "1") { throw "TELEGRAM_USE_POLLING must be 1 in .env.telegram-local" }
if (-not $env:TELEGRAM_APPROVALS_BOT_TOKEN) { throw "TELEGRAM_APPROVALS_BOT_TOKEN is empty" }
if (-not $env:TELEGRAM_APPROVALS_CHAT_ID) { throw "TELEGRAM_APPROVALS_CHAT_ID is empty" }

Write-Output "dev:telegram database=$db polling=1 chat=$($env:TELEGRAM_APPROVALS_CHAT_ID)"
Write-Output "API http://127.0.0.1:5001  office http://127.0.0.1:3001/admin  POS http://127.0.0.1:3002/pos"
Write-Output "Stop this window and run npm run dev to return to normal development."

npm run dev
