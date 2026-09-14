# One-shot UI Automation confirm for an armed POS receipt Print dialog.
# No coordinates, no Enter, no timer-click. Invoke the enabled Print button
# only when the owner process and exact printer name match.
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$OwnerPids,
  [Parameter(Mandatory = $true)][string]$RequestId,
  [int]$TimeoutMs = 12000
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$ownerSet = @{}
foreach ($part in ($OwnerPids -split ",")) {
  $n = 0
  if ([int]::TryParse($part.Trim(), [ref]$n) -and $n -gt 0) {
    $ownerSet[$n] = $true
  }
}

function Get-ProcessIdFromElement([System.Windows.Automation.AutomationElement]$el) {
  if (-not $el) { return 0 }
  try { return [int]$el.Current.ProcessId } catch { return 0 }
}

function Test-DialogName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return $false }
  return $name -match '^(Print|طباعة)(\s+Dialog)?$'
}

function Test-PrintButtonName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return $false }
  return $name -match '^(Print|&Print|طباعة)$'
}

function Get-SelectedPrinter([System.Windows.Automation.AutomationElement]$root) {
  $comboCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ComboBox
  )
  $combos = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $comboCond)
  foreach ($combo in $combos) {
    $name = ""
    try { $name = [string]$combo.Current.Name } catch { $name = "" }
    $value = ""
    try {
      $vp = $combo.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { $value = [string]$vp.Current.Value }
    } catch { }
    if ($value -eq $PrinterName) { return $value }
    if ($name -eq $PrinterName) { return $name }
  }
  $textCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text
  )
  $texts = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
  foreach ($t in $texts) {
    try {
      if ([string]$t.Current.Name -eq $PrinterName) { return $PrinterName }
    } catch { }
  }
  return ""
}

function Find-PrintButton([System.Windows.Automation.AutomationElement]$root) {
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
  foreach ($btn in $buttons) {
    $name = ""
    try { $name = [string]$btn.Current.Name } catch { $name = "" }
    if (Test-PrintButtonName $name) { return $btn }
  }
  return $null
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$result = [ordered]@{
  invoked = $false
  requestId = $RequestId
  dialogName = $null
  dialogPrinterName = $null
  dialogProcessId = 0
  dialogOwnerProcessId = 0
  printButtonEnabled = $false
  reason = "not-found"
}

while ([DateTime]::UtcNow -lt $deadline) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $winCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
  )
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
  foreach ($win in $windows) {
    $dlgName = ""
    try { $dlgName = [string]$win.Current.Name } catch { continue }
    if (-not (Test-DialogName $dlgName)) { continue }
    $pid = Get-ProcessIdFromElement $win
    if (-not $ownerSet.ContainsKey($pid)) { continue }
    $shown = Get-SelectedPrinter $win
    $btn = Find-PrintButton $win
    $enabled = $false
    if ($btn) {
      try { $enabled = [bool]$btn.Current.IsEnabled } catch { $enabled = $false }
    }
    $result.dialogName = $dlgName
    $result.dialogPrinterName = $shown
    $result.dialogProcessId = $pid
    $result.dialogOwnerProcessId = $pid
    $result.printButtonEnabled = $enabled
    if ($shown -ne $PrinterName) {
      $result.reason = "printer-mismatch"
      continue
    }
    if (-not $enabled -or -not $btn) {
      $result.reason = "print-disabled"
      continue
    }
    $invoke = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    $result.invoked = $true
    $result.reason = "ok"
    $result | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 200
}

$result | ConvertTo-Json -Compress
exit 0
