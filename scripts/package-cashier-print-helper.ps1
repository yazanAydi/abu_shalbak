# Build a USB-copyable cashier print helper (bundled Node + production deps).
# Does not start Docker, submit sales, or send print jobs.
param(
  [string]$NodeVersion = "22.20.0"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
$repo = Get-Location
$ps51 = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$ensureBom = Join-Path $repo "scripts\cashier-print\ensure-utf8-bom.ps1"
$validatePs51 = Join-Path $repo "scripts\cashier-print\validate-ps51.ps1"
$sourceTextFiles = @(
  (Join-Path $repo "scripts\cashier-print\Install.ps1"),
  (Join-Path $repo "scripts\cashier-print\Start-Helper.ps1"),
  (Join-Path $repo "scripts\cashier-print\Stop-Helper.ps1"),
  (Join-Path $repo "scripts\cashier-print\Register-Startup.ps1"),
  (Join-Path $repo "scripts\cashier-print\README.txt"),
  (Join-Path $repo "backend\scripts\confirm-receipt-print-dialog.ps1")
)
& $ps51 -NoProfile -ExecutionPolicy Bypass -File $ensureBom @sourceTextFiles
if ($LASTEXITCODE -ne 0) { throw "Failed to write UTF-8 BOM on source installer scripts" }
$outRoot = Join-Path $repo "dist\cashier-print\AboShalbak-ReceiptPrint"
$zipPath = Join-Path $repo "dist\cashier-print\AboShalbak-ReceiptPrint.zip"
$cache = Join-Path $repo "tmp\cashier-print-cache"
$nodeZipName = "node-v$NodeVersion-win-x64.zip"
$nodeZip = Join-Path $cache $nodeZipName
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeZipName"

New-Item -ItemType Directory -Force -Path $cache | Out-Null
if (Test-Path $outRoot) {
  try {
    Remove-Item -LiteralPath $outRoot -Recurse -Force
  } catch {
    $outRoot = Join-Path $repo ("dist\cashier-print\AboShalbak-ReceiptPrint-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
    $zipPath = "$outRoot.zip"
    Write-Host "Previous package folder is in use; writing $outRoot" -ForegroundColor Yellow
  }
}
New-Item -ItemType Directory -Force -Path $outRoot | Out-Null

$files = @(
  "backend\scripts\receipt-print-dialog-helper.mjs",
  "backend\scripts\write-cashier-print-env.mjs",
  "backend\scripts\confirm-receipt-print-dialog.ps1",
  "backend\services\windowsSilentPrint.js",
  "backend\services\chromeCdp.js",
  "backend\services\receiptPrintDialogHelper.js",
  "backend\utils\receiptPrintHelperAccess.js",
  "backend\utils\cashierPrintHelperVersion.js",
  "backend\utils\receiptPdfPage.js",
  "backend\utils\receipt.js",
  "backend\utils\storeBranding.js",
  "backend\utils\entityCodes.js",
  "backend\utils\money.js",
  "backend\utils\dbTx.js",
  "backend\utils\receiptPrintDialogMatch.js"
)
foreach ($rel in $files) {
  $dest = Join-Path $outRoot $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo $rel) -Destination $dest -Force
}

Copy-Item (Join-Path $repo "scripts\cashier-print\Install.bat") (Join-Path $outRoot "Install.bat") -Force
Copy-Item (Join-Path $repo "scripts\cashier-print\Install.ps1") (Join-Path $outRoot "Install.ps1") -Force
Copy-Item (Join-Path $repo "scripts\cashier-print\Start-Helper.ps1") (Join-Path $outRoot "Start-Helper.ps1") -Force
Copy-Item (Join-Path $repo "scripts\cashier-print\Stop-Helper.ps1") (Join-Path $outRoot "Stop-Helper.ps1") -Force
Copy-Item (Join-Path $repo "scripts\cashier-print\Register-Startup.ps1") (Join-Path $outRoot "Register-Startup.ps1") -Force
Copy-Item (Join-Path $repo "scripts\cashier-print\README.txt") (Join-Path $outRoot "README.txt") -Force

$pkg = @{
  name = "abo-shalbak-cashier-print"
  private = $true
  type = "module"
  dependencies = @{
    dotenv = "16.4.5"
    "pdf-to-printer" = "5.8.1"
  }
}
$pkg | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outRoot "package.json") -Encoding utf8

$ver = Get-Content -LiteralPath (Join-Path $repo "backend\utils\cashierPrintHelperVersion.js") -Raw
if ($ver -notmatch 'CASHIER_PRINT_HELPER_VERSION = "([^"]+)"') {
  throw "Could not read CASHIER_PRINT_HELPER_VERSION"
}
Set-Content -LiteralPath (Join-Path $outRoot "VERSION") -Value $Matches[1] -Encoding ascii

if (-not (Test-Path -LiteralPath $nodeZip)) {
  Write-Host "Downloading portable Node $NodeVersion ..." -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
}
$nodeExtract = Join-Path $cache "node-v$NodeVersion-win-x64"
if (-not (Test-Path (Join-Path $nodeExtract "node.exe"))) {
  if (Test-Path $nodeExtract) { Remove-Item $nodeExtract -Recurse -Force }
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $cache -Force
}
$runtimeNode = Join-Path $outRoot "runtime\node"
New-Item -ItemType Directory -Force -Path $runtimeNode | Out-Null
Copy-Item -Path (Join-Path $nodeExtract "*") -Destination $runtimeNode -Recurse -Force

$npm = Join-Path $runtimeNode "npm.cmd"
Push-Location $outRoot
try {
  & $npm install --omit=dev --omit=optional --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw "npm install failed in helper package" }
} finally {
  Pop-Location
}

# Keep the package free of store secrets / DBs / test-save.
Get-ChildItem $outRoot -Recurse -File | Where-Object {
  $_.Name -match '^\.env($|\.)' -or $_.Extension -in ".db", ".db-wal", ".db-shm"
} | Remove-Item -Force
if (Test-Path (Join-Path $outRoot "package-lock.json")) {
  # lockfile is fine to keep
}

$shippedText = @(
  (Join-Path $outRoot "Install.ps1"),
  (Join-Path $outRoot "Start-Helper.ps1"),
  (Join-Path $outRoot "Stop-Helper.ps1"),
  (Join-Path $outRoot "Register-Startup.ps1"),
  (Join-Path $outRoot "README.txt"),
  (Join-Path $outRoot "backend\scripts\confirm-receipt-print-dialog.ps1")
)
& $ps51 -NoProfile -ExecutionPolicy Bypass -File $ensureBom @shippedText
if ($LASTEXITCODE -ne 0) { throw "Failed to write UTF-8 BOM on packaged scripts" }

$shippedPs1 = @(
  (Join-Path $outRoot "Install.ps1"),
  (Join-Path $outRoot "Start-Helper.ps1"),
  (Join-Path $outRoot "Stop-Helper.ps1"),
  (Join-Path $outRoot "Register-Startup.ps1"),
  (Join-Path $outRoot "backend\scripts\confirm-receipt-print-dialog.ps1")
)
& $ps51 -NoProfile -ExecutionPolicy Bypass -File $validatePs51 @shippedPs1
if ($LASTEXITCODE -ne 0) { throw "Windows PowerShell 5.1 rejected a packaged script" }

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $outRoot -DestinationPath $zipPath -Force

Write-Host "Deliverable folder: $outRoot" -ForegroundColor Green
Write-Host "Deliverable zip:    $zipPath" -ForegroundColor Green
