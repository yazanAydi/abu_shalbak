# Obsolete name kept so older docs still work. POS receipts print from the cashier
# Edge window (policies), not from --kiosk-printing or the Windows print agent.
# Prefer: .\scripts\open-pos-app.ps1
param(
  [string]$Url = "http://127.0.0.1:3000/pos",
  [switch]$CreateShortcut,
  [switch]$OpenPolicy,
  [switch]$Inspect
)

$next = Join-Path $PSScriptRoot "open-pos-app.ps1"
$argsList = @("-Url", $Url)
if ($CreateShortcut) { $argsList += "-CreateShortcut" }
if ($OpenPolicy) { $argsList += "-OpenPolicy" }
if ($Inspect) { $argsList += "-Inspect" }
& $next @argsList
exit $LASTEXITCODE
