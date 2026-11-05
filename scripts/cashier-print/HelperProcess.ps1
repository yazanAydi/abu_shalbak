# Shared process cleanup for the cashier receipt helper.
# Never pass raw pid-file text to Stop-Process / Get-Process -Id.
# Only node.exe whose command line is this install's helper may be stopped.

function Write-ReceiptHelperLog([string]$InstallDir, [string]$Level, [string]$Message) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}" -f (Get-Date), $Level, $Message
  Write-Host $line
  try {
    $dir = Join-Path $InstallDir "data"
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $path = Join-Path $dir "receipt-print-helper-startup.log"
    Add-Content -LiteralPath $path -Value $line -Encoding utf8
  } catch {
    Write-Host ("{0:yyyy-MM-dd HH:mm:ss} [WARN] could not write startup log: {1}" -f (Get-Date), $_.Exception.Message)
  }
}

function Format-PidFileText([string]$Text) {
  if (-not $Text) { return "" }
  $shown = ($Text -replace "[\r\n]+", " ").Trim()
  if ($shown.Length -gt 80) { return $shown.Substring(0, 80) + "..." }
  return $shown
}

function Read-ReceiptHelperPidFile([string]$InstallDir) {
  $pidFile = Join-Path $InstallDir "data\receipt-print-dialog-helper.pid"
  $result = [pscustomobject]@{
    Path = $pidFile
    Exists = $false
    Status = "missing"
    ProcessId = 0
    Text = ""
  }
  if (-not (Test-Path -LiteralPath $pidFile)) { return $result }
  $result.Exists = $true
  $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
  $text = ""
  if ($null -ne $raw) {
    $text = ([string]$raw).Trim().Trim([char]0).Trim()
  }
  $result.Text = $text
  if (-not $text) {
    $result.Status = "empty"
    return $result
  }
  $parsed = 0
  if (-not [int]::TryParse($text, [ref]$parsed) -or $parsed -le 0) {
    $result.Status = "invalid"
    return $result
  }
  $result.Status = "ok"
  $result.ProcessId = $parsed
  return $result
}

function Test-ReceiptHelperCommandLine([string]$CommandLine, [string]$InstallDir) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  if ($CommandLine.IndexOf("receipt-print-dialog-helper.mjs", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    return $false
  }
  $root = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd("\")
  if ($CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  $forward = $root.Replace("\", "/")
  if ($CommandLine.IndexOf($forward, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  return $false
}

function Get-ReceiptHelperProcessIds([string]$InstallDir) {
  $nodes = @()
  try {
    $nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)
  } catch {
    Write-ReceiptHelperLog $InstallDir "WARN" "could not query node processes: $($_.Exception.Message)"
    return
  }
  foreach ($node in $nodes) {
    $cmd = ""
    try { $cmd = [string]$node.CommandLine } catch { $cmd = "" }
    if (-not (Test-ReceiptHelperCommandLine $cmd $InstallDir)) { continue }
    $parsed = 0
    $rawId = ""
    if ($null -ne $node.ProcessId) { $rawId = ([string]$node.ProcessId).Trim() }
    if (-not [int]::TryParse($rawId, [ref]$parsed) -or $parsed -le 0) {
      Write-ReceiptHelperLog $InstallDir "WARN" "ignored a node process because its process id was not an integer"
      continue
    }
    $parsed
  }
}

function Get-ReceiptHelperPort {
  $parsed = 0
  $raw = [string]$env:RECEIPT_PRINT_DIALOG_HELPER_PORT
  if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) {
    return $parsed
  }
  return 17892
}

function Write-ReceiptHelperPidFile([string]$InstallDir, [int]$ProcessId) {
  $dir = Join-Path $InstallDir "data"
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $path = Join-Path $dir "receipt-print-dialog-helper.pid"
  Set-Content -LiteralPath $path -Value $ProcessId -Encoding ascii
}

function Stop-ReceiptHelperById([string]$InstallDir, [int]$ProcessId, [string]$Reason) {
  if ($ProcessId -le 0) { return $false }
  if ($ProcessId -eq $PID) {
    Write-ReceiptHelperLog $InstallDir "WARN" "refusing to stop the current PowerShell process $ProcessId"
    return $false
  }
  $cim = $null
  try {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue | Select-Object -First 1
  } catch {
    $cim = $null
  }
  if (-not $cim) {
    Write-ReceiptHelperLog $InstallDir "INFO" "pid $ProcessId is not running ($Reason)"
    return $false
  }
  $name = [string]$cim.Name
  $cmd = ""
  try { $cmd = [string]$cim.CommandLine } catch { $cmd = "" }
  if ($name -ne "node.exe" -or -not (Test-ReceiptHelperCommandLine $cmd $InstallDir)) {
    Write-ReceiptHelperLog $InstallDir "WARN" "pid $ProcessId is $name, not this receipt helper; left running ($Reason)"
    return $false
  }
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    Write-ReceiptHelperLog $InstallDir "INFO" "stopped receipt helper pid $ProcessId ($Reason)"
    return $true
  } catch {
    $stopMessage = $_.Exception.Message
    if ($stopMessage -match "Cannot find a process") {
      Write-ReceiptHelperLog $InstallDir "INFO" "pid $ProcessId was already gone ($Reason)"
      return $false
    }
    Write-ReceiptHelperLog $InstallDir "ERROR" "FAILURE could not stop receipt helper pid ${ProcessId}: $stopMessage"
    return $false
  }
}

function Wait-ReceiptHelpersExited([string]$InstallDir) {
  $deadline = (Get-Date).AddSeconds(8)
  do {
    $left = @(Get-ReceiptHelperProcessIds $InstallDir)
    if ($left.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  $still = @(Get-ReceiptHelperProcessIds $InstallDir)
  if ($still.Count -eq 0) { return $true }
  Write-ReceiptHelperLog $InstallDir "ERROR" ("FAILURE receipt helper still running after stop: {0}" -f ($still -join ","))
  return $false
}

function Stop-InstalledReceiptHelpers([string]$InstallDir) {
  $stopped = 0
  $record = Read-ReceiptHelperPidFile $InstallDir
  if ($record.Status -eq "missing") {
    Write-ReceiptHelperLog $InstallDir "INFO" "no pid file; no recorded helper instance"
  } elseif ($record.Status -eq "empty") {
    Write-ReceiptHelperLog $InstallDir "INFO" "pid file is empty; no previous helper instance"
  } elseif ($record.Status -eq "invalid") {
    Write-ReceiptHelperLog $InstallDir "WARN" ("pid file is not a process id ({0}); ignoring it" -f (Format-PidFileText $record.Text))
  } else {
    if (Stop-ReceiptHelperById $InstallDir $record.ProcessId "pid file") { $stopped++ }
  }
  if ($record.Exists) {
    Remove-Item -LiteralPath $record.Path -Force -ErrorAction SilentlyContinue
  }

  $found = @(Get-ReceiptHelperProcessIds $InstallDir)
  if ($found.Count -eq 0) {
    Write-ReceiptHelperLog $InstallDir "INFO" "no running receipt helper for this install"
  }
  foreach ($id in $found) {
    if (Stop-ReceiptHelperById $InstallDir ([int]$id) "command line") { $stopped++ }
  }
  if (-not (Wait-ReceiptHelpersExited $InstallDir)) {
    throw "A receipt helper process for this install is still running."
  }
  if ($stopped -eq 0) {
    Write-ReceiptHelperLog $InstallDir "INFO" "SUCCESS no previous receipt helper instance to stop"
  } else {
    Write-ReceiptHelperLog $InstallDir "INFO" "SUCCESS stopped $stopped receipt helper process(es)"
  }
}

function Find-RunningReceiptHelper([string]$InstallDir) {
  $record = Read-ReceiptHelperPidFile $InstallDir
  $found = @(Get-ReceiptHelperProcessIds $InstallDir)

  if ($record.Status -eq "invalid") {
    Write-ReceiptHelperLog $InstallDir "WARN" ("pid file is not a process id ({0}); ignoring it" -f (Format-PidFileText $record.Text))
  } elseif ($record.Status -eq "ok") {
    $matched = $false
    foreach ($id in $found) {
      if ([int]$id -eq $record.ProcessId) { $matched = $true }
    }
    if ($matched) { return $record.ProcessId }
    $other = $null
    try { $other = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue } catch { $other = $null }
    if ($other) {
      Write-ReceiptHelperLog $InstallDir "WARN" "pid $($record.ProcessId) is $($other.ProcessName), not this receipt helper; left running"
    } else {
      Write-ReceiptHelperLog $InstallDir "INFO" "stale pid $($record.ProcessId) is not running"
    }
  }

  if ($found.Count -gt 0) { return [int]$found[0] }

  if ($record.Status -eq "missing") {
    Write-ReceiptHelperLog $InstallDir "INFO" "no previous receipt helper instance"
  } elseif ($record.Status -eq "empty") {
    Write-ReceiptHelperLog $InstallDir "INFO" "pid file is empty; no previous receipt helper instance"
  }
  return 0
}

function Wait-ReceiptHelperHealth([string]$InstallDir, [int]$ProcessId, $Process, [int]$Port) {
  $deadline = (Get-Date).AddSeconds(12)
  $uri = "http://127.0.0.1:$Port/health"
  while ((Get-Date) -lt $deadline) {
    if ($Process) {
      try { $Process.Refresh() } catch { }
      if ($Process.HasExited) {
        Write-ReceiptHelperLog $InstallDir "ERROR" "FAILURE helper process $ProcessId exited (code $($Process.ExitCode)) before it accepted connections. See data\receipt-print-dialog-helper.err.log"
        return $false
      }
    }
    try {
      $health = Invoke-RestMethod -Uri $uri -TimeoutSec 2
      if ($health.ok) {
        Write-ReceiptHelperLog $InstallDir "INFO" "SUCCESS helper listening on $uri pid=$ProcessId version=$($health.version)"
        return $true
      }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  Write-ReceiptHelperLog $InstallDir "ERROR" "FAILURE helper pid $ProcessId did not answer $uri. See data\receipt-print-dialog-helper.err.log"
  return $false
}
