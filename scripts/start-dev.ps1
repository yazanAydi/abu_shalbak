# Local development — API + Admin + POS
Set-Location $PSScriptRoot\..

Write-Host "Starting DEV stack (API :5000, Admin :3001, POS :3002)..." -ForegroundColor Cyan
Write-Host "Config: .env.development — do NOT use for the live shop." -ForegroundColor DarkGray

npm start
