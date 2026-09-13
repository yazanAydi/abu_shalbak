# Legacy: no longer called from store startup. POS prints from the cashier Edge window.
# Register the receipt print agent to start when the shop user signs in.
# Printers are per-user, so this is ONLOGON (not a SYSTEM Windows service).
Set-Location $PSScriptRoot\..

$taskName = "AboShalbakReceiptPrintAgent"
$startScript = Join-Path (Get-Location) "scripts\start-receipt-print-agent.ps1"
if (-not (Test-Path $startScript)) {
  Write-Host "Missing $startScript" -ForegroundColor Red
  exit 1
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`"" `
  -WorkingDirectory (Get-Location)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Silent thermal receipt print agent for Abo Shalbak POS" `
  -Force | Out-Null

Write-Host "Windows will start the print agent at sign-in (task $taskName)." -ForegroundColor Green
