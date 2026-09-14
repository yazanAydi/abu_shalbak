# Double-click installer for the cashier receipt helper.
# Does not print a receipt. Success = helper health, not paper.
param(
  [string]$InstallDir = $(Join-Path $env:LOCALAPPDATA "AboShalbak\ReceiptPrint"),
  [string]$PrinterName = "",
  [string]$PosUrl = "",
  [switch]$NonInteractive,
  [switch]$SkipStartup,
  [switch]$TestSave
)

$ErrorActionPreference = "Stop"
$SourceRoot = $PSScriptRoot
$expectedVersion = (Get-Content -LiteralPath (Join-Path $SourceRoot "VERSION") -Raw).Trim()
$nodeSrc = Join-Path $SourceRoot "runtime\node\node.exe"
$writeEnv = Join-Path $SourceRoot "backend\scripts\write-cashier-print-env.mjs"

function Get-ReceiptPrinters {
  $virtual = "PDF|XPS|OneNote|Fax|Snagit"
  Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop |
    Where-Object { $_.Name -and $_.Name -notmatch $virtual } |
    Sort-Object Name |
    Select-Object -ExpandProperty Name
}

function Get-ExistingPosUrl([string]$dir) {
  $envFile = Join-Path $dir ".env.cashier-print"
  if (-not (Test-Path -LiteralPath $envFile)) { return "" }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*RECEIPT_PRINT_POS_URL\s*=\s*(.*)$") { return $Matches[1].Trim() }
    if ($line -match "^\s*RECEIPT_PRINT_ALLOWED_ORIGINS\s*=\s*(.*)$") {
      $origin = $Matches[1].Trim()
      if ($origin) { return "$origin/pos" }
    }
  }
  return ""
}

function Get-ExistingPrinter([string]$dir) {
  $envFile = Join-Path $dir ".env.cashier-print"
  if (-not (Test-Path -LiteralPath $envFile)) { return "" }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*RECEIPT_PRINTER\s*=\s*(.*)$") { return $Matches[1].Trim() }
  }
  return ""
}

function Get-ExistingTestSave([string]$dir) {
  $envFile = Join-Path $dir ".env.cashier-print"
  if (-not (Test-Path -LiteralPath $envFile)) { return $false }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*RECEIPT_PRINT_TEST_MODE\s*=\s*(.*)$") {
      return $Matches[1].Trim().ToLower() -eq "save"
    }
  }
  return $false
}

function Show-Wizard([string[]]$printers, [string]$defaultPrinter, [string]$defaultUrl, [bool]$defaultTestSave) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "أبو شلبك — تثبيت طباعة الإيصالات"
  $form.RightToLeft = "Yes"
  $form.RightToLeftLayout = $true
  $form.Width = 560
  $form.Height = 400
  $form.StartPosition = "CenterScreen"
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false

  $lblP = New-Object System.Windows.Forms.Label
  $lblP.Text = "طابعة الإيصالات"
  $lblP.Left = 20
  $lblP.Top = 20
  $lblP.Width = 500
  $form.Controls.Add($lblP)

  $combo = New-Object System.Windows.Forms.ComboBox
  $combo.DropDownStyle = "DropDownList"
  $combo.Left = 20
  $combo.Top = 48
  $combo.Width = 500
  foreach ($p in $printers) { [void]$combo.Items.Add($p) }
  if ($defaultPrinter -and $combo.Items.Contains($defaultPrinter)) {
    $combo.SelectedItem = $defaultPrinter
  } elseif ($combo.Items.Count -gt 0) {
    $combo.SelectedIndex = 0
  }
  $form.Controls.Add($combo)

  $lblU = New-Object System.Windows.Forms.Label
  $lblU.Text = "عنوان نقطة البيع (مثال: http://192.168.1.10:3000/pos)"
  $lblU.Left = 20
  $lblU.Top = 96
  $lblU.Width = 500
  $form.Controls.Add($lblU)

  $box = New-Object System.Windows.Forms.TextBox
  $box.Left = 20
  $box.Top = 124
  $box.Width = 500
  $box.Text = $defaultUrl
  $form.Controls.Add($box)

  $hint = New-Object System.Windows.Forms.Label
  $hint.Left = 20
  $hint.Top = 160
  $hint.Width = 500
  $hint.Height = 40
  $form.Controls.Add($hint)

  $chk = New-Object System.Windows.Forms.CheckBox
  $chk.Text = "اختبار بدون طابعة — حفظ PDF"
  $chk.Left = 20
  $chk.Top = 208
  $chk.Width = 500
  $chk.Checked = $defaultTestSave
  $form.Controls.Add($chk)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = "تثبيت"
  $ok.Left = 300
  $ok.Top = 300
  $ok.Width = 100
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Controls.Add($ok)
  $form.AcceptButton = $ok

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "إلغاء"
  $cancel.Left = 420
  $cancel.Top = 300
  $cancel.Width = 100
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($cancel)
  $form.CancelButton = $cancel

  $syncWizard = {
    $ok.Enabled = $chk.Checked -or ($combo.Items.Count -gt 0)
    if ($chk.Checked) {
      $hint.Text = "وضع اختبار: بدون طابعة. الإيصالات تُحفظ PDF ولن تُرسل مهمة طباعة إلى ويندوز."
    } elseif (-not $printers.Count) {
      $hint.Text = "لم يتم العثور على طابعة إيصالات في ويندوز. ثبّت تعريف RONGTA أو فعّل الاختبار بدون طابعة."
    } else {
      $hint.Text = "التثبيت الناجح يعني أن المساعد يعمل. لا يعني أن الورق طُبع."
    }
  }
  $chk.add_CheckedChanged($syncWizard)
  & $syncWizard

  if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    return $null
  }
  return @{
    Printer = [string]$combo.SelectedItem
    PosUrl = [string]$box.Text.Trim()
    TestSave = [bool]$chk.Checked
  }
}

function Copy-HelperPayload([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  $fromFull = [IO.Path]::GetFullPath($from).TrimEnd("\")
  $toFull = [IO.Path]::GetFullPath($to).TrimEnd("\")
  if ($fromFull -eq $toFull) { return }
  $args = @(
    $from, $to, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np",
    "/XD", "data",
    "/XF", ".env.cashier-print"
  )
  & robocopy @args | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "Failed to copy helper files (robocopy $code)" }
}

function Wait-HelperHealth([string]$version, [int]$seconds = 20) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $last = Invoke-RestMethod -Uri "http://127.0.0.1:17892/health" -TimeoutSec 2
      if ($last.ok -and $last.version -eq $version) { return $last }
    } catch {
      $last = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 400
  }
  throw "Helper health/version mismatch. expected=$version got=$($last | ConvertTo-Json -Compress)"
}

if (-not (Test-Path -LiteralPath $nodeSrc)) {
  throw "This folder is incomplete (missing bundled Node). Copy the full AboShalbak-ReceiptPrint folder."
}
if (-not (Test-Path -LiteralPath $writeEnv)) {
  throw "This folder is incomplete (missing write-cashier-print-env.mjs)."
}

$printers = @(Get-ReceiptPrinters)
if (-not $printers.Count -and $NonInteractive -and -not $TestSave) {
  throw "No receipt printers were found in Windows. Install the RONGTA driver first."
}

if (-not $NonInteractive) {
  $choice = Show-Wizard $printers (Get-ExistingPrinter $InstallDir) $(
    if ($PosUrl) { $PosUrl } else { Get-ExistingPosUrl $InstallDir }
  ) (Get-ExistingTestSave $InstallDir)
  if (-not $choice) { exit 1 }
  $PrinterName = $choice.Printer
  $PosUrl = $choice.PosUrl
  $TestSave = $choice.TestSave
} else {
  if (-not $PosUrl) { $PosUrl = Get-ExistingPosUrl $InstallDir }
  if (-not $TestSave) {
    if (-not $PrinterName) { $PrinterName = Get-ExistingPrinter $InstallDir }
    if (-not $PrinterName -or -not $PosUrl) {
      throw "NonInteractive install requires -PrinterName and -PosUrl (or an existing .env.cashier-print)."
    }
  } elseif (-not $PosUrl) {
    throw "NonInteractive test-save install requires -PosUrl."
  }
}

if (-not $TestSave) {
  if ($printers -notcontains $PrinterName) {
    throw "Printer '$PrinterName' is not an installed receipt printer."
  }
}

Write-Host "Installing helper to $InstallDir" -ForegroundColor DarkGray
Copy-HelperPayload $SourceRoot $InstallDir

& (Join-Path $SourceRoot "Stop-Helper.ps1") -InstallDir $InstallDir

$envFile = Join-Path $InstallDir ".env.cashier-print"
$writeArgs = @($writeEnv, "--file", $envFile, "--pos-url", $PosUrl)
if ($PrinterName) { $writeArgs += @("--printer", $PrinterName) }
if ($TestSave) { $writeArgs += "--test-save" }
& $nodeSrc @writeArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to save printer / POS URL." }

if (-not $SkipStartup) {
  & (Join-Path $InstallDir "Register-Startup.ps1") -InstallDir $InstallDir
}
& (Join-Path $InstallDir "Start-Helper.ps1") -InstallDir $InstallDir | Out-Null
Start-Sleep -Seconds 1
$health = Wait-HelperHealth $expectedVersion

if ($health.testMode) {
  $summary = @"
وضع اختبار بدون طابعة — حفظ PDF (ليس طباعة ورق)

المساعد يعمل على http://127.0.0.1:17892
الإصدار: $($health.version)
مجلد ملفات PDF: $($health.pdfDir)
الأصل المسموح: $($health.allowedOrigins -join ', ')

لا تُرسل مهمة طباعة إلى ويندوز. افتح المجلد أعلاه بعد حفظ إيصال.
"@
} else {
  $summary = @"
المساعد يعمل على http://127.0.0.1:17892
الإصدار: $($health.version)
الطابعة: $($health.printer)
الأصل المسموح: $($health.allowedOrigins -join ', ')
وضع التجربة (PDF): $($health.testMode)

هذا لا يعني أن الورقة طُبعت. أعد طباعة إيصال محفوظ للتجربة.
"@
}

Write-Host $summary -ForegroundColor Green
if (-not $NonInteractive) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($summary, "أبو شلبك — طباعة الإيصالات") | Out-Null
}
