# Obsolete for POS receipts: checkout uses the Windows print agent / silent API.
# Start the shop with npm run store:up (Docker + receipt-print-agent).
# Store:  .\scripts\open-pos-silent-print.ps1
# Dev:    .\scripts\open-pos-silent-print.ps1 -Url http://127.0.0.1:3002/pos
# Pin:    .\scripts\open-pos-silent-print.ps1 -CreateShortcut
param(
  [string]$Url = "http://127.0.0.1:3000/pos",
  [switch]$CreateShortcut
)

$ErrorActionPreference = "Stop"

function Resolve-ChromiumBrowser {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }
  return $null
}

function Get-BrowserArgs([string]$AppUrl, [string]$ProfileDir) {
  return @(
    "--kiosk-printing",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=$ProfileDir",
    "--app=$AppUrl"
  )
}

if ($Url -notmatch '^https?://') {
  Write-Host "Invalid -Url. Use an http(s) POS address, e.g. http://127.0.0.1:3000/pos" -ForegroundColor Red
  exit 1
}

$browser = Resolve-ChromiumBrowser
if (-not $browser) {
  Write-Host "Edge or Chrome was not found. Install Microsoft Edge or Google Chrome, then run this script again." -ForegroundColor Red
  exit 1
}

$profileDir = Join-Path $env:LOCALAPPDATA "AboShalbak\pos-silent-print"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$browserArgs = Get-BrowserArgs -AppUrl $Url -ProfileDir $profileDir

try {
  $defaultPrinter = Get-CimInstance -ClassName Win32_Printer -Filter "Default=True" -ErrorAction Stop |
    Select-Object -First 1
  if ($defaultPrinter -and $defaultPrinter.Name -match "PDF|XPS|OneNote|Fax") {
    Write-Host "Default printer is '$($defaultPrinter.Name)'." -ForegroundColor Yellow
    Write-Host "Set the receipt / thermal printer as the Windows default, or print will ask where to save." -ForegroundColor Yellow
  }
} catch {
  # Printer query is best-effort; still open POS.
}

if ($CreateShortcut) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shortcutPath = Join-Path $desktop "POS - silent print.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $browser
  $shortcut.Arguments = ($browserArgs | ForEach-Object {
    if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ }
  }) -join " "
  $shortcut.WorkingDirectory = Split-Path -Parent $browser
  $shortcut.WindowStyle = 1
  $shortcut.Description = "Open POS with automatic receipt printing (no print dialog)"
  $shortcut.Save()
  Write-Host "Shortcut created: $shortcutPath" -ForegroundColor Green
  Write-Host "Open POS only from this shortcut so receipts print without the browser dialog." -ForegroundColor DarkGray
  exit 0
}

Write-Host "Opening POS (silent print) in $browser" -ForegroundColor Green
Write-Host $Url -ForegroundColor DarkGray
Start-Process -FilePath $browser -ArgumentList $browserArgs
