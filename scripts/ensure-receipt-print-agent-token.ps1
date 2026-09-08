# Ensure .env.store has RECEIPT_PRINT_AGENT_TOKEN so Docker and the agent share it.
Set-Location $PSScriptRoot\..

$envFile = Join-Path (Get-Location) ".env.store"
if (-not (Test-Path $envFile)) { return }

foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*RECEIPT_PRINT_AGENT_TOKEN\s*=\s*(.+)\s*$') {
    $existing = $Matches[1].Trim().Trim('"').Trim("'")
    if ($existing) {
      $env:RECEIPT_PRINT_AGENT_TOKEN = $existing
      return
    }
  }
}

$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'A'
Add-Content -Path $envFile -Value "`nRECEIPT_PRINT_AGENT_TOKEN=$token`n" -Encoding utf8
$env:RECEIPT_PRINT_AGENT_TOKEN = $token
Write-Host "Added RECEIPT_PRINT_AGENT_TOKEN to .env.store." -ForegroundColor Yellow
