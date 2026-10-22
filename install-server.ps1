<#
.SYNOPSIS
  Local bridge between the admin page and copygame.ps1.

.DESCRIPTION
  A browser cannot run a script or write to the Switch, so the admin page
  cannot install anything by itself. This helper listens on 127.0.0.1 only,
  accepts a game list from the admin page, and runs copygame.ps1 with it -
  the same script, the same essentials-then-games flow, the same saved target.

  It is a thin front end: all the copying logic stays in copygame.ps1, so
  nothing here can drift from what a manual run does.

  If the port it was asked for is taken, it steps to the next free one
  rather than giving up: the admin page needs a helper to be there, and the
  port that was asked for may be held by an older copy that cannot be
  stopped without elevation. The port it actually got is written to the
  ready flag and to the local config file.

  The admin page normally runs from GitHub Pages, which is a different origin
  from 127.0.0.1 and cannot read a file sitting next to the helper. It
  therefore asks /config for the helper's url and token. That endpoint only
  answers an origin on the -AllowedOrigin list whose request names the admin
  page, in a header or in the Referer, so the token never reaches the
  customer-facing pages (which share the same origin) nor any other site
  the admin may have open in the same browser. Every other endpoint still
  needs the token as well.

.EXAMPLE
  .\install-server.ps1
  Listens on http://127.0.0.1:8787 until Ctrl+C.

.EXAMPLE
  .\install-server-hidden.ps1
  Starts the helper with no visible window and registers it to start at logon.
#>

[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$Token,
    [int]$MaxLogLines = 4000,
    # Quiet mode for a hidden launch (Task Scheduler / startup shortcut): no
    # console banner, everything still goes to install-server.log instead.
    [switch]$Quiet,
    # Which browser origins may ask the helper for its config (url + token).
    # The admin page on GitHub Pages is the one that needs this; a site the
    # admin happens to have open in the same browser is not on the list, so it
    # can never learn the token and can never start a copy.
    [string]$AllowedOrigin = 'https://pulaipc.github.io,http://127.0.0.1:*,http://localhost:*',
    # The admin page's file name. The customer-facing pages are served from
    # the same origin as the admin page, so the origin alone cannot tell them
    # apart - the admin page has to name itself instead, in a header or in the
    # Referer. Only the admin page asks for the token.
    # Leave it empty to skip that check.
    [string]$AdminPagePath = 'admin.html'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptDir)) { $ScriptDir = (Get-Location).Path }
$CopyScript = Join-Path $ScriptDir 'copygame.ps1'
$TokenFile = Join-Path $ScriptDir 'install_server_token.txt'
$LogFile = Join-Path $ScriptDir 'install-server.log'
$ReadyFile = Join-Path $ScriptDir 'install-server.ready'

# A hidden run has no console to print to, so Write-Host output would vanish and
# a failure would be silent. Detect that case and mirror every message to the
# log file; -Quiet forces it even when a console happens to exist.
$script:HasConsole = $true
try { $script:HasConsole = ($null -ne $Host.UI.RawUI) -and ([Console]::WindowWidth -gt 0) } catch { $script:HasConsole = $false }
$script:Quiet = $Quiet -or (-not $script:HasConsole)

# The log is kept to one generation and a size cap, so it cannot grow without
# bound. The cap is checked as the log is written, not only at start, because a
# helper can run for months without a restart.
$script:LogLimit = 1MB
$script:LogBytes = 0

function Rotate-Log {
    # Keep the previous log as .old and start a fresh one.
    try {
        if (Test-Path -LiteralPath $LogFile) {
            Move-Item -LiteralPath $LogFile -Destination "$LogFile.old" -Force -ErrorAction SilentlyContinue
        }
    } catch { }
    $script:LogBytes = 0
}

function Write-Note {
    param([string]$Text, [string]$Color = 'Gray', [switch]$NoLog)
    if (-not $script:Quiet) {
        if ($Color -eq 'Gray') { Write-Host $Text } else { Write-Host $Text -ForegroundColor $Color }
    }
    if (-not $NoLog) {
        try {
            $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            Add-Content -LiteralPath $LogFile -Value "$stamp  $Text" -Encoding UTF8 -ErrorAction SilentlyContinue
            # Roughly the size of what was just added: the timestamp, two spaces
            # and the text, plus a newline. Close enough for a size cap.
            $script:LogBytes += $Text.Length + 24
            if ($script:LogBytes -gt $script:LogLimit) { Rotate-Log }
        } catch { }
    }
}

# Rotate the log on start so it cannot grow without bound across reboots.
if (Test-Path -LiteralPath $LogFile) {
    try {
        $size = (Get-Item -LiteralPath $LogFile).Length
        $script:LogBytes = $size
        if ($size -gt $script:LogLimit) { Rotate-Log }
    } catch { $script:LogBytes = 0 }
}
# A stale ready flag from a previous run would lie about this one.
Remove-Item -LiteralPath $ReadyFile -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $CopyScript)) {
    Write-Note "copygame.ps1 not found next to this script ($CopyScript)" 'Red'
    exit 1
}

# ---- token -------------------------------------------------------------------
# Generated once and kept out of git (.gitignore), never hardcoded. The admin
# page gets the same value through install_local.js - see the note below.
if ([string]::IsNullOrEmpty($Token)) {
    if (Test-Path -LiteralPath $TokenFile) {
        $Token = (Get-Content -LiteralPath $TokenFile -TotalCount 1).Trim()
    }
    if ([string]::IsNullOrEmpty($Token)) {
        $bytes = New-Object byte[] 24
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $Token = ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLower()
        Set-Content -LiteralPath $TokenFile -Value $Token -Encoding ASCII
        Write-Note "Generated a new token in $TokenFile" 'Yellow'
    }
}

# ---- allowed origins ---------------------------------------------------------
# The admin page is served from GitHub Pages, so it is a different origin from
# 127.0.0.1 and cannot simply read a file sitting next to the helper. It has to
# ask the helper where it is and for its token - but that door stays shut to
# every other site the admin may have open in the same browser: an origin that
# is not on this list never gets the token, so it can never start a copy.
$script:AllowedOrigins = @()
foreach ($entry in ($AllowedOrigin -split ',')) {
    $e = $entry.Trim()
    if ($e) { $script:AllowedOrigins += $e }
}

# config.js is committed and public, so the token cannot live there. Instead it
# is written to a git-ignored local file that admin.html loads only when it is
# opened on this PC; over the internet that file is simply absent, and the
# admin page falls back to asking the helper over HTTP (see /config).
$LocalConfig = Join-Path $ScriptDir 'install_local.js'
function Write-LocalConfig {
    # Written after the listener is up, because the port the helper ends up on
    # is not always the one that was asked for - see the port fallback below.
    $body = @"
// Generated by install-server.ps1. Not committed (.gitignore).
// Read only by the admin page opened on this PC. The helper listens on
// 127.0.0.1 alone and only hands its token to the admin page, so the token
// never leaves this machine.
window.INSTALL_LOCAL = { url: 'http://127.0.0.1:$Port', token: '$Token' };
"@
    Set-Content -LiteralPath $LocalConfig -Value $body -Encoding UTF8
}

# ---- state -------------------------------------------------------------------
$script:Job = $null          # running copygame.ps1, when one is active
$script:Lines = New-Object System.Collections.Generic.List[string]
$script:StartedAt = $null
$script:LastExit = $null
$script:PendingGames = New-Object System.Collections.Generic.List[string]
$script:PausePending = $false
$script:StdIn = $null
$script:Sync = New-Object object
$script:OutFile = $null
$script:ErrFile = $null
$script:CodeFile = $null
$script:OutPos = 0
$script:ErrPos = 0
$script:Cancelled = $false

function Add-Line {
    param([string]$Text)
    [System.Threading.Monitor]::Enter($script:Sync)
    try {
        $script:Lines.Add($Text)
        # Keep memory bounded on a long run; the tail is what matters.
        while ($script:Lines.Count -gt $MaxLogLines) { $script:Lines.RemoveAt(0) }
    } finally { [System.Threading.Monitor]::Exit($script:Sync) }
}

function Get-StateSnapshot {
    [System.Threading.Monitor]::Enter($script:Sync)
    try {
        $running = ($null -ne $script:Job) -and (-not $script:Job.HasExited)
        return @{
            running     = $running
            pause       = $script:PausePending
            startedAt   = if ($script:StartedAt) { $script:StartedAt.ToString('o') } else { $null }
            lastExit    = $script:LastExit
            total       = $script:Lines.Count
            lines       = @($script:Lines)
        }
    } finally { [System.Threading.Monitor]::Exit($script:Sync) }
}

# ---- the copy job ------------------------------------------------------------
# One run at a time: two copygame runs would fight over the same device and the
# same games_to_copy.txt, so a second request is refused, not queued.
function Start-CopyJob {
    param([string[]]$GameNames, [bool]$WithEssentials, [bool]$DryRun)

    if (($null -ne $script:Job) -and (-not $script:Job.HasExited)) {
        return @{ ok = $false; error = 'a copy is already running' }
    }
    # A finished job is cleared here so its exit code and final output are
    # recorded before the next run overwrites the log.
    Update-CopyJob
    if ($null -eq $GameNames -or $GameNames.Count -eq 0) {
        return @{ ok = $false; error = 'no games given' }
    }

    # Same file the manual flow uses, so the two stay interchangeable.
    $listFile = Join-Path $ScriptDir 'games_to_copy.txt'
    $clean = @()
    foreach ($g in $GameNames) {
        $t = ([string]$g).Trim()
        # A newline in a name would forge extra list entries.
        if ($t.Length -gt 0) { $clean += ($t -replace '[\r\n]+', ' ') }
    }
    Set-Content -LiteralPath $listFile -Value $clean -Encoding UTF8

    # Reset output and state for the new run.
    [System.Threading.Monitor]::Enter($script:Sync)
    try {
        $script:Lines.Clear()
        $script:LastExit = $null
        $script:StartedAt = Get-Date
        $script:PausePending = $false
    } finally { [System.Threading.Monitor]::Exit($script:Sync) }

    Add-Line ("=== install started {0} ({1} game(s)) ===" -f (Get-Date).ToString('HH:mm:ss'), $clean.Count)

    $psExe = (Get-Process -Id $PID).Path

    # Output goes to files, not pipes. A pipe has to be drained by someone, and
    # the only thread that could drain it is the one serving HTTP - reading it
    # here would freeze every /status request for the whole copy, which is
    # exactly the stall this replaced. Files are read back a line at a time in
    # Update-CopyJob without ever blocking.
    $script:OutFile = Join-Path ([System.IO.Path]::GetTempPath()) "pulai_install_$PID.out"
    $script:ErrFile = Join-Path ([System.IO.Path]::GetTempPath()) "pulai_install_$PID.err"
    $script:CodeFile = Join-Path ([System.IO.Path]::GetTempPath()) "pulai_install_$PID.code"
    Remove-Item -LiteralPath $script:OutFile, $script:ErrFile, $script:CodeFile -ErrorAction SilentlyContinue

    # The child records its own exit code in a file. Reading ExitCode off the
    # process object is unreliable for a Start-Process -PassThru handle (it comes
    # back empty even on a clean finish), but the child writing the number itself
    # is exact, and it survives being killed as well as finishing normally.
    $inner = '& ' + ('"' + ($CopyScript -replace '"', '""') + '"')
    $switches = @()
    # Explicit either way: --essentials copies them, --skip-essentials means "do
    # not ask". Leaving it out would fall through to the script's Y/n prompt,
    # which a headless run can never answer.
    if ($WithEssentials) { $switches += '--essentials' } else { $switches += '--skip-essentials' }
    if ($DryRun) { $switches += '--dry-run' }
    $switches += '--no-pause'
    if ($switches.Count -gt 0) {
        $inner += ' ' + (($switches | ForEach-Object { "'$_'" }) -join ' ')
    }
    $inner += '; $ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }'
    $inner += '; Set-Content -LiteralPath ' + ("'" + $script:CodeFile + "'") + ' -Value $ec -Encoding ASCII'
    $inner += '; exit $ec'

    # Start-Process is used rather than a cmd.exe wrapper on purpose: it redirects
    # to files without a pipe, and it launches powershell.exe directly, so the
    # returned process IS the copy. A cmd wrapper would make Kill() hit only the
    # wrapper and leave the real copy running after Stop.
    $proc = Start-Process -FilePath $psExe `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner) `
        -WorkingDirectory $ScriptDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $script:OutFile -RedirectStandardError $script:ErrFile

    $script:Job = $proc
    $script:OutPos = 0
    $script:ErrPos = 0

    Add-Line ("> " + $psExe + ' ' + $inner)
    return @{ ok = $true; started = $true }
}

# Read whatever the running job has appended to its output files since the last
# call, and note when it ends. Never blocks: a file read at an offset returns
# immediately whether or not the writer has added more.
function Read-NewLines {
    param([string]$Path, [ref]$Pos, [string]$Prefix)
    if ([string]::IsNullOrEmpty($Path) -or -not (Test-Path -LiteralPath $Path)) { return }
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    } catch { return }
    try {
        if ($fs.Length -le $Pos.Value) { return }
        [void]$fs.Seek($Pos.Value, [System.IO.SeekOrigin]::Begin)
        $sr = New-Object System.IO.StreamReader($fs)
        $text = $sr.ReadToEnd()
        $Pos.Value = $fs.Length
        foreach ($line in ($text -split "`r?`n")) {
            if ($line.Length -gt 0) { Add-Line ($Prefix + $line) }
        }
    } finally {
        $fs.Close()
    }
}

function Update-CopyJob {
    $proc = $script:Job
    if ($null -eq $proc) { return }

    $outPos = [ref]$script:OutPos
    $errPos = [ref]$script:ErrPos
    Read-NewLines -Path $script:OutFile -Pos $outPos -Prefix ''
    Read-NewLines -Path $script:ErrFile -Pos $errPos -Prefix '! '
    $script:OutPos = $outPos.Value
    $script:ErrPos = $errPos.Value

    $finished = $false
    try { $finished = $proc.HasExited } catch { $finished = $true }
    if (-not $finished) { return }

    # Ended: one last drain, then the exit code. The files can still be growing
    # for a moment after exit, so read once more after a brief settle.
    Start-Sleep -Milliseconds 60
    $outPos = [ref]$script:OutPos
    $errPos = [ref]$script:ErrPos
    Read-NewLines -Path $script:OutFile -Pos $outPos -Prefix ''
    Read-NewLines -Path $script:ErrFile -Pos $errPos -Prefix '! '
    $script:OutPos = $outPos.Value
    $script:ErrPos = $errPos.Value

    $code = $null
    # The child writes its own exit code to a file. Wait briefly for it, because
    # the file can land a moment after the process is gone.
    for ($i = 0; $i -lt 20 -and $null -eq $code; $i++) {
        if (Test-Path -LiteralPath $script:CodeFile) {
            try {
                $raw = (Get-Content -LiteralPath $script:CodeFile -TotalCount 1).Trim()
                if ($raw -ne '') { $code = [int]$raw }
            } catch { }
        }
        if ($null -eq $code) { Start-Sleep -Milliseconds 50 }
    }
    if ($null -eq $code) {
        # Killed before it could write: report that honestly, not as exit 0.
        $code = if ($script:Cancelled) { 'cancelled' } else { 'unknown' }
    }
    Add-Line ("=== install finished (exit {0}) at {1} ===" -f $code, (Get-Date).ToString('HH:mm:ss'))
    $script:LastExit = $code
    $script:Cancelled = $false
    try { $proc.Dispose() } catch { }
    Remove-Item -LiteralPath $script:OutFile, $script:ErrFile, $script:CodeFile -ErrorAction SilentlyContinue
    $script:Job = $null
}

# ---- HTTP --------------------------------------------------------------------
# Is this caller's origin allowed to ask for the helper's config? A browser
# always sets the Origin header itself, so a site cannot claim to be the admin
# page. An entry may end in * to allow any port (http://127.0.0.1:*).
function Test-AllowedOrigin {
    param([string]$Origin)
    if ([string]::IsNullOrWhiteSpace($Origin)) { return $false }
    $o = $Origin.Trim().ToLowerInvariant().TrimEnd('/')
    foreach ($a in $script:AllowedOrigins) {
        $p = $a.Trim().ToLowerInvariant().TrimEnd('/')
        if ($p -eq $o) { return $true }
        if ($p.EndsWith('*') -and $o.StartsWith($p.Substring(0, $p.Length - 1))) { return $true }
    }
    return $false
}

function Write-Access {
    # A one-line record of a request that mattered: who asked, what they said
    # they were, and what was answered. This is what tells you why a browser
    # could not reach the helper - a request that never arrives shows up by
    # its absence, and one that arrives says exactly what it sent.
    param([string]$Method, [string]$Path, [string]$Origin, [string]$Referer, [string]$Result)
    $o = if ([string]::IsNullOrWhiteSpace($Origin)) { '(none)' } else { $Origin }
    $r = if ([string]::IsNullOrWhiteSpace($Referer)) { '(none)' } else { $Referer }
    Write-Note ("{0} {1}  origin={2}  referer={3}  -> {4}" -f $Method, $Path, $o, $r, $Result) 'DarkGray'
}

function Send-Json {
    param($Context, $Object, [int]$StatusCode = 200)
    $json = $Object | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Context.Response.StatusCode = $StatusCode
    $Context.Response.ContentType = 'application/json; charset=utf-8'
    $Context.Response.ContentLength64 = $bytes.Length
    # The admin page is served from a different origin (GitHub Pages), so the
    # browser needs permission to read the reply. Echoing the caller's own
    # origin back is what allows that; a request with no origin at all (a
    # local tool) gets the wildcard.
    $origin = $Context.Request.Headers['Origin']
    if ([string]::IsNullOrWhiteSpace($origin)) {
        $Context.Response.Headers['Access-Control-Allow-Origin'] = '*'
    } else {
        $Context.Response.Headers['Access-Control-Allow-Origin'] = $origin
    }
    $Context.Response.Headers['Vary'] = 'Origin'
    # Keep a browser from running the reply as script if something loads it
    # with a <script> tag.
    $Context.Response.Headers['X-Content-Type-Options'] = 'nosniff'
    $Context.Response.Headers['Access-Control-Allow-Headers'] = 'content-type, x-install-token, x-admin-page'
    $Context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.OutputStream.Close()
}

function Test-Authorised {
    param($Context)
    $given = $Context.Request.Headers['X-Install-Token']
    if ([string]::IsNullOrEmpty($given)) { return $false }
    # Fixed-time compare so the token cannot be guessed byte by byte.
    $a = [System.Text.Encoding]::UTF8.GetBytes($given)
    $b = [System.Text.Encoding]::UTF8.GetBytes($Token)
    if ($a.Length -ne $b.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $a.Length; $i++) { $diff = $diff -bor ($a[$i] -bxor $b[$i]) }
    return ($diff -eq 0)
}

function Read-BodyJson {
    param($Context)
    $reader = New-Object System.IO.StreamReader($Context.Request.InputStream, $Context.Request.ContentEncoding)
    try { $raw = $reader.ReadToEnd() } finally { $reader.Close() }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
}

# ---- the listener -------------------------------------------------------------
# The port that was asked for may already be taken - by an older copy of this
# helper, by a leftover process that cannot be stopped without elevation, or by
# something else on the PC. Giving up there would leave the admin page with no
# helper at all, which is the one thing that must not happen, so the helper
# steps to the next free port instead. The admin page looks for it on a few
# ports, and the ready flag and install_local.js record where it landed.
$candidatePorts = @($Port) + (1..4 | ForEach-Object { $Port + $_ })
$listener = $null
$prefix = $null
$listenError = $null
foreach ($candidate in $candidatePorts) {
    $try = New-Object System.Net.HttpListener
    $tryPrefix = "http://127.0.0.1:$candidate/"
    $try.Prefixes.Add($tryPrefix)
    try {
        $try.Start()
        $listener = $try
        $prefix = $tryPrefix
        $Port = $candidate
        break
    } catch {
        $listenError = $_.Exception.Message
        try { $try.Close() } catch { }
    }
}

if ($null -eq $listener) {
    Write-Note "Could not listen on any port from $($candidatePorts[0]) to $($candidatePorts[-1])" 'Red'
    Write-Note $listenError 'Red'
    Write-Note 'Another copy may already be running, or every one of those ports is taken.' 'Yellow'
    exit 1
}

if ($Port -ne $candidatePorts[0]) {
    Write-Note "Port $($candidatePorts[0]) was taken, using $Port instead." 'Yellow'
}

# Now that the real port is known, point the local admin page at it.
Write-LocalConfig

# The admin page polls /health, but a ready flag on disk lets you (or a startup
# task) tell that the helper is up without opening a browser.
Set-Content -LiteralPath $ReadyFile -Value "$(Get-Date -Format o)`n$prefix`npid=$PID" -Encoding UTF8

Write-Note ''
Write-Note '  Pulai install helper' 'Yellow'
Write-Note "  Listening on $prefix" 'Green'
Write-Note "  Using script: $CopyScript"
Write-Note "  Wrote:        $LocalConfig"
Write-Note "  Log:          $LogFile"
Write-Note ''
Write-Note '  The Install button on the admin page finds this helper by itself.' 'Cyan'
Write-Note '  Ctrl+C to stop.' 'DarkGray'
Write-Note ''

while ($listener.IsListening) {
    $context = $null
    try {
        $context = $listener.GetContext()
    } catch {
        break
    }

    try {
        $path = $context.Request.Url.AbsolutePath.TrimEnd('/').ToLower()
        $method = $context.Request.HttpMethod

        if ($method -eq 'OPTIONS') {
            # Preflight. Chrome also asks for private-network access when the
            # page is on a public origin (GitHub Pages) and the helper is on
            # 127.0.0.1, so the answer has to say yes to that as well.
            $Context.Response.Headers['Access-Control-Allow-Private-Network'] = 'true'
            $Context.Response.Headers['Access-Control-Max-Age'] = '600'
            Send-Json $context @{ ok = $true } | Out-Null
            continue
        }

        # The admin page has to learn where the helper is and for its token.
        # That is the one thing it cannot get from a file, because the page is
        # served from GitHub Pages while the helper lives on this PC. Only an
        # origin on the allowed list may ask; anything else gets a flat no, so
        # no other site in this browser can ever learn the token.
        if ($path -eq '/config') {
            $caller = $context.Request.Headers['Origin']
            $referer = $context.Request.Headers['Referer']
            $adminPage = $context.Request.Headers['X-Admin-Page']
            if (-not (Test-AllowedOrigin $caller)) {
                Write-Access $method $path $caller $referer '403 origin not allowed'
                Send-Json $context @{ ok = $false; error = 'origin not allowed' } 403 | Out-Null
                continue
            }
            # The customer-facing pages come from the same origin as the admin
            # page, so the origin check alone cannot tell them apart. The admin
            # page has to identify itself instead, and the Referer is not
            # enough for that: Firefox drops the Referer when the page is https
            # and the helper is http, which is exactly the case here. So the
            # page also sends its own name in a header, and either signal is
            # enough. A script on the public shop page sends neither.
            $fromAdmin = $true
            if ($AdminPagePath) {
                $fromAdmin = $false
                if (-not [string]::IsNullOrWhiteSpace($referer) -and ($referer -like "*$AdminPagePath*")) { $fromAdmin = $true }
                if (-not [string]::IsNullOrWhiteSpace($adminPage) -and ($adminPage -like "*$AdminPagePath*")) { $fromAdmin = $true }
            }
            if (-not $fromAdmin) {
                Write-Access $method $path $caller $referer '403 not the admin page'
                Send-Json $context @{ ok = $false; error = 'not the admin page' } 403 | Out-Null
                continue
            }
            Write-Access $method $path $caller $referer '200 ok'
            Send-Json $context @{ ok = $true; url = $prefix.TrimEnd('/'); token = $Token; port = $Port } | Out-Null
            continue
        }

        if (-not (Test-Authorised $context)) {
            Write-Access $method $path $context.Request.Headers['Origin'] $context.Request.Headers['Referer'] '401 bad or missing token'
            Send-Json $context @{ ok = $false; error = 'bad or missing token' } 401 | Out-Null
            continue
        }

        switch ($path) {
            '/status' {
                Update-CopyJob
                Send-Json $context (Get-StateSnapshot) | Out-Null
            }
            '/install' {
                if ($method -ne 'POST') { Send-Json $context @{ ok = $false; error = 'use POST' } 405 | Out-Null; continue }
                $body = Read-BodyJson $context
                if ($null -eq $body) { Send-Json $context @{ ok = $false; error = 'empty body' } 400 | Out-Null; continue }
                $names = @()
                if ($body.games) { $names = @($body.games) }
                $withEss = $true
                if ($null -ne $body.essentials) { $withEss = [bool]$body.essentials }
                $dry = $false
                if ($null -ne $body.dryRun) { $dry = [bool]$body.dryRun }
                $result = Start-CopyJob -GameNames $names -WithEssentials $withEss -DryRun $dry
                $code = if ($result.ok) { 200 } else { 409 }
                Send-Json $context $result $code | Out-Null
            }
            '/cancel' {
                if (($null -ne $script:Job) -and (-not $script:Job.HasExited)) {
                    $script:Cancelled = $true
                    # $script:Job is the copy itself (Start-Process, no wrapper),
                    # so /T is belt-and-braces for anything it spawned.
                    try {
                        & "$env:SystemRoot\System32\taskkill.exe" /PID $script:Job.Id /T /F 2>&1 | Out-Null
                    } catch {
                        try { $script:Job.Kill() } catch { }
                    }
                    Add-Line '=== cancelled from the admin page ==='
                    Send-Json $context @{ ok = $true; cancelled = $true } | Out-Null
                } else {
                    Send-Json $context @{ ok = $false; error = 'nothing running' } 409 | Out-Null
                }
            }
            '/health' {
                Send-Json $context @{ ok = $true; script = $CopyScript } | Out-Null
            }
            default {
                Send-Json $context @{ ok = $false; error = 'unknown endpoint' } 404 | Out-Null
            }
        }
    } catch {
        try { Send-Json $context @{ ok = $false; error = $_.Exception.Message } 500 | Out-Null } catch { }
    }
}

try { $listener.Stop(); $listener.Close() } catch { }
Remove-Item -LiteralPath $ReadyFile -ErrorAction SilentlyContinue
Write-Note 'Helper stopped.' 'DarkGray'
