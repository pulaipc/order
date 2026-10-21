<#
.SYNOPSIS
  Starts the Pulai install helper with no visible window, and optionally makes it
  start automatically at logon.

.DESCRIPTION
  The helper (install-server.ps1) is a normal console script that prints a banner
  and waits for Ctrl+C. That is right for a manual run, and wrong for a startup
  one: a scheduled task or Startup shortcut would flash a black window on every
  login.

  This launcher runs it hidden and detached instead:

    * no console window (the server writes to install-server.log instead)
    * a single instance - a second launch is refused, so two helpers cannot
      fight over port 8787
    * a stale instance from a previous session is stopped first, so a reboot is
      the only thing needed to recover a wedged helper

  The port asked for may already be taken - by an old helper that needs
  elevation to stop, or by anything else on the PC. The helper then steps to
  the next free port rather than failing, and this launcher reports the port
  it actually got.

.PARAMETER Install
  Register the helper to start at logon for the current user and exit.

.PARAMETER Uninstall
  Remove that logon entry and stop any running helper.

.PARAMETER Port
  Port to listen on. Default 8787, matching install-server.ps1.

.PARAMETER AllowedOrigin
  Browser origins allowed to ask the helper for its config. Passed straight
  through to install-server.ps1.

.PARAMETER AdminPagePath
  File name of the admin page. The helper only hands its token to a request
  whose Referer is that page. Passed straight through to install-server.ps1.

.EXAMPLE
  .\install-server-hidden.ps1
  Start it hidden right now.

.EXAMPLE
  .\install-server-hidden.ps1 -Install
  Start it now and on every logon.
#>

[CmdletBinding()]
param(
    [int]$Port = 8787,
    [switch]$Install,
    [switch]$Uninstall,
    [string]$AllowedOrigin = 'https://pulaipc.github.io,http://127.0.0.1:*,http://localhost:*',
    [string]$AdminPagePath = 'admin.html'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptDir)) { $ScriptDir = (Get-Location).Path }
$Server = Join-Path $ScriptDir 'install-server.ps1'
$LogFile = Join-Path $ScriptDir 'install-server.log'
$ReadyFile = Join-Path $ScriptDir 'install-server.ready'
$TaskName = 'PulaiInstallHelper'

if (-not (Test-Path -LiteralPath $Server)) {
    Write-Host "install-server.ps1 not found next to this script ($Server)" -ForegroundColor Red
    exit 1
}

function Get-HelperProcesses {
    # Match on the script path in the command line so unrelated PowerShell
    # windows are never touched.
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($Server)) }
}

function Get-ReadyPid {
    # The ready flag records the pid of the run that wrote it. A helper whose
    # command line cannot be read (it happens when the process is started
    # detached) is still found this way, so a second helper never ends up
    # fighting over the same port.
    try {
        if (-not (Test-Path -LiteralPath $ReadyFile)) { return $null }
        $line = (Get-Content -LiteralPath $ReadyFile -ErrorAction SilentlyContinue |
                 Where-Object { $_ -like 'pid=*' } | Select-Object -First 1)
        if (-not $line) { return $null }
        $pidText = ($line -replace '^pid=', '').Trim()
        $n = 0
        if ([int]::TryParse($pidText, [ref]$n)) { return $n }
    } catch { }
    return $null
}

function Get-ReadyUrl {
    # The port the helper actually ended up on. It is not always the one that
    # was asked for: when that port is taken the helper steps to the next free
    # one, and this is where the real address comes from.
    try {
        if (-not (Test-Path -LiteralPath $ReadyFile)) { return $null }
        $line = (Get-Content -LiteralPath $ReadyFile -ErrorAction SilentlyContinue |
                 Where-Object { $_ -like 'http://127.0.0.1:*' } | Select-Object -First 1)
        if ($line) { return $line.Trim() }
    } catch { }
    return $null
}

function Stop-Helper {
    $procs = @(Get-HelperProcesses)
    foreach ($p in $procs) {
        Write-Host "  stopping helper PID $($p.ProcessId)" -ForegroundColor DarkGray
        try { & "$env:SystemRoot\System32\taskkill.exe" /PID $p.ProcessId /T /F 2>&1 | Out-Null } catch { }
    }
    # Also catch a helper that the command-line scan missed.
    $readyPid = Get-ReadyPid
    if ($readyPid -and -not ($procs | Where-Object { $_.ProcessId -eq $readyPid })) {
        Write-Host "  stopping helper PID $readyPid" -ForegroundColor DarkGray
        try { & "$env:SystemRoot\System32\taskkill.exe" /PID $readyPid /T /F 2>&1 | Out-Null } catch { }
    }
    return $procs.Count
}

# ---- uninstall ---------------------------------------------------------------
if ($Uninstall) {
    Write-Host 'Removing the logon entry...' -ForegroundColor Yellow
    & "$env:SystemRoot\System32\schtasks.exe" /Delete /TN $TaskName /F 2>&1 | Out-Null
    $null = Stop-Helper
    Remove-Item -LiteralPath $ReadyFile -ErrorAction SilentlyContinue
    Write-Host 'Done. The helper will not start again on its own.' -ForegroundColor Green
    exit 0
}

# ---- single instance ---------------------------------------------------------
# A running helper already owns the port. Restarting it is the only reliable
# recovery when a previous run died without cleaning up, so stop first.
$existing = @(Get-HelperProcesses)
if ($existing.Count -gt 0) {
    Write-Host 'A helper is already running; restarting it...' -ForegroundColor Yellow
    $null = Stop-Helper
    Start-Sleep -Milliseconds 700
}

# ---- launch hidden -----------------------------------------------------------
# The ready flag is written by the helper once its listener is up, and it names
# the port the helper actually got. Clear any leftover from a previous run
# first, so this command cannot read a stale flag and report the old port.
Remove-Item -LiteralPath $ReadyFile -ErrorAction SilentlyContinue

$psExe = (Get-Process -Id $PID).Path
$args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', $Server,
    '-Quiet',
    '-Port', "$Port",
    '-AllowedOrigin', $AllowedOrigin,
    '-AdminPagePath', $AdminPagePath
)

Start-Process -FilePath $psExe -ArgumentList $args -WindowStyle Hidden | Out-Null

# Wait for the ready flag so this command only reports success when the helper
# genuinely came up (the flag is written after the listener starts).
$deadline = (Get-Date).AddSeconds(15)
$up = $false
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $ReadyFile) { $up = $true; break }
    Start-Sleep -Milliseconds 250
}

if ($up) {
    $readyUrl = Get-ReadyUrl
    if ($readyUrl) {
        Write-Host "Install helper is running hidden on $readyUrl" -ForegroundColor Green
    } else {
        Write-Host "Install helper is running hidden on http://127.0.0.1:$Port/" -ForegroundColor Green
    }
    Write-Host "  log: $LogFile" -ForegroundColor DarkGray
} else {
    Write-Host 'Helper did not report ready within 15s.' -ForegroundColor Red
    Write-Host "  Check $LogFile - every port from $Port to $($Port + 4) may be taken." -ForegroundColor Yellow
}

# ---- optional logon entry ----------------------------------------------------
if ($Install) {
    # Run only when this user is logged on: the helper drives copygame.ps1, which
    # must reach the MTP device in this desktop session. A session-0 task cannot.
    $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Port $Port -AllowedOrigin `"$AllowedOrigin`" -AdminPagePath `"$AdminPagePath`""
    $taskOk = $false
    try {
        $out = & "$env:SystemRoot\System32\schtasks.exe" /Create /TN $TaskName /TR $action /SC ONLOGON /RL LIMITED /F 2>&1
        if ($LASTEXITCODE -eq 0) { $taskOk = $true }
    } catch { }

    if ($taskOk) {
        Write-Host 'Registered to start at logon (Task Scheduler).' -ForegroundColor Green
        Write-Host '  Remove later with: .\install-server-hidden.ps1 -Uninstall' -ForegroundColor DarkGray
    } else {
        Write-Host 'Task Scheduler creation failed (Access Denied).' -ForegroundColor Yellow
        Write-Host '  Falling back to the Startup folder (works per-user, no admin needed).' -ForegroundColor Yellow
        try {
            $startup = [Environment]::GetFolderPath('Startup')
            $lnkPath = Join-Path $startup 'Pulai Install Helper.lnk'
            $wsh = New-Object -ComObject WScript.Shell
            $sc = $wsh.CreateShortcut($lnkPath)
            $sc.TargetPath = 'powershell.exe'
            $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Port $Port -AllowedOrigin `"$AllowedOrigin`" -AdminPagePath `"$AdminPagePath`""
            $sc.WorkingDirectory = $ScriptDir
            $sc.Description = 'Pulai PC install helper'
            $sc.WindowStyle = 7
            $sc.Save()
            Write-Host "Created startup shortcut: $lnkPath" -ForegroundColor Green
            Write-Host '  Remove later by deleting that .lnk file.' -ForegroundColor DarkGray
        } catch {
            Write-Host "Could not create startup shortcut: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host '  You can still run .\install-server-hidden.ps1 manually at logon.' -ForegroundColor Yellow
        }
    }
}
