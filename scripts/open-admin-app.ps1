# Open office admin as a Chromium app window with DevTools disabled.
# A normal Edge/Chrome "Install as app" shortcut still allows F12, so a
# barcode scanner suffix opens the Console over the page.
#
# Store:  .\scripts\open-admin-app.ps1
# Dev:    .\scripts\open-admin-app.ps1 -Url http://127.0.0.1:3001/admin
# Pin:    .\scripts\open-admin-app.ps1 -CreateShortcut
param(
  [string]$Url = "http://127.0.0.1:3000/admin",
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
    "--disable-dev-tools",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=$ProfileDir",
    "--app=$AppUrl"
  )
}

if ($Url -notmatch '^https?://') {
  Write-Host "Invalid -Url. Use an http(s) admin address, e.g. http://127.0.0.1:3000/admin" -ForegroundColor Red
  exit 1
}

$browser = Resolve-ChromiumBrowser
if (-not $browser) {
  Write-Host "Edge or Chrome was not found. Install Microsoft Edge or Google Chrome, then run this script again." -ForegroundColor Red
  exit 1
}

$profileDir = Join-Path $env:LOCALAPPDATA "AboShalbak\admin-app"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$browserArgs = Get-BrowserArgs -AppUrl $Url -ProfileDir $profileDir

if ($CreateShortcut) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shortcutPath = Join-Path $desktop "AboShalbak-Admin.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $browser
  $shortcut.Arguments = ($browserArgs | ForEach-Object {
    if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ }
  }) -join " "
  $shortcut.WorkingDirectory = Split-Path -Parent $browser
  $shortcut.WindowStyle = 1
  $shortcut.Description = "Open admin as an app (DevTools disabled so barcode scan cannot open the Console)"
  $shortcut.Save()
  Write-Host "Shortcut created: $shortcutPath" -ForegroundColor Green
  Write-Host "Use this shortcut only. Uninstall the old Edge/Chrome 'installed app' if it still opens the Console." -ForegroundColor DarkGray
  exit 0
}

Write-Host "Opening admin app in $browser" -ForegroundColor Green
Write-Host $Url -ForegroundColor DarkGray
Start-Process -FilePath $browser -ArgumentList $browserArgs
