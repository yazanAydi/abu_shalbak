# Start the bundled cashier receipt helper. No Docker, API, or database.
param(
  [string]$InstallDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "HelperProcess.ps1")

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
$outFile = Join-Path $InstallDir "data\receipt-print-dialog-helper.out.log"
$errFile = Join-Path $InstallDir "data\receipt-print-dialog-helper.err.log"

Write-ReceiptHelperLog $InstallDir "INFO" "start: begin install=$InstallDir"
$running = Find-RunningReceiptHelper $InstallDir
if ($running -gt 0) {
  Write-ReceiptHelperPidFile $InstallDir $running
  $port = Get-ReceiptHelperPort
  $healthy = Wait-ReceiptHelperHealth $InstallDir $running $null $port
  if ($healthy) {
    Write-ReceiptHelperLog $InstallDir "INFO" "SUCCESS helper already running pid=$running"
  } else {
    Write-ReceiptHelperLog $InstallDir "ERROR" "FAILURE helper process $running is running but health check failed"
  }
  Write-Output "already-running:$running"
  return
}

Write-ReceiptHelperLog $InstallDir "INFO" "start: no previous receipt helper instance; starting one"
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
$helperPid = 0
if (-not $proc -or -not [int]::TryParse([string]$proc.Id, [ref]$helperPid) -or $helperPid -le 0) {
  Write-ReceiptHelperLog $InstallDir "ERROR" "FAILURE Start-Process did not return a process id"
  throw "Receipt helper failed to start (no process id). See data\receipt-print-helper-startup.log"
}
Write-ReceiptHelperPidFile $InstallDir $helperPid
Write-Output "started:$helperPid"

$port = Get-ReceiptHelperPort
if (-not (Wait-ReceiptHelperHealth $InstallDir $helperPid $proc $port)) {
  throw "Receipt helper failed to start. See data\receipt-print-helper-startup.log"
}
