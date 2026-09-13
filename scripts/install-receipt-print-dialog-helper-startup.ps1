# Start the cashier print-dialog helper at Windows sign-in (same user as the POS).
Set-Location $PSScriptRoot\..

$taskName = "AboShalbakReceiptPrintDialogHelper"
$startScript = Join-Path (Get-Location) "scripts\start-receipt-print-dialog-helper.ps1"
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
  -Description "Arm-and-confirm Windows Print dialog for Abo Shalbak POS receipts" `
  -Force | Out-Null

Write-Host "Windows will start the receipt print dialog helper at sign-in (task $taskName)." -ForegroundColor Green
