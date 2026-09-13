Set-Location $PSScriptRoot\..
$pidFile = Join-Path (Get-Location) "data\receipt-print-dialog-helper.pid"
if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($oldPid) {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*receipt-print-dialog-helper.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Receipt print dialog helper stopped." -ForegroundColor Green
