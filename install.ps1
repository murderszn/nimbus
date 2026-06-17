Write-Host "┌────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "│        Installing Nimbus Focus         │" -ForegroundColor Cyan
Write-Host "└────────────────────────────────────────┘" -ForegroundColor Cyan

$Version = "1.2.13"
$Url = "https://github.com/murderszn/nimbus/releases/latest/download/Nimbus-Setup-$Version-x64.exe"
$TempPath = Join-Path $env:TEMP "Nimbus-Setup.exe"

Write-Host "Downloading Nimbus v$Version..." -ForegroundColor Blue
Invoke-WebRequest -Uri $Url -OutFile $TempPath -UserAgent "Mozilla/5.0"

Write-Host "Starting installation..." -ForegroundColor Blue
# Standard Electron NSIS silent install argument is /S
Start-Process -FilePath $TempPath -ArgumentList "/S" -Wait

Write-Host "✓ Nimbus has been installed successfully!" -ForegroundColor Green
Write-Host "🚀 Launching Nimbus..." -ForegroundColor Green

$ExecutablePath = "$env:LOCALAPPDATA\Programs\nimbus\Nimbus.exe"
if (Test-Path $ExecutablePath) {
    Start-Process -FilePath $ExecutablePath
} else {
    Write-Host "Please start Nimbus from your Start Menu or Desktop shortcut." -ForegroundColor Yellow
}
