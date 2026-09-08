# Stop the Windows silent receipt print agent
Set-Location $PSScriptRoot\..

$pidFile = Join-Path (Get-Location) "data\receipt-print-agent.pid"
if (Test-Path $pidFile) {
  $agentPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($agentPid) {
    Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*receipt-print-agent.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "Receipt print agent stopped." -ForegroundColor DarkGray
