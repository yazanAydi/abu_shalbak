# Start the bundled cashier receipt helper. No Docker, API, or database.
param(
  [string]$InstallDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$node = Join-Path $InstallDir "runtime\node\node.exe"
$script = Join-Path $InstallDir "backend\scripts\receipt-print-dialog-helper.mjs"
$envFile = Join-Path $InstallDir ".env.cashier-print"
if (-not (Test-Path -LiteralPath $node)) { throw "Missing bundled Node: $node" }
if (-not (Test-Path -LiteralPath $script)) { throw "Missing helper script: $script" }
if (-not (Test-Path -LiteralPath $envFile)) { throw "Missing .env.cashier-print. Run Install first." }

$testMode = ""
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match "^\s*RECEIPT_PRINT_TEST_MODE\s*=\s*(.*)$") {
    $testMode = $Matches[1].Trim()
    break
  }
}
if ($testMode -and $testMode.ToLower() -ne "save") {
  throw "RECEIPT_PRINT_TEST_MODE must be unset or save."
}

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "data") | Out-Null
$pidFile = Join-Path $InstallDir "data\receipt-print-dialog-helper.pid"
$outFile = Join-Path $InstallDir "data\receipt-print-dialog-helper.out.log"
$errFile = Join-Path $InstallDir "data\receipt-print-dialog-helper.err.log"

if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Output "already-running:$oldPid"
    return
  }
}

$env:CASHIER_PRINT_ROOT = $InstallDir
$env:CASHIER_PRINT_ENV = $envFile
Remove-Item Env:RECEIPT_PRINT_TEST_MODE -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $node `
  -ArgumentList @($script) `
  -WorkingDirectory $InstallDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outFile `
  -RedirectStandardError $errFile `
  -PassThru
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
Write-Output "started:$($proc.Id)"
