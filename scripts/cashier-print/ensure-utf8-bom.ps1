# ASCII-only. Rewrite files as UTF-8 with BOM for Windows PowerShell 5.1.
param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$Path
)

$ErrorActionPreference = "Stop"
$utf8Bom = New-Object System.Text.UTF8Encoding $true

function Convert-ToUtf8Bom([string]$file) {
  $full = [System.IO.Path]::GetFullPath($file)
  if (-not [System.IO.File]::Exists($full)) {
    throw "Missing $full"
  }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $text = $null
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $text = $utf8Bom.GetString($bytes, 3, $bytes.Length - 3)
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    $text = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  } else {
    $text = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
  }
  [System.IO.File]::WriteAllText($full, $text, $utf8Bom)
}

foreach ($p in $Path) {
  Convert-ToUtf8Bom $p
}
