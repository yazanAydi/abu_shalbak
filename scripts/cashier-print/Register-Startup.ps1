# Start the helper at Windows sign-in for the signed-in cashier user.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir
)

$taskName = "AboShalbakReceiptPrintDialogHelper"
$startScript = Join-Path $InstallDir "Start-Helper.ps1"
if (-not (Test-Path -LiteralPath $startScript)) { throw "Missing $startScript" }

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -InstallDir `"$InstallDir`"" `
  -WorkingDirectory $InstallDir
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
  -Description "Print Abo Shalbak POS receipts on this cashier PC (127.0.0.1:17892)" `
  -Force | Out-Null
