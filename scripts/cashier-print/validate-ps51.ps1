# ASCII-only. Parse scripts with Windows PowerShell 5.1 (not PowerShell 7).
param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$Path
)

$ErrorActionPreference = "Stop"
$failed = $false
foreach ($p in $Path) {
  $full = [System.IO.Path]::GetFullPath($p)
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) {
    Write-Host "PARSE FAIL $full"
    foreach ($err in $errors) {
      Write-Host ("  " + $err.ToString())
    }
    $failed = $true
  } else {
    Write-Host "PARSE OK $full"
  }
}
if ($failed) { exit 1 }
exit 0
