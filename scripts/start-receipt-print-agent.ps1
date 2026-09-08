# Start the Windows silent receipt print agent (localhost :17891)
Set-Location $PSScriptRoot\..

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is required for silent receipt printing. Install Node.js LTS, then run start-store.ps1 again." -ForegroundColor Yellow
  Write-Host "Sales will still save; ترحيل will show an Arabic print error until the agent is running." -ForegroundColor DarkGray
  return
}

New-Item -ItemType Directory -Force -Path "data" | Out-Null
$pidFile = Join-Path (Get-Location) "data\receipt-print-agent.pid"
$outFile = Join-Path (Get-Location) "data\receipt-print-agent.out.log"
$errFile = Join-Path (Get-Location) "data\receipt-print-agent.err.log"

if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Host "Receipt print agent already running (PID $oldPid)" -ForegroundColor DarkGray
    return
  }
}

$env:ABO_ENV = "store"
$proc = Start-Process -FilePath $node.Source `
  -ArgumentList "backend/scripts/receipt-print-agent.mjs" `
  -WorkingDirectory (Get-Location) `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outFile `
  -RedirectStandardError $errFile `
  -PassThru
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

Start-Sleep -Seconds 1
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:17891/health" -TimeoutSec 3 | Out-Null
  Write-Host "Receipt print agent listening on http://127.0.0.1:17891 (PID $($proc.Id))" -ForegroundColor Green
} catch {
  Write-Host "Receipt print agent started (PID $($proc.Id)) but health check failed. See data/receipt-print-agent.err.log" -ForegroundColor Yellow
}
