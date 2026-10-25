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

    # Count actual games in the folder by reading filenames.
    # A single game may span multiple files (base + update + DLC), so we extract
    # a game key from each filename and count unique keys. Unknown folders fall
    # back to 1.
    $gameFileExts = @('.nsp', '.nsx', '.xci', '.xcz', '.nsz')
    $gameFiles = $files | Where-Object { $gameFileExts -contains $_.Extension }
    $gameKeys = @{}
    foreach ($f in $gameFiles) {
        $name = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
        # Strip region tags [USA], [EUR], [JAP], etc.
        $name = $name -replace '\s*\[.*?\]', ''
        # Strip version tags v0, v1, v123, etc.
        $name = $name -replace '\s*v\d+', ''
        # Strip update/DLC/base indicators
        $name = $name -replace '\s*(update|dlc|base|main)', ''
        # Strip trailing spaces/dots/dashes
        $name = $name -replace '[\s.\-]+$', ''
        $key = $name.Trim().ToLower()
        if ($key.Length -gt 0) { $gameKeys[$key] = $true }
    }
    $fileCount = if ($gameKeys.Count -gt 0) { $gameKeys.Count } else { 1 }

    '      { name: "' + $cleanName + '", size: ' + $gbSize + ', fileCount: ' + $fileCount + ' }'
}

$currentDateIso = Get-Date -Format "o"
$gamesJsBlock = "const games = [`r`n" + ($gameEntries -join ",`r`n") + "`r`n    ];`r`n`r`nconst gamesLastSync = '" + $currentDateIso + "';"

Write-Host "[2/3] Updating gameslist.js game dataset..." -ForegroundColor Cyan

$configContent = Get-Content $configPath -Raw

# Remove any existing gamesLastSync declaration before inserting new one
$configContent = [regex]::Replace($configContent, '[\s\r\n]*const gamesLastSync\s*=\s*[^\r\n;]+;?', '')

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
