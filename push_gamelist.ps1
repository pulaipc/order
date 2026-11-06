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

# DBI streams installs, so a game's source file never has to stay on the SD
# card. What has to fit is the *installed* game, which is bigger than the
# compressed NSZ/XCZ download. An NSZ/XCZ filename usually states that
# uncompressed size, e.g. "Hollow Knight [0100...][v0] (3.55 GB).nsz"; when it
# does, that figure is exact. Without the tag, allow 1.5x (the measured median
# NSZ expansion is ~1.3x, and some titles compress far better). NSP/XCI are
# already close to installed size, so a small 10% covers tickets and rounding.
function Get-InstallBytes([System.IO.FileInfo]$file) {
    $ext = $file.Extension.ToLowerInvariant()
    $installed = [double]$file.Length
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $sizeTag = [regex]::Match($baseName, '\((\d+(?:\.\d+)?)\s*GB\)', 'IgnoreCase')
    if ($ext -eq '.nsz' -or $ext -eq '.xcz') {
        if ($sizeTag.Success) {
            $stated = [double]::Parse($sizeTag.Groups[1].Value, [System.Globalization.CultureInfo]::InvariantCulture)
            $installed = $stated * 1GB
        } else {
            $installed = $installed * 1.5
        }
    } else {
        $installed = $installed * 1.1
    }
    return [long][math]::Ceiling($installed)
}

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
    # Bytes per member key: base + updates, plus DLC whose title ID belongs to
    # that game. A single game picked from a pack is copied (and sized) as
    # exactly these files by copygame.ps1.
    $memberBytes = @{}
    # Installed bytes for the same keys (and for the folder as a whole), so the
    # catalog can tell customers what the card actually has to hold.
    $memberInstall = @{}
    $totalInstallBytes = [long]0
    foreach ($f in $gameFiles) {
        $fullName = $f.FullName
        $fileName = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
        $installBytes = Get-InstallBytes $f
        $totalInstallBytes += $installBytes

        # Skip files inside DLC subfolders — any directory segment containing
        # "dlc" (e.g. "DLC", "dlc", "58 DLC", "dlc pack", etc.) is excluded.
        $relPath = $fullName.Substring($dir.FullName.Length)
        $dlcFolder = $relPath -split '[\\/]' | Where-Object { $_ -match 'dlc' }
        $isDlc = [bool]$dlcFolder -or ($fileName -match '\[.*?\bdlc\b.*?\]')
        if ($isDlc) {
            # DLC IDs are the base ID + 0x1000 + n: count the bytes towards the
            # game it belongs to, but never as a game of its own.
            if ($fileName -match '\[([0-9A-Fa-f]{16})\]') {
                $v = [Convert]::ToUInt64($matches[1], 16)
                $baseKey = ('{0:x16}' -f (($v - ($v % 4096)) - 4096)).Substring(0, 13)
                $memberBytes[$baseKey] = [long]$memberBytes[$baseKey] + $f.Length
                $memberInstall[$baseKey] = [long]$memberInstall[$baseKey] + $installBytes
            }
            continue
        }

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

        if ($key.Length -gt 0) {
            $gameKeys[$key] = $true
            $memberBytes[$key] = [long]$memberBytes[$key] + $f.Length
            $memberInstall[$key] = [long]$memberInstall[$key] + $installBytes
        }

        # Member display name: filename minus [] tags, minus the "(0.01 GB)"
        # size parens some files carry, minus quotes so the JS string stays
        # clean. Base title ID (first 13 chars + 000) powers the member's
        # cover art on the library page.
        $memberPriority = if ($titleId -and $titleId.Substring(13) -eq '000') { 0 } else { 1 }
        $replaceMember = -not $members.Contains($key)
        if (-not $replaceMember -and $memberPriority -lt $members[$key].priority) { $replaceMember = $true }
        if ($replaceMember) {
            $memberName = $fileName -replace '\s*\[[^\]]*\]', ''
            $memberName = $memberName -replace '\s*\(\d+(?:\.\d+)?\s*GB\)', ''
            $memberName = $memberName -replace "'", ""
            $memberName = $memberName -replace '"', ""
            $memberName = $memberName -replace '\\', ""
            $memberName = $memberName -replace '[\s.\-]+$', ''
            $memberName = ($memberName.Trim() -replace '\s+', ' ')
            $memberTid = $null
            if ($titleId) { $memberTid = ($titleId.Substring(0, 13) + '000').ToLower() }
            if ($memberName.Length -gt 0) { $members[$key] = @{ n = $memberName; tid = $memberTid; key = $key; priority = $memberPriority } }
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
            # gb: this game's own size, for picking one game out of the pack.
            $memberGb = [math]::Round([long]$memberBytes[$_['key']] / 1GB, 2)
            $gbPart = ', gb: ' + $memberGb.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            # igb: what that pick takes on the card once installed. A pick only
            # copies that member's files, so its own file total is the floor.
            $memberPickBytes = [math]::Max([long]$memberInstall[$_['key']], [long]$memberBytes[$_['key']])
            $memberIgb = [math]::Round($memberPickBytes / 1GB, 2)
            $igbPart = ', igb: ' + $memberIgb.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            '{ n: "' + $_['n'] + '"' + $tidPart + $gbPart + $igbPart + ' }'
        })
        $titlesField = ', titles: [' + ($memberJs -join ', ') + ']'
    }

    # Date the folder was added to the nsp library (folder creation time), for
    # the "Newest added" sort on games.html.
    $addedField = ', added: "' + $dir.CreationTime.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture) + '"'

    # Installed size, for storage fit on the order form. A folder is copied to
    # the card as a whole, so it can never ask for less than its own file total
    # (homebrew ports put the game in an atmosphere\ folder, and an offline mod
    # can dwarf the NSP it patches). Zero means "not measured" (no files), and
    # the site falls back to size + buffer.
    if ($bytes -gt $totalInstallBytes) { $totalInstallBytes = [long]$bytes }
    $igbSize = [math]::Round($totalInstallBytes / 1GB, 2)
    $igbField = ', igb: ' + $igbSize.ToString([System.Globalization.CultureInfo]::InvariantCulture)

    '      { name: "' + $cleanName + '", size: ' + $gbSize + $igbField + ', fileCount: ' + $fileCount + $coverField + $addedField + $titlesField + ' }'
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

git add gameslist.js gamedata.js version.json
git commit -m "Auto-update game list: $currentDate"
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[COMPLETED] Live website config updated successfully!" -ForegroundColor Green
} else {
    Write-Host "`n[WARNING] Git push failed. Check network or credentials." -ForegroundColor Red
}

pause
