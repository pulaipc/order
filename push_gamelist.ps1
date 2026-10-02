# =========================================================
# Pulai PC - Config & Game List Exporter & GitHub Auto-Sync
# =========================================================

$scriptDir =$PSScriptRoot

# Alternative method to go one folder up safely
$parentDir = Split-Path $scriptDir -Parent
$gameDirectoryPath = Join-Path $parentDir "nsp"
$configPath = Join-Path $scriptDir "gameslist.js"

if (-not (Test-Path $configPath)) {
    Write-Host "[ERROR] gameslist.js not found at: $configPath" -ForegroundColor Red
    pause
    exit 1
}

if (-not (Test-Path $gameDirectoryPath)) {
    Write-Host "[ERROR] 'nsp' folder not found at: $gameDirectoryPath" -ForegroundColor Red
    pause
    exit 1
}

$resolvedGamePath = (Resolve-Path $gameDirectoryPath).Path
Write-Host "[1/3] Scanning game folders at: $resolvedGamePath..." -ForegroundColor Cyan

$gameEntries = foreach ($dir in Get-ChildItem $resolvedGamePath -Directory) {
    if ($dir.Name -like ".*") { continue }

    $cleanName =$dir.Name -replace '\s*\[.*?\]', ''
    $cleanName =$cleanName -replace "'", ""
    $cleanName =$cleanName -replace '"', ""
    $cleanName =$cleanName -replace '\\', ""

    $files = Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -Force -ErrorAction SilentlyContinue
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    $gbSize = [math]::Round($bytes / 1GB, 2)

    '      { name: "' + $cleanName + '", size: ' + $gbSize + ' }'
}

$gamesJsBlock = "const games = [`r`n" + ($gameEntries -join ",`r`n") + "`r`n    ];"

Write-Host "[2/3] Updating gameslist.js game dataset..." -ForegroundColor Cyan

$configContent = Get-Content $configPath -Raw

# Regex replace only the 'const games = [...]' section in gameslist.js, preserving credentials & pricing settings
$updatedConfig = [regex]::Replace($configContent, 'const games = \[[\s\S]*?\];', { param($m)$gamesJsBlock })

Set-Content $configPath $updatedConfig -Encoding UTF8

Write-Host "[SUCCESS] gameslist.js updated locally!" -ForegroundColor Green

Write-Host "[3/3] Syncing changes to GitHub..." -ForegroundColor Yellow

Set-Location $scriptDir

$currentDate = Get-Date -Format "yyyy-MM-dd HH:mm"

git add gameslist.js
git commit -m "Auto-update game list: $currentDate"
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[COMPLETED] Live website config updated successfully!" -ForegroundColor Green
} else {
    Write-Host "`n[WARNING] Git push failed. Check network or credentials." -ForegroundColor Red
}

pause
