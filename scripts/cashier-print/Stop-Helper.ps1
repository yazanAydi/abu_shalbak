# Stop only this install's receipt helper. A missing or invalid pid is success.
param(
  [string]$InstallDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "HelperProcess.ps1")

if (-not (Test-Path -LiteralPath $InstallDir)) {
  throw "Install directory not found: $InstallDir"
}

Write-ReceiptHelperLog $InstallDir "INFO" "stop: begin install=$InstallDir"
Stop-InstalledReceiptHelpers $InstallDir
