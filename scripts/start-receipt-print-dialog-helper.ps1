# Cashier Windows PC helper: arm one POS receipt, print, confirm that Print dialog.
# Outside Docker. Bind 127.0.0.1:17892 only.
Set-Location $PSScriptRoot\..

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js LTS is required on this cashier PC for the print helper." -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path "data" | Out-Null
$pidFile = Join-Path (Get-Location) "data\receipt-print-dialog-helper.pid"
$outFile = Join-Path (Get-Location) "data\receipt-print-dialog-helper.out.log"
$errFile = Join-Path (Get-Location) "data\receipt-print-dialog-helper.err.log"

if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Host "Receipt print dialog helper already running (PID $oldPid)" -ForegroundColor DarkGray
    return
  }
}

$env:ABO_ENV = "store"
$proc = Start-Process -FilePath $node.Source `
  -ArgumentList "backend/scripts/receipt-print-dialog-helper.mjs" `
  -WorkingDirectory (Get-Location) `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outFile `
  -RedirectStandardError $errFile `
  -PassThru
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

Start-Sleep -Seconds 2
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:17892/health" -TimeoutSec 3 | Out-Null
  Write-Host "Receipt print dialog helper listening on http://127.0.0.1:17892 (PID $($proc.Id))" -ForegroundColor Green
} catch {
  Write-Host "Helper started (PID $($proc.Id)) but health check failed. See data/receipt-print-dialog-helper.err.log" -ForegroundColor Yellow
}
