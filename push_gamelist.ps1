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
    # A single game may span multiple NSP files (base + update), so we use the
    # title ID inside [] (e.g. [010083801AA14000]) to group them, ignoring the
    # last 3 digits so version bumps map to the same game. DLC packs and files
    # inside DLC subfolders are excluded. Unknown folders fall back to 1.
    $gameFileExts = @('.nsp', '.nsx', '.xci', '.xcz', '.nsz')
    $gameFiles = $files | Where-Object { $gameFileExts -contains $_.Extension }
    $gameKeys = @{}
    $coverIds = @{}
    # Pack members: one entry per distinct game inside the folder, remembered
    # in first-seen order so games.html can list what a multi-game pack
    # includes. Keyed the same way as $gameKeys (base + updates collapse).
    $members = [ordered]@{}
    foreach ($f in $gameFiles) {
        $fullName = $f.FullName
        $fileName = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)

        # Skip files inside DLC subfolders — any directory segment containing
        # "dlc" (e.g. "DLC", "dlc", "58 DLC", "dlc pack", etc.) is excluded.
        $relPath = $fullName.Substring($dir.FullName.Length)
        $dlcFolder = $relPath -split '[\\/]' | Where-Object { $_ -match 'dlc' }
        if ($dlcFolder) { continue }

        # Skip DLC packs by filename — catches [DLC], [All DLC], [Standalone DLC],
        # [DLC Pack], [DLC Bundle], etc. (case-insensitive, anywhere inside [])
        if ($fileName -match '\[.*?\bdlc\b.*?\]') { continue }

        # Extract title ID from [] - 16 hex chars like [010083801AA14000]
        $titleId = $null
        if ($fileName -match '\[([0-9A-Fa-f]{16})\]') {
            $titleId = $matches[1]
        }

        if ($titleId) {
            # Ignore last 3 digits so [010083801AA14000] and [010083801AA14800]
            # (base + update of the same game) map to one key
            $key = $titleId.Substring(0, $titleId.Length - 3).ToLower()
            # Base ID form (first 13 chars + '000') is what cover art databases
            # key on, so remember it for the catalog entry.
            $coverIds[($titleId.Substring(0, 13) + '000').ToLower()] = $true
        } else {
            # Fall back to cleaned filename when no title ID is present
            $key = $fileName
            $key = $key -replace '\s*\[.*?\]', ''   # strip all remaining []
            $key = $key -replace '\s*v\d+', ''       # strip version tags
            $key = $key -replace '\s*(update|dlc|base|main)', ''
            $key = $key -replace '[\s.\-]+$', ''
            $key = $key.Trim().ToLower()
        }

        if ($key.Length -gt 0) { $gameKeys[$key] = $true }

        # Member display name: filename minus [] tags, minus the "(0.01 GB)"
        # size parens some files carry, minus quotes so the JS string stays
        # clean. Base title ID (first 13 chars + 000) powers the member's
        # cover art on the library page.
        if (-not $members.Contains($key)) {
            $memberName = $fileName -replace '\s*\[[^\]]*\]', ''
            $memberName = $memberName -replace '\s*\(\d+(?:\.\d+)?\s*GB\)', ''
            $memberName = $memberName -replace "'", ""
            $memberName = $memberName -replace '"', ""
            $memberName = $memberName -replace '\\', ""
            $memberName = $memberName -replace '[\s.\-]+$', ''
            $memberName = ($memberName.Trim() -replace '\s+', ' ')
            $memberTid = $null
            if ($titleId) { $memberTid = ($titleId.Substring(0, 13) + '000').ToLower() }
            if ($memberName.Length -gt 0) { $members[$key] = @{ n = $memberName; tid = $memberTid } }
        }
    }
    $fileCount = if ($gameKeys.Count -gt 0) { $gameKeys.Count } else { 1 }

    # Cover art: for multi-game collections pick the alphabetically-first base
    # ID so the choice is deterministic; folders with no title IDs get none and
    # the site falls back to a letter tile.
    $coverId = $null
    if ($coverIds.Count -gt 0) { $coverId = $coverIds.Keys | Sort-Object | Select-Object -First 1 }
    $coverField = if ($coverId) { ', titleId: "' + $coverId + '"' } else { '' }

    # Multi-game packs also carry their member list in the catalog so the
    # library page can show which games are included.
    $titlesField = ''
    if ($fileCount -gt 1 -and $members.Count -gt 0) {
        $memberJs = @($members.Values | ForEach-Object {
            $tidPart = if ($_['tid']) { ', tid: "' + $_['tid'] + '"' } else { '' }
            '{ n: "' + $_['n'] + '"' + $tidPart + ' }'
        })
        $titlesField = ', titles: [' + ($memberJs -join ', ') + ']'
    }

    '      { name: "' + $cleanName + '", size: ' + $gbSize + ', fileCount: ' + $fileCount + $coverField + $titlesField + ' }'
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

# Enrich the catalog with descriptions and Metacritic scores (writes
# gamedata.js). Failures here must never block the game list sync itself.
Write-Host "[2b/3] Building gamedata.js (descriptions + Metacritic ratings)..." -ForegroundColor Cyan
try {
    node (Join-Path $scriptDir "build_gamedata.js")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[WARNING] build_gamedata.js failed; keeping the previous gamedata.js." -ForegroundColor Yellow
    }
} catch {
    Write-Host "[WARNING] node not available or failed; keeping the previous gamedata.js." -ForegroundColor Yellow
}

Write-Host "[3/3] Syncing changes to GitHub..." -ForegroundColor Yellow

Set-Location $scriptDir

$currentDate = Get-Date -Format "yyyy-MM-dd HH:mm"

git add gameslist.js gamedata.js
git commit -m "Auto-update game list: $currentDate"
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[COMPLETED] Live website config updated successfully!" -ForegroundColor Green
} else {
    Write-Host "`n[WARNING] Git push failed. Check network or credentials." -ForegroundColor Red
}

pause
