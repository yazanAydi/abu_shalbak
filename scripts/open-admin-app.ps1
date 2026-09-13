# Open office admin/accountant as a Microsoft Edge app window.
# Admin and accountant use the same /admin app (role is decided after login).
#
# This is Edge --app with a dedicated profile, not Chrome and not an
# Install-as-app PWA. Inspect an existing .lnk with:
#   .\scripts\open-pos-app.ps1 -Inspect
#
# Barcode scanners that send F12 still open DevTools in Chromium. Do not rely on
# --disable-dev-tools. Configure the scanner terminator to Enter (see docs/BARCODE_SCANNER.md).
#
# Store (shop server):  .\scripts\open-admin-app.ps1 -CreateShortcut
# Office PC on LAN:     .\scripts\open-admin-app.ps1 -Url http://192.168.1.10:3000/admin -CreateShortcut
param(
  [string]$Url = "http://127.0.0.1:3000/admin",
  [switch]$CreateShortcut
)

$ErrorActionPreference = "Stop"

function Resolve-EdgeExe {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

function Get-BrowserArgs([string]$AppUrl, [string]$ProfileDir) {
  return @(
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=$ProfileDir",
    "--app=$AppUrl"
  )
}

if ($Url -notmatch '^https?://') {
  Write-Host "Invalid -Url. Use an http(s) admin address, e.g. http://192.168.1.10:3000/admin" -ForegroundColor Red
  exit 1
}

$browser = Resolve-EdgeExe
if (-not $browser) {
  Write-Host "Microsoft Edge was not found. Install Edge and recreate the office shortcut. A Chrome or PWA shortcut is a different app and will not match this setup." -ForegroundColor Red
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
  $shortcut.Description = "Abu Shalbak office (admin and accountant). Edge app window for /admin."
  $shortcut.Save()
  Write-Host "Shortcut created: $shortcutPath" -ForegroundColor Green
  Write-Host "Use this shortcut for both admin and accountant. Uninstall any old Edge/Chrome installed app / PWA if it is still on the desktop." -ForegroundColor DarkGray
  Write-Host "This does not disable DevTools. If a scan opens the Console, set the scanner suffix to Enter. See docs/BARCODE_SCANNER.md" -ForegroundColor DarkGray
  exit 0
}

Write-Host "Opening office app in Microsoft Edge" -ForegroundColor Green
Write-Host $Url -ForegroundColor DarkGray
Start-Process -FilePath $browser -ArgumentList $browserArgs
