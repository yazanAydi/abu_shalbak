# Start the helper at Windows sign-in for the signed-in cashier user.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$TaskName = "AboShalbakReceiptPrintDialogHelper"
)

$taskName = $TaskName
. (Join-Path $PSScriptRoot "HelperProcess.ps1")
$listenPort = Get-ReceiptHelperPort -InstallDir $InstallDir
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

$before = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Print Abo Shalbak POS receipts on this cashier PC (127.0.0.1:$listenPort)" `
  -Force | Out-Null
$after = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
if ($after.Count -ne 1) {
  throw "Expected one scheduled task named $taskName, found $($after.Count)."
}
if ($before.Count -ge 1) {
  Write-Host "Updated existing sign-in task $taskName."
} else {
  Write-Host "Registered sign-in task $taskName."
}
