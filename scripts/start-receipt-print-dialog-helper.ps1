# Cashier Windows PC helper: print POS receipts on the local USB printer.
# Does not start Docker, the API, or a database. Bind 127.0.0.1:17892 only.
Set-Location $PSScriptRoot\..

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js LTS is required on this cashier PC for the print helper." -ForegroundColor Red
  exit 1
}

$cashierEnv = Join-Path (Get-Location) ".env.cashier-print"
if (-not (Test-Path $cashierEnv)) {
  Write-Host "Missing .env.cashier-print — copy .env.cashier-print.example and set RECEIPT_PRINTER and RECEIPT_PRINT_ALLOWED_ORIGINS." -ForegroundColor Red
  exit 1
}

function Read-DotEnvValue([string]$path, [string]$key) {
  foreach ($line in Get-Content -LiteralPath $path) {
    $trim = $line.Trim()
    if (-not $trim -or $trim.StartsWith("#")) { continue }
    if ($trim -match ("^\s*" + [regex]::Escape($key) + "\s*=\s*(.*)$")) {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return ""
}

$printer = Read-DotEnvValue $cashierEnv "RECEIPT_PRINTER"
$origins = Read-DotEnvValue $cashierEnv "RECEIPT_PRINT_ALLOWED_ORIGINS"
if (-not $printer) {
  Write-Host "RECEIPT_PRINTER is required in .env.cashier-print (exact Windows printer name)." -ForegroundColor Red
  exit 1
}
if (-not $origins) {
  Write-Host "RECEIPT_PRINT_ALLOWED_ORIGINS is required in .env.cashier-print (POS origin, e.g. http://192.168.1.10:3000)." -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path "data" | Out-Null
$pidFile = Join-Path (Get-Location) "data\receipt-print-dialog-helper.pid"
$outFile = Join-Path (Get-Location) "data\receipt-print-dialog-helper.out.log"
$errFile = Join-Path (Get-Location) "data\receipt-print-dialog-helper.err.log"

if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Host "Receipt print helper already running (PID $oldPid)" -ForegroundColor DarkGray
    return
  }
}

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
  Write-Host "Receipt print helper listening on http://127.0.0.1:17892 (PID $($proc.Id))" -ForegroundColor Green
} catch {
  Write-Host "Helper started (PID $($proc.Id)) but health check failed. See data/receipt-print-dialog-helper.err.log" -ForegroundColor Yellow
}
