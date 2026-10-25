#Requires -Version 5.1
<#
copygame.ps1 - Windows port of copygame.sh

Copies two batches to the Switch MTP SD Card, always essentials first:
  1. essential_files.txt - one exact file name per line, e.g. update/patched
     NSPs that have to be installed before the games.
  2. games_to_copy.txt - one game name per line; the folder whose title
     matches exactly is copied whole (case, quotes, dots and the "[NSP]"
     suffix are ignored; a partial name never wins, and a missing exact
     match is reported instead of copying a similar game).
     Blank lines and lines starting with '#' are ignored in both files.

Per-item and per-phase wall-clock timings are printed (not for --dry-run).

Windows gives MTP devices no drive letter, so Copy-Item / robocopy / xcopy
cannot address them - there is no path to hand those tools. This script talks
to the Windows Portable Devices (WPD) API instead and does the transfer
straight from the terminal, so there is no Explorer paste step and no extra
software to install.

The target is "<device name>\<folder path>", where the device name is what
Windows shows for the Switch under "This PC". With DBI that is normally
"DBI MTP Responder". A target saved by copygame.sh (a "mtp:/..." KIO URL) is
read and converted automatically, so your existing default keeps working.

  .\copygame.ps1                              # uses the saved default (mtp_target.txt)
  .\copygame.ps1 "DBI MTP Responder\5: SD Card install"
  .\copygame.ps1 --default "DBI MTP Responder\5: SD Card install"
  .\copygame.ps1 --dry-run                    # only print what would be copied
  .\copygame.ps1 --no-pause                   # don't pause between essentials and games
  .\copygame.ps1 --delay 10                   # wait 10s after each unconfirmed file
  .\copygame.ps1 --no-delay                   # skip the DBI catch-up pause
  .\copygame.ps1 --essentials                 # copy essentials, don't ask
  .\copygame.ps1 --skip-essentials            # skip essentials, don't ask

While files are transferring the script holds the PC awake, because idle sleep
would drop the device connection mid-copy. Closing the lid still sleeps it.
#>

$ScriptDir = $PSScriptRoot
$NspDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..\nsp'))
$ListFile = Join-Path $ScriptDir 'games_to_copy.txt'
$EssentialsFile = Join-Path $ScriptDir 'essential_files.txt'
$TargetFile = Join-Path $ScriptDir 'mtp_target.txt'

$DryRun = $false
$NoPause = $false
$SaveTarget = $false
$EssentialsMode = -1          # -1 ask, 1 copy, 0 skip
$DelaySeconds = 5             # pause after an unconfirmed file, so DBI can catch up
$Target = ''
$TargetGiven = $false

# ---- argument parsing --------------------------------------------------------
for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    switch ($arg) {
        '--dry-run'         { $DryRun = $true; break }
        '--no-pause'        { $NoPause = $true; break }
        '--no-delay'        { $DelaySeconds = 0; break }
        '--delay'           { if ($i + 1 -lt $args.Count) { $DelaySeconds = [int]$args[$i + 1]; $i++ } break }
        '--default'         { $SaveTarget = $true; break }
        '--essentials'      { $EssentialsMode = 1; break }
        '--skip-essentials' { $EssentialsMode = 0; break }
        '--tmp'             { break }   # accepted alias for a plain temporary target
        default {
            if ($arg -like '-*') {
                [Console]::Error.WriteLine("Unknown option: $arg")
                exit 2
            }
            $Target = $arg
            $TargetGiven = $true
            break
        }
    }
}

function Die {
    param([string]$Message)
    [Console]::Error.WriteLine("Error: $Message")
    exit 1
}

# Bytes to a friendly "1.5 GB" / "800.0 MB" string.
function Format-Size {
    param([double]$Bytes)
    if ($Bytes -lt 1073741824) { return ('{0:f1} MB' -f ($Bytes / 1048576)) }
    return ('{0:f1} GB' -f ($Bytes / 1073741824))
}

# Seconds to "42s" / "3m 18s" / "1h 04m".
function Format-Duration {
    param([int]$Seconds)
    if ($Seconds -lt 60)   { return ('{0}s' -f $Seconds) }
    if ($Seconds -lt 3600) { return ('{0}m {1:00}s' -f [int][Math]::Floor($Seconds / 60), ($Seconds % 60)) }
    return ('{0}h {1:02}m' -f [int][Math]::Floor($Seconds / 3600), [int][Math]::Floor(($Seconds % 3600) / 60))
}

# Fold a name down to a strict comparison key before matching: the " [...]"
# suffix, apostrophes/quotes, dots, dashes and case all vanish, so a list name
# lines up with the real folder ("Luigis Mansion" == "Luigi's Mansion [NSP]").
# The winner must then match the WHOLE key: a substring was never safe -
# "Minecraft" kept resolving to "Minecraft Dungeons".
function Get-NormalizedKey {
    param([string]$Name)
    if ([string]::IsNullOrEmpty($Name)) { return '' }
    $s = $Name
    $bracket = $s.IndexOf('[')
    if ($bracket -ge 0) { $s = $s.Substring(0, $bracket) }
    # ' " ' ' . , * ?   (built from code points so the file stays ASCII-safe)
    foreach ($cp in @(0x27, 0x22, 0x2019, 0x2018, 0x2E, 0x2C, 0x2A, 0x3F)) {
        $s = $s.Replace([string][char]$cp, '')
    }
    # - _
    $s = $s.Replace([string][char]0x2D, ' ').Replace([string][char]0x5F, ' ')
    while ($s.Contains('  ')) { $s = $s.Replace('  ', ' ') }
    return $s.Trim().ToLowerInvariant()
}

# Read a list file: trim whitespace, drop blanks and '#' comments. Missing or
# empty files simply yield an empty list.
function Read-ListFile {
    param([string]$Path)
    $items = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $Path)) { return $items }
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed.StartsWith('#')) { continue }
        $items.Add($trimmed)
    }
    return $items
}

# Describe a failure the way the user can act on, not just a hex code.
function Get-ErrorText {
    param($ErrorRecord)
    $ex = $ErrorRecord.Exception
    $hrText = $null
    while ($null -ne $ex) {
        if ($ex -is [System.Runtime.InteropServices.COMException]) {
            $hrText = [PulaiWpd.WpdErrors]::Describe($ex.HResult)
            break
        }
        $ex = $ex.InnerException
    }
    # A transfer that stopped mid-way says which step and how far it got;
    # that plus the HRESULT tells a late ack from a real failure.
    $outer = $ErrorRecord.Exception
    while ($null -ne $outer) {
        if ($outer -is [PulaiWpd.WpdTransferException]) {
            if ($null -ne $hrText) { return "$($outer.Message) ($hrText)" }
            return $outer.Message
        }
        $outer = $outer.InnerException
    }
    if ($null -ne $hrText) { return $hrText }
    return $ErrorRecord.Exception.Message
}

if (-not (Test-Path -LiteralPath $NspDir)) { Die "nsp folder not found at $NspDir" }

$requested = @(Read-ListFile $ListFile)
$essentials = @(Read-ListFile $EssentialsFile)
if ($requested.Count -eq 0) {
    Write-Host 'Note: games_to_copy.txt missing or empty: only essentials will be copied.'
}

# ---- the WPD layer -----------------------------------------------------------
$wpdSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using IStream = System.Runtime.InteropServices.ComTypes.IStream;

namespace PulaiWpd
{
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
    }

    // Every vtable order below was read out of the type library embedded in
    // C:\Windows\System32\PortableDeviceApi.dll, so the slots cannot drift
    // from what this Windows build actually exposes.

    [ComImport, Guid("a1567595-4c2f-4574-a6fa-ecef917b9a40"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDeviceManager
    {
        void GetDevices(IntPtr pPnPDeviceIDs, ref uint pcPnPDeviceIDs);
        void RefreshDeviceList();
        void GetDeviceFriendlyName(string pszPnPDeviceID, IntPtr pDeviceFriendlyName, ref uint pcchDeviceFriendlyName);
        void GetDeviceDescription(string pszPnPDeviceID, IntPtr pDeviceDescription, ref uint pcchDeviceDescription);
        void GetDeviceManufacturer(string pszPnPDeviceID, IntPtr pDeviceManufacturer, ref uint pcchDeviceManufacturer);
        void GetDeviceProperty(string pszPnPDeviceID, string pszDevicePropertyName, IntPtr pData, ref uint pcbData, ref uint pdwType);
        void GetPrivateDevices(IntPtr pPnPDeviceIDs, ref uint pcPnPDeviceIDs);
    }

    [ComImport, Guid("625e2df8-6392-4cf0-9ad1-3cfa5f17775c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDevice
    {
        void Open(string pszPnPDeviceID, IPortableDeviceValues pClientInfo);
        void SendCommand(uint dwFlags, IPortableDeviceValues pParameters, out IPortableDeviceValues ppResults);
        void Content(out IPortableDeviceContent ppContent);
        void Capabilities(out IntPtr ppCapabilities);
        void Cancel();
        void Close();
        void Advise(uint dwFlags, IntPtr pCallback, IPortableDeviceValues pParameters, out IntPtr ppszCookie);
        void Unadvise(string pszCookie);
        void GetPnPDeviceID(out IntPtr ppszPnPDeviceID);
    }

    [ComImport, Guid("6a96ed84-7c73-4480-9938-bf5af477d426"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDeviceContent
    {
        void EnumObjects(uint dwFlags, string pszParentObjectID, IPortableDeviceValues pFilter, out IEnumPortableDeviceObjectIDs ppEnum);
        void Properties(out IPortableDeviceProperties ppProperties);
        void Transfer(out IntPtr ppResources);
        void CreateObjectWithPropertiesOnly(IPortableDeviceValues pValues, ref IntPtr ppszObjectID);
        // Contrary to the samples that get copied around, this method does NOT
        // take a stream to read from: the device hands one back and you write
        // into it. Read from the type library rather than from a blog post.
        void CreateObjectWithPropertiesAndData(IPortableDeviceValues pValues, out IStream ppData, IntPtr pdwOptimalWriteBufferSize, ref IntPtr ppszCookie);
        void Delete(uint dwOptions, IntPtr pObjectIDs, out IntPtr ppResults);
        void GetObjectIDsFromPersistentUniqueIDs(IntPtr pPersistentUniqueIDs, out IntPtr ppObjectIDs);
        void Cancel();
        void Move(IntPtr pObjectIDs, string pszDestinationFolderObjectID, out IntPtr ppResults);
        void Copy(IntPtr pObjectIDs, string pszDestinationFolderObjectID, out IntPtr ppResults);
    }

    [ComImport, Guid("10ece955-cf41-4728-bfa0-41eedf1bbf19"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IEnumPortableDeviceObjectIDs
    {
        // Next reports S_FALSE (1) at the end of the enumeration, which the
        // default marshaller would turn into a thrown exception.
        [PreserveSig] int Next(uint cObjects, IntPtr pObjIDs, ref uint pcFetched);
        void Skip(uint cObjects);
        void Reset();
        void Clone(out IEnumPortableDeviceObjectIDs ppenum);
        void Cancel();
    }

    [ComImport, Guid("7f6d695c-03df-4439-a809-59266beee3a6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDeviceProperties
    {
        void GetSupportedProperties(string pszObjectID, out IPortableDeviceKeyCollection ppKeys);
        void GetPropertyAttributes(string pszObjectID, IntPtr key, out IntPtr ppAttributes);
        void GetValues(string pszObjectID, IPortableDeviceKeyCollection pKeys, out IPortableDeviceValues ppValues);
        void SetValues(string pszObjectID, IPortableDeviceValues pValues, out IntPtr ppResults);
        void Delete(string pszObjectID, IPortableDeviceKeyCollection pKeys);
        void Cancel();
    }

    [ComImport, Guid("dada2357-e0ad-492e-98db-dd61c53ba353"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDeviceKeyCollection
    {
        void GetCount(ref uint pcElems);
        void GetAt(uint dwIndex, IntPtr pKey);
        void Add(ref PROPERTYKEY key);
        void Clear();
        void RemoveAt(uint dwIndex);
    }

    // All 40 methods are declared in type-library order even though only a
    // handful are used: the ones actually called sit at fixed slots, so the
    // ones between them have to exist and be in the right place.
    [ComImport, Guid("6848f6f2-3155-4f86-b6f5-263eeeab3143"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDeviceValues
    {
        void GetCount(ref uint pcelt);
        void GetAt(uint index, IntPtr pKey, IntPtr pValue);
        void SetValue(IntPtr key, IntPtr pValue);
        void GetValue(IntPtr key, IntPtr pValue);
        void SetStringValue(ref PROPERTYKEY key, string value);
        void GetStringValue(ref PROPERTYKEY key, out IntPtr pValue);
        void SetUnsignedIntegerValue(ref PROPERTYKEY key, uint value);
        void GetUnsignedIntegerValue(ref PROPERTYKEY key, out uint pValue);
        void SetSignedIntegerValue(ref PROPERTYKEY key, int value);
        void GetSignedIntegerValue(ref PROPERTYKEY key, out int pValue);
        void SetUnsignedLargeIntegerValue(ref PROPERTYKEY key, ulong value);
        void GetUnsignedLargeIntegerValue(ref PROPERTYKEY key, out ulong pValue);
        void SetSignedLargeIntegerValue(ref PROPERTYKEY key, long value);
        void GetSignedLargeIntegerValue(ref PROPERTYKEY key, out long pValue);
        void SetFloatValue(IntPtr key, float value);
        void GetFloatValue(IntPtr key, out float pValue);
        void SetErrorValue(IntPtr key, int value);
        void GetErrorValue(IntPtr key, out int pValue);
        void SetKeyValue(IntPtr key, IntPtr value);
        void GetKeyValue(IntPtr key, IntPtr pValue);
        void SetBoolValue(IntPtr key, int value);
        void GetBoolValue(IntPtr key, out int pValue);
        void SetIUnknownValue(IntPtr key, IntPtr pValue);
        void GetIUnknownValue(IntPtr key, out IntPtr ppValue);
        void SetGuidValue(ref PROPERTYKEY key, ref Guid value);
        void GetGuidValue(ref PROPERTYKEY key, out Guid pValue);
        void SetBufferValue(IntPtr key, IntPtr pValue, uint cbValue);
        void GetBufferValue(IntPtr key, out IntPtr ppValue, ref uint pcbValue);
        void SetIPortableDeviceValuesValue(IntPtr key, IntPtr pValue);
        void GetIPortableDeviceValuesValue(IntPtr key, out IntPtr ppValue);
        void SetIPortableDevicePropVariantCollectionValue(IntPtr key, IntPtr pValue);
        void GetIPortableDevicePropVariantCollectionValue(IntPtr key, out IntPtr ppValue);
        void SetIPortableDeviceKeyCollectionValue(IntPtr key, IntPtr pValue);
        void GetIPortableDeviceKeyCollectionValue(IntPtr key, out IntPtr ppValue);
        void SetIPortableDeviceValuesCollectionValue(IntPtr key, IntPtr pValue);
        void GetIPortableDeviceValuesCollectionValue(IntPtr key, out IntPtr ppValue);
        void RemoveValue(ref PROPERTYKEY key);
        void CopyValuesFromPropertyStore(IntPtr pStore);
        void CopyValuesToPropertyStore(IntPtr pStore);
        void Clear();
    }

    [ComImport, Guid("0af10cec-2ecd-4b92-9581-34f6ae0637f3")]
    public class PortableDeviceManagerClass { }

    [ComImport, Guid("728a21c5-3d9e-48d7-9810-864848f0f404")]
    public class PortableDeviceClass { }

    [ComImport, Guid("0c15d503-d017-47ce-9016-7b3f978721cc")]
    public class PortableDeviceValuesClass { }

    [ComImport, Guid("de2d022d-2480-43be-97f0-d1fa2cf98f4f")]
    public class PortableDeviceKeyCollectionClass { }

    public class WpdDeviceInfo
    {
        public string PnPDeviceId;
        public string FriendlyName;
        public string Description;
        public string Manufacturer;
    }

    // Idle sleep would suspend the machine mid-transfer and kill the MTP
    // session, so hold the system awake for as long as bytes are moving.
    // The state belongs to this thread and Windows clears it when the process
    // exits, so a crash or Ctrl+C cannot leave the PC pinned awake.
    public static class PowerKeepAwake
    {
        const uint ES_CONTINUOUS = 0x80000000;
        const uint ES_SYSTEM_REQUIRED = 0x00000001;

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint SetThreadExecutionState(uint esFlags);

        public static void PreventSleep() { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED); }
        public static void AllowSleep() { SetThreadExecutionState(ES_CONTINUOUS); }
    }

    // Windows blocks Commit until the device answers the end-of-transfer
    // handshake, and DBI can take a minute to answer while it installs. Once
    // every byte has been handed over the file is the device's problem, so the
    // finalize is moved to a worker thread and the next file starts at once.
    // Anything still unfinished is drained when the session closes.
    //   returns 0 = confirmed, 1 = handed off (still finishing),
    //           2 = could not move off-thread (caller must commit),
    //           3 = failed fast (error set)
    public static class PendingCommits
    {
        class Entry
        {
            public IStream Sink;
            public IntPtr Cookie;
            public Thread Worker;
            public volatile bool Done;
            public volatile bool Completed;
            public Exception Error;
        }

        static readonly List<Entry> _entries = new List<Entry>();

        public static int TryCommit(IStream sink, IntPtr cookie, int graceMs, out Exception error)
        {
            error = null;
            Entry e = new Entry();
            e.Sink = sink;
            e.Cookie = cookie;
            e.Worker = new Thread(delegate()
            {
                try { e.Sink.Commit(0); e.Completed = true; }
                catch (Exception ex) { e.Error = ex; }
                finally { e.Done = true; }
            });
            e.Worker.IsBackground = true;
            try { e.Worker.SetApartmentState(ApartmentState.MTA); } catch { }
            try { e.Worker.Start(); } catch { return 2; }

            if (!e.Worker.Join(graceMs))
            {
                lock (_entries) { _entries.Add(e); }
                return 1;
            }
            if (e.Completed) return 0;
            // An apartment/marshaling failure means the call never reached the
            // device, so the stream is still usable: let the caller commit.
            if (IsThreadingProblem(e.Error)) return 2;
            error = e.Error;
            return 3;
        }

        // Wait for anything still in flight, then free it. Called when the
        // session closes so no worker outlives the device it is talking to.
        // The timeout is shared, not per entry, so a long queue cannot stall
        // the end of the run.
        public static void Drain(int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            Entry[] copy;
            lock (_entries) { copy = _entries.ToArray(); _entries.Clear(); }
            foreach (Entry e in copy)
            {
                int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (!e.Done && left > 0) e.Worker.Join(left);
                // Still running: leave it alone rather than yank the stream out
                // from under the device. The process is about to exit anyway.
                if (e.Done) Release(e);
            }
        }

        static void Release(Entry e)
        {
            try { if (e.Sink != null) Marshal.ReleaseComObject(e.Sink); } catch { }
            try { if (e.Cookie != IntPtr.Zero) Marshal.FreeCoTaskMem(e.Cookie); } catch { }
            e.Sink = null;
            e.Cookie = IntPtr.Zero;
        }

        static bool IsThreadingProblem(Exception ex)
        {
            for (Exception x = ex; x != null; x = x.InnerException)
            {
                COMException c = x as COMException;
                if (c != null && (((uint)c.HResult) == 0x8001010EU || ((uint)c.HResult) == 0x80010106U))
                    return true;
                if (x is InvalidCastException) return true;
            }
            return false;
        }
    }

    public static class WpdErrors
    {
        public static string Describe(int hr)
        {
            switch ((uint)hr)
            {
                case 0x80070005: return "access denied";
                case 0x8007001F: return "device reported a failure (is the Switch still in DBI?)";
                case 0x8007007E: return "WPD service or driver is not available on this PC";
                case 0x80040154: return "WPD COM classes are not registered";
                case 0x80004002: return "interface not supported";
                case 0x80070057: return "invalid parameter";
                case 0x802A0001: return "device is already opened by another program (close Explorer's device window)";
                case 0x802A0002: return "device is not open";
                case 0x802A0005: return "object was not committed (transfer interrupted?)";
                case 0x802A0006: return "device is hung - unplug it and reconnect";
                case 0x80070070: return "not enough free space on the device";
                case 0x80070079: return "the device stopped responding mid-transfer (DBI is probably busy installing)";
                case 0: return "the device gave no error code";
                default: return "0x" + ((uint)hr).ToString("X8");
            }
        }
    }

    // Carries "which step, how many bytes" next to the raw HRESULT. A bare
    // 0x80070079 never says whether the device already holds the whole file,
    // and that is the difference between a real failure and a late ack.
    public class WpdTransferException : Exception
    {
        public WpdTransferException(string message, Exception inner) : base(message, inner) { }
    }

    public class WpdDevice : IDisposable
    {
        public const string RootObjectId = "DEVICE";

        static PROPERTYKEY Pk(string fmtid, uint pid)
        {
            PROPERTYKEY k = new PROPERTYKEY();
            k.fmtid = new Guid(fmtid);
            k.pid = pid;
            return k;
        }

        // WPD_OBJECT_PROPERTIES_V1. Note the fmtid: EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C.
        const string ObjectFmtId = "ef6b490d-5cd8-437a-affc-da8b60ee4a3c";
        static PROPERTYKEY K_PARENT_ID = Pk(ObjectFmtId, 3);
        static PROPERTYKEY K_NAME = Pk(ObjectFmtId, 4);
        static PROPERTYKEY K_FORMAT = Pk(ObjectFmtId, 6);
        static PROPERTYKEY K_CONTENT_TYPE = Pk(ObjectFmtId, 7);
        static PROPERTYKEY K_SIZE = Pk(ObjectFmtId, 11);
        static PROPERTYKEY K_ORIGINAL_FILE_NAME = Pk(ObjectFmtId, 12);

        const string ClientFmtId = "204d9f0c-2292-4080-9f42-40664e70f859";
        static PROPERTYKEY K_CLIENT_NAME = Pk(ClientFmtId, 2);
        static PROPERTYKEY K_CLIENT_MAJOR_VERSION = Pk(ClientFmtId, 3);
        static PROPERTYKEY K_CLIENT_MINOR_VERSION = Pk(ClientFmtId, 4);
        static PROPERTYKEY K_CLIENT_REVISION = Pk(ClientFmtId, 5);

        // There is no WPD_OBJECT_FORMAT_MTP; an ordinary file is UNSPECIFIED and
        // a folder is PROPERTIES_ONLY (it carries no data stream).
        static readonly Guid FMT_UNSPECIFIED = new Guid("30000000-ae6c-4804-98ba-c57b46965fe7");
        static readonly Guid FMT_PROPERTIES_ONLY = new Guid("30010000-ae6c-4804-98ba-c57b46965fe7");
        static readonly Guid CT_GENERIC_FILE = new Guid("0085e0a6-8d34-45d7-bc5c-447e59c73d48");
        static readonly Guid CT_FOLDER = new Guid("27e2e392-a111-48e0-ab0c-e17705a05f85");
        static readonly Guid CT_FUNCTIONAL_OBJECT = new Guid("99ed0160-17ff-4c44-9d98-1d7a6f941921");

        IPortableDevice _device;
        IPortableDeviceContent _content;
        IPortableDeviceProperties _props;

        public string PnPDeviceId { get; private set; }
        public string FriendlyName { get; set; }

        static string ReadDeviceString(IPortableDeviceManager mgr, string pnp, int which)
        {
            uint cch = 0;
            if (which == 2) mgr.GetDeviceFriendlyName(pnp, IntPtr.Zero, ref cch);
            else if (which == 3) mgr.GetDeviceDescription(pnp, IntPtr.Zero, ref cch);
            else mgr.GetDeviceManufacturer(pnp, IntPtr.Zero, ref cch);
            if (cch == 0) return "";

            IntPtr buffer = Marshal.AllocCoTaskMem(checked((int)(cch + 1) * 2));
            try
            {
                if (which == 2) mgr.GetDeviceFriendlyName(pnp, buffer, ref cch);
                else if (which == 3) mgr.GetDeviceDescription(pnp, buffer, ref cch);
                else mgr.GetDeviceManufacturer(pnp, buffer, ref cch);
                return Marshal.PtrToStringUni(buffer);
            }
            finally { Marshal.FreeCoTaskMem(buffer); }
        }

        public static List<WpdDeviceInfo> ListDevices()
        {
            IPortableDeviceManager mgr = (IPortableDeviceManager)new PortableDeviceManagerClass();
            List<WpdDeviceInfo> result = new List<WpdDeviceInfo>();
            try
            {
                mgr.RefreshDeviceList();
                uint count = 0;
                mgr.GetDevices(IntPtr.Zero, ref count);
                if (count == 0) return result;

                IntPtr array = Marshal.AllocCoTaskMem(checked((int)count * IntPtr.Size));
                try
                {
                    mgr.GetDevices(array, ref count);
                    for (int i = 0; i < (int)count; i++)
                    {
                        IntPtr slot = Marshal.ReadIntPtr(array, i * IntPtr.Size);
                        string pnp = Marshal.PtrToStringUni(slot);
                        WpdDeviceInfo info = new WpdDeviceInfo();
                        info.PnPDeviceId = pnp;
                        info.FriendlyName = ReadDeviceString(mgr, pnp, 2);
                        info.Description = ReadDeviceString(mgr, pnp, 3);
                        info.Manufacturer = ReadDeviceString(mgr, pnp, 4);
                        result.Add(info);
                        if (slot != IntPtr.Zero) Marshal.FreeCoTaskMem(slot);
                    }
                }
                finally { Marshal.FreeCoTaskMem(array); }
            }
            finally { Marshal.ReleaseComObject(mgr); }
            return result;
        }

        public static WpdDevice Open(string pnpDeviceId)
        {
            IPortableDevice device = (IPortableDevice)new PortableDeviceClass();
            IPortableDeviceValues clientInfo = null;
            try
            {
                // Open() dereferences the client info, so it can never be null
                // here even though the documentation says it may be.
                clientInfo = (IPortableDeviceValues)new PortableDeviceValuesClass();
                clientInfo.SetStringValue(ref K_CLIENT_NAME, "copygame.ps1");
                clientInfo.SetUnsignedIntegerValue(ref K_CLIENT_MAJOR_VERSION, 1);
                clientInfo.SetUnsignedIntegerValue(ref K_CLIENT_MINOR_VERSION, 0);
                clientInfo.SetUnsignedIntegerValue(ref K_CLIENT_REVISION, 1);
                device.Open(pnpDeviceId, clientInfo);

                IPortableDeviceContent content;
                device.Content(out content);
                IPortableDeviceProperties props;
                content.Properties(out props);

                WpdDevice d = new WpdDevice();
                d._device = device;
                d._content = content;
                d._props = props;
                d.PnPDeviceId = pnpDeviceId;
                return d;
            }
            catch
            {
                try { device.Close(); } catch { }
                throw;
            }
            finally
            {
                // Open only reads the client info; the device keeps its own copy.
                if (clientInfo != null)
                {
                    try { Marshal.ReleaseComObject(clientInfo); } catch { }
                }
            }
        }

        void EnsureOpen()
        {
            if (_content == null) throw new InvalidOperationException("device is not open");
        }

        public List<string> ListChildren(string objectId)
        {
            EnsureOpen();
            List<string> ids = new List<string>();
            IEnumPortableDeviceObjectIDs en;
            _content.EnumObjects(0, objectId, null, out en);
            try
            {
                while (true)
                {
                    IntPtr buffer = Marshal.AllocCoTaskMem(IntPtr.Size * 64);
                    try
                    {
                        uint fetched = 0;
                        int hr = en.Next(64, buffer, ref fetched);
                        if (hr != 0 && hr != 1) Marshal.ThrowExceptionForHR(hr);
                        for (int i = 0; i < (int)fetched; i++)
                        {
                            IntPtr slot = Marshal.ReadIntPtr(buffer, i * IntPtr.Size);
                            if (slot == IntPtr.Zero) continue;
                            ids.Add(Marshal.PtrToStringUni(slot));
                            Marshal.FreeCoTaskMem(slot);
                        }
                        if (fetched == 0 || hr != 0) break;
                    }
                    finally { Marshal.FreeCoTaskMem(buffer); }
                }
            }
            finally { Marshal.ReleaseComObject(en); }
            return ids;
        }

        static string GetString(IPortableDeviceValues values, PROPERTYKEY key)
        {
            try
            {
                IntPtr p;
                values.GetStringValue(key, out p);
                try { return Marshal.PtrToStringUni(p); }
                finally { if (p != IntPtr.Zero) Marshal.FreeCoTaskMem(p); }
            }
            catch (COMException) { return null; }
        }

        public string GetObjectName(string objectId)
        {
            EnsureOpen();
            IPortableDeviceKeyCollection keys = (IPortableDeviceKeyCollection)new PortableDeviceKeyCollectionClass();
            keys.Add(K_NAME);
            keys.Add(K_ORIGINAL_FILE_NAME);
            IPortableDeviceValues values;
            try { _props.GetValues(objectId, keys, out values); }
            finally { Marshal.ReleaseComObject(keys); }
            try
            {
                string name = GetString(values, K_NAME);
                if (string.IsNullOrEmpty(name)) name = GetString(values, K_ORIGINAL_FILE_NAME);
                return name;
            }
            finally { Marshal.ReleaseComObject(values); }
        }

        public bool IsFolder(string objectId)
        {
            EnsureOpen();
            IPortableDeviceKeyCollection keys = (IPortableDeviceKeyCollection)new PortableDeviceKeyCollectionClass();
            keys.Add(K_CONTENT_TYPE);
            IPortableDeviceValues values;
            try { _props.GetValues(objectId, keys, out values); }
            finally { Marshal.ReleaseComObject(keys); }
            try
            {
                try
                {
                    Guid contentType;
                    values.GetGuidValue(K_CONTENT_TYPE, out contentType);
                    // Storage functional objects report FUNCTIONAL_OBJECT too.
                    return contentType == CT_FOLDER || contentType == CT_FUNCTIONAL_OBJECT;
                }
                catch (COMException) { return false; }
            }
            finally { Marshal.ReleaseComObject(values); }
        }

        public string CreateFolder(string parentId, string name)
        {
            EnsureOpen();
            IPortableDeviceValues props = (IPortableDeviceValues)new PortableDeviceValuesClass();
            try
            {
                props.SetStringValue(ref K_PARENT_ID, parentId);
                props.SetStringValue(ref K_NAME, name);
                Guid contentType = CT_FOLDER;
                props.SetGuidValue(ref K_CONTENT_TYPE, ref contentType);
                Guid format = FMT_PROPERTIES_ONLY;
                props.SetGuidValue(ref K_FORMAT, ref format);

                IntPtr objectId = IntPtr.Zero;
                _content.CreateObjectWithPropertiesOnly(props, ref objectId);
                try { return Marshal.PtrToStringUni(objectId); }
                finally { if (objectId != IntPtr.Zero) Marshal.FreeCoTaskMem(objectId); }
            }
            finally { Marshal.ReleaseComObject(props); }
        }

        // Returns null when the device confirmed the file, or a note when every
        // byte was sent but the device never answered the final handshake.
        public string CreateFile(string parentId, string localPath, string name, Action<string, long> onFileStarted)
        {
            EnsureOpen();
            long length = new FileInfo(localPath).Length;
            if (onFileStarted != null) onFileStarted(name, length);

            IPortableDeviceValues props = (IPortableDeviceValues)new PortableDeviceValuesClass();
            try
            {
                props.SetStringValue(ref K_PARENT_ID, parentId);
                props.SetStringValue(ref K_NAME, name);
                props.SetStringValue(ref K_ORIGINAL_FILE_NAME, name);
                Guid contentType = CT_GENERIC_FILE;
                props.SetGuidValue(ref K_CONTENT_TYPE, ref contentType);
                Guid format = FMT_UNSPECIFIED;
                props.SetGuidValue(ref K_FORMAT, ref format);
                props.SetUnsignedLargeIntegerValue(ref K_SIZE, (ulong)length);

                IStream sink = null;
                IntPtr cookie = IntPtr.Zero;
                int optimal = 0;
                string phase = "opening the transfer";
                long sent = 0;
                try
                {
                    try
                    {
                        // The type library declares this as an in/out ULONG*, so the
                        // driver gets to say how big it wants the writes. NULL also
                        // works, but then we are guessing the chunk size.
                        IntPtr optimalPtr = Marshal.AllocHGlobal(4);
                        try
                        {
                            Marshal.WriteInt32(optimalPtr, 0);
                            _content.CreateObjectWithPropertiesAndData(props, out sink, optimalPtr, ref cookie);
                            optimal = Marshal.ReadInt32(optimalPtr);
                        }
                        finally { Marshal.FreeHGlobal(optimalPtr); }
                    }
                    catch (Exception ex)
                    {
                        throw new WpdTransferException(
                            "the device refused to open a transfer for '" + name + "'", ex);
                    }
                    // Honour the driver's answer unless it is nonsense.
                    int chunk = 128 * 1024;
                    if (optimal >= 4096 && optimal <= 4 * 1024 * 1024) chunk = optimal;
                    phase = "sending data";
                    try
                    {
                        using (FileStream fs = new FileStream(localPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                        {
                            byte[] buffer = new byte[chunk];
                            int read;
                            while ((read = fs.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                sink.Write(buffer, (int)read, IntPtr.Zero);
                                sent += read;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        throw new WpdTransferException(
                            "transfer for '" + name + "' stopped " + phase +
                            " at " + sent + " of " + length + " bytes", ex);
                    }

                    phase = "committing";
                    // Every byte is across by now (a short send throws above), so
                    // the handshake is the only thing left. Give it a short grace,
                    // then move on and let a worker finish it.
                    Exception commitError = null;
                    int commitState = PendingCommits.TryCommit(sink, cookie, 2500, out commitError);
                    if (commitState == 1)
                    {
                        // The worker owns the stream now, so the finally below
                        // must not release it. Every other state leaves it here.
                        sink = null;
                        cookie = IntPtr.Zero;
                        return "all " + length + " bytes were sent; the device is still finishing it " +
                               "(DBI is probably installing) - carrying on with the next file, " +
                               "check the Switch before copying this one again";
                    }
                    if (commitState == 0) return null;
                    if (commitState == 2)
                    {
                        // Could not move the call to another thread; take the wait.
                        try { sink.Commit(0); return null; }
                        catch (Exception ex) { commitError = ex; }
                    }
                    // The handshake failed after a full send: the file is there.
                    return "all " + length + " bytes were sent, but the device never confirmed " +
                           "the end of the transfer (" + WpdErrors.Describe(HResultOf(commitError)) +
                           ") - probably still installing; check the Switch before copying this one again";
                }
                finally
                {
                    if (sink != null) Marshal.ReleaseComObject(sink);
                    if (cookie != IntPtr.Zero) Marshal.FreeCoTaskMem(cookie);
                }
            }
            finally { Marshal.ReleaseComObject(props); }
        }

        // The code behind a failure, for a note that still explains itself.
        // Only used when every byte was already sent, so it never decides
        // success - it just says why the confirmation went missing.
        static int HResultOf(Exception ex)
        {
            for (Exception e = ex; e != null; e = e.InnerException)
            {
                if (e is COMException) return ((COMException)e).HResult;
            }
            return 0;
        }

        public void Dispose()
        {
            // Let any finalize still talking to the device finish first.
            PendingCommits.Drain(10000);
            if (_props != null) { try { Marshal.ReleaseComObject(_props); } catch { } _props = null; }
            if (_content != null) { try { Marshal.ReleaseComObject(_content); } catch { } _content = null; }
            if (_device != null)
            {
                try { _device.Close(); } catch { }
                try { Marshal.ReleaseComObject(_device); } catch { }
                _device = null;
            }
        }
    }
}
'@

# PowerShell keeps compiled types for the life of the window, so an edit to the
# C# below is invisible until the window closes. Stamp each compile with a hash
# of its source and restart in a fresh process when the two disagree.
function Get-SourceBuild {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
        return ([System.BitConverter]::ToString($bytes) -replace '-', '').Substring(0, 16)
    } finally { $sha.Dispose() }
}
$build = Get-SourceBuild $wpdSource
$loadedBuild = if ('PulaiWpd.CopygameBuild' -as [type]) { [PulaiWpd.CopygameBuild]::Build } else { $null }

if (-not ('PulaiWpd.WpdDevice' -as [type])) {
    try {
        $stamped = $wpdSource + "`nnamespace PulaiWpd { public static class CopygameBuild { public const string Build = `"$build`"; } }"
        Add-Type -TypeDefinition $stamped -ErrorAction Stop
    } catch {
        Die "could not compile the WPD layer: $($_.Exception.Message)"
    }
} elseif ($loadedBuild -ne $build) {
    Write-Host 'This window still has an older copy of the WPD layer loaded (PowerShell keeps compiled types until the window closes). Re-running in a fresh process...'
    $exe = (Get-Process -Id $PID).Path
    $argv = (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath)) + ($args | ForEach-Object { if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ } })) -join ' '
    $proc = Start-Process -FilePath $exe -ArgumentList $argv -NoNewWindow -Wait -PassThru
    exit $proc.ExitCode
}

# ---- device + destination ----------------------------------------------------
$devices = @()
try {
    $devices = [PulaiWpd.WpdDevice]::ListDevices()
} catch {
    Die "could not enumerate MTP devices: $(Get-ErrorText $_)"
}

function Find-WpdDevice {
    param($List, [string]$Want)
    $wantKey = Get-NormalizedKey $Want
    foreach ($d in $List) {
        if ((Get-NormalizedKey $d.FriendlyName) -eq $wantKey) { return $d }
    }
    foreach ($d in $List) {
        if (-not [string]::IsNullOrEmpty($d.FriendlyName)) {
            if ($d.FriendlyName.IndexOf($Want, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $d }
        }
    }
    return $null
}

function ConvertTo-WpdTarget {
    param([string]$Raw)
    $s = $Raw.Trim()
    if ($s -match '^(?i)mtp:') { $s = $s.Substring(4) }
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($piece in ($s -replace '/', '\').Split('\')) {
        $t = $piece.Trim()
        if ($t.Length -gt 0) { $parts.Add($t) }
    }
    if ($parts.Count -eq 0) { return $null }
    $path = @()
    if ($parts.Count -gt 1) { $path = @($parts.GetRange(1, $parts.Count - 1)) }
    return New-Object psobject -Property @{ Device = $parts[0]; Path = $path }
}

# A saved target from copygame.sh is a KIO URL; translate it rather than
# refusing to run, so the existing default keeps working on Windows.
if ([string]::IsNullOrEmpty($Target) -and (-not $TargetGiven) -and (Test-Path -LiteralPath $TargetFile)) {
    $Target = (Get-Content -LiteralPath $TargetFile -TotalCount 1)
    if (-not [string]::IsNullOrWhiteSpace($Target)) {
        Write-Host "Using saved target: $($Target.Trim())"
        $Target = $Target.Trim()
    } else {
        $Target = ''
    }
}

$parsed = $null
if (-not [string]::IsNullOrEmpty($Target)) {
    $parsed = ConvertTo-WpdTarget $Target
    if ($null -eq $parsed) { Die "target '$Target' is not a folder - use <device>\<folder>, e.g. DBI MTP Responder\5: SD Card install" }
}

if ($devices.Count -eq 0) {
    if ($DryRun) {
        Write-Host 'Note: no MTP device attached right now - showing what would be copied.'
    } else {
        Die "no MTP device found. Plug the Switch in with DBI open (MTP responder), then try again."
    }
}

$chosen = $null
$probeDevices = $false
if ($null -ne $parsed) {
    $chosen = Find-WpdDevice $devices $parsed.Device
    if ($null -eq $chosen -and $devices.Count -gt 0) {
        # The saved target usually carries the SteamOS name ("DBI MTP Responder"),
        # but the same Switch enumerates on Windows as "Switch". Refusing would
        # break a default that works on Linux, so instead try the folder part
        # against every attached device and take the first that really has it.
        $probeDevices = $true
    }
} elseif ($devices.Count -eq 1) {
    $chosen = $devices[0]
    Write-Host "Using the only MTP device attached: $($chosen.FriendlyName)"
} elseif ($devices.Count -gt 1) {
    Write-Host 'More than one MTP device is attached:'
    foreach ($d in $devices) { Write-Host "  - $($d.FriendlyName)" }
    Die 'rerun with a target, e.g. .\copygame.ps1 "Switch\5: SD Card install"'
}

$session = $null
$destId = $null
$targetLabel = $null

function Resolve-WpdPath {
    param($Session, [string[]]$Components)
    $current = [PulaiWpd.WpdDevice]::RootObjectId
    foreach ($component in $Components) {
        $key = Get-NormalizedKey $component
        $children = $Session.ListChildren($current)
        $next = $null
        foreach ($child in $children) {
            if ((Get-NormalizedKey $Session.GetObjectName($child)) -eq $key) { $next = $child; break }
        }
        if ($null -eq $next) {
            # One level deeper: a storage can sit between the device and the folder.
            foreach ($child in $children) {
                if (-not $Session.IsFolder($child)) { continue }
                foreach ($grandChild in $Session.ListChildren($child)) {
                    if ((Get-NormalizedKey $Session.GetObjectName($grandChild)) -eq $key) { $next = $grandChild; break }
                }
                if ($null -ne $next) { break }
            }
        }
        if ($null -eq $next) { return $null }
        $current = $next
    }
    return $current
}

# Switching DBI between MTP and full mode makes Windows drop and re-add the
# device, so the session from before the pause is already dead. Poll until the
# target really answers again instead of writing into nothing.
function Wait-For-MtpTarget {
    param($Spec, [int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $started = Get-Date
    $lastNote = -10
    while ((Get-Date) -lt $deadline) {
        $attached = @()
        try { $attached = @([PulaiWpd.WpdDevice]::ListDevices()) } catch { }
        if ($attached.Count -gt 0) {
            $named = $null
            try { $named = Find-WpdDevice $attached $Spec.Device } catch { }
            $ordered = @()
            if ($null -ne $named) {
                $ordered += $named
                $ordered += @($attached | Where-Object { $_.PnPDeviceId -ne $named.PnPDeviceId })
            } else {
                $ordered = @($attached)
            }
            foreach ($d in $ordered) {
                # With no folder to match on there is nothing to identify the
                # device by, so an unattached name must never resolve to some
                # other MTP device that happens to be plugged in.
                if (($null -eq $Spec.Path) -or ($Spec.Path.Count -eq 0)) {
                    if (($null -eq $named) -or ($d.PnPDeviceId -ne $named.PnPDeviceId)) { continue }
                }
                $candidate = $null
                try {
                    $candidate = [PulaiWpd.WpdDevice]::Open($d.PnPDeviceId)
                    $candidate.FriendlyName = $d.FriendlyName
                    $id = $null
                    if ($null -eq $Spec.Path -or $Spec.Path.Count -eq 0) {
                        $id = [PulaiWpd.WpdDevice]::RootObjectId
                    } else {
                        $id = Resolve-WpdPath $candidate @($Spec.Path)
                    }
                    if ($null -ne $id) {
                        return New-Object psobject -Property @{ Session = $candidate; DestId = $id }
                    }
                } catch { }
                if ($null -ne $candidate) { $candidate.Dispose() }
            }
        }
        $waiting = [int]((Get-Date) - $started).TotalSeconds
        if ($waiting - $lastNote -ge 5) {
            Write-Host ('  ... still waiting for the Switch ({0}s)' -f $waiting)
            $lastNote = $waiting
        }
        Start-Sleep -Milliseconds 750
    }
    return $null
}

if ($probeDevices -and $parsed.Path.Count -gt 0) {
    # Only the folder part is portable, so match on that and report the swap.
    foreach ($d in $devices) {
        $candidate = $null
        try {
            $candidate = [PulaiWpd.WpdDevice]::Open($d.PnPDeviceId)
            $candidate.FriendlyName = $d.FriendlyName
        } catch {
            if ($DryRun) { Write-Host "Note: could not open '$($d.FriendlyName)': $(Get-ErrorText $_)" }
            continue
        }
        $probe = Resolve-WpdPath $candidate @($parsed.Path)
        if ($null -ne $probe) {
            $session = $candidate
            Write-Host "Note: target names '$($parsed.Device)', which is not attached on this PC,"
            Write-Host "      but '$($d.FriendlyName)' holds '$($parsed.Path -join '\')' - using that."
            break
        }
        $candidate.Dispose()
    }
    if ($null -eq $session) {
        Write-Host "Target device '$($parsed.Device)' is not attached, and no attached device holds '$($parsed.Path -join '\')':"
        foreach ($d in $devices) { Write-Host "  - $($d.FriendlyName)" }
        if ($DryRun) {
            Write-Host 'Note: showing what would be copied anyway.'
        } else {
            Die 'plug the Switch in with DBI open, or rerun with a target like "Switch\5: SD Card install"'
        }
    }
} elseif ($probeDevices) {
    # A device name with no folder has nothing to match on, so ask which one.
    Write-Host "Device '$($parsed.Device)' is not attached; MTP devices on this PC:"
    foreach ($d in $devices) { Write-Host "  - $($d.FriendlyName)" }
    if ($DryRun) {
        Write-Host 'Note: showing what would be copied anyway.'
    } else {
        Die 'pick one of the names above'
    }
} elseif ($null -ne $chosen) {
    try {
        $session = [PulaiWpd.WpdDevice]::Open($chosen.PnPDeviceId)
        $session.FriendlyName = $chosen.FriendlyName
    } catch {
        if (-not $DryRun) { Die "could not open '$($chosen.FriendlyName)': $(Get-ErrorText $_)" }
        Write-Host "Note: could not open '$($chosen.FriendlyName)': $(Get-ErrorText $_)"
    }
}

if ($null -ne $session) {
    if ($null -ne $parsed) {
        $components = @()
        if ($parsed.Path.Count -gt 0) { $components = @($parsed.Path) }
        if ($components.Count -eq 0) {
            Write-Host 'Note: target names only a device, not a folder - copying to the device root.'
            $destId = [PulaiWpd.WpdDevice]::RootObjectId
        } else {
            $destId = Resolve-WpdPath $session $components
            if ($null -eq $destId) {
                Write-Host "Could not find '$($components -join '\')' inside $($session.FriendlyName). Contents:"
                foreach ($child in $session.ListChildren([PulaiWpd.WpdDevice]::RootObjectId)) {
                    Write-Host "  - $($session.GetObjectName($child))"
                }
                if (-not $DryRun) { Die 'fix the target path and try again' }
            }
        }
    } else {
        $destId = [PulaiWpd.WpdDevice]::RootObjectId
    }
    if ($null -ne $parsed -and $parsed.Path.Count -gt 0) {
        $targetLabel = "$($session.FriendlyName)$([char]0x5C)$($parsed.Path -join [char]0x5C)"
    } else {
        $targetLabel = $session.FriendlyName
    }
    if ($null -ne $destId) { Write-Host "Copying into: $targetLabel" }
}

if ($TargetGiven -and $SaveTarget -and -not [string]::IsNullOrEmpty($Target)) {
    Set-Content -LiteralPath $TargetFile -Value $Target -Encoding ASCII
    Write-Host "Default target saved to $TargetFile - next time just run '.\copygame.ps1'."
} elseif ($TargetGiven) {
    Write-Host 'Temporary target for this run only (saved default untouched).'
}

# ---- copy helpers ------------------------------------------------------------
# Files the device took in full but never confirmed: counted separately, never
# as a failure, because DBI installs them while the handshake is still pending.
$script:unconfirmed = 0

function Copy-FolderTree {
    param($Session, [string]$ParentId, [string]$LocalPath)
    $name = [System.IO.Path]::GetFileName($LocalPath.TrimEnd('\', '/'))
    $newId = $Session.CreateFolder($ParentId, $name)
    foreach ($entry in [System.IO.Directory]::GetFileSystemEntries($LocalPath)) {
        if ([System.IO.Directory]::Exists($entry)) {
            Copy-FolderTree $Session $newId $entry | Out-Null
        } else {
            $fileName = [System.IO.Path]::GetFileName($entry)
            $started = [System.Diagnostics.Stopwatch]::StartNew()
            $note = $null
            try {
                $note = $Session.CreateFile($newId, $entry, $fileName, $null)
            } finally {
                $started.Stop()
            }
            $size = [double](Get-Item -LiteralPath $entry -Force).Length
            $line = '      file {0} ({1})' -f $fileName, (Format-Size $size)
            if ($started.Elapsed.TotalSeconds -gt 0) {
                $line = '{0} -> {1:f1}s, {2:f1} MB/s' -f $line, $started.Elapsed.TotalSeconds, ($size / 1048576 / $started.Elapsed.TotalSeconds)
            }
            Write-Host $line
            if ($note) {
                $script:unconfirmed++
                Write-Host ('      ! {0}' -f $note)
                # Give DBI a moment to finish the previous file before starting
                # the next one, so the MTP device isn't overwhelmed.
                if ($DelaySeconds -gt 0) {
                    Write-Host ("      (pausing {0}s for DBI...)" -f $DelaySeconds)
                    Start-Sleep -Seconds $DelaySeconds
                }
            }
        }
    }
    return $newId
}

function Copy-ToTarget {
    param($Session, [string]$DestId, [string]$SourcePath, [string]$Label)
    if ($DryRun) {
        Write-Host "  [dry] would copy $Label"
        return $true
    }
    if ($null -eq $DestId) {
        Write-Host "  !! no destination resolved, cannot copy $Label"
        return $false
    }
    try {
        # Hold the machine awake only while bytes are actually moving, so a
        # long file cannot be cut off by the idle sleep timer.
        try { [PulaiWpd.PowerKeepAwake]::PreventSleep() } catch { }
        if (Test-Path -LiteralPath $SourcePath -PathType Container) {
            Copy-FolderTree $Session $DestId $SourcePath | Out-Null
        } else {
            $note = $Session.CreateFile($DestId, $SourcePath, [System.IO.Path]::GetFileName($SourcePath), $null)
            if ($note) {
                $script:unconfirmed++
                Write-Host "  ! $note"
            }
        }
        return $true
    } catch {
        Write-Host "  !! failed to copy $Label to $targetLabel ($(Get-ErrorText $_))"
        return $false
    } finally {
        try { [PulaiWpd.PowerKeepAwake]::AllowSleep() } catch { }
    }
}

# ---- ask about essentials before copying anything -----------------------------
# Essentials restart the console's state; only the user knows if they were
# already installed this session, so ask instead of judging by presence.
$copyEss = $false
if ($DryRun) {
    $copyEss = $true                    # dry run shows everything
} elseif ($EssentialsMode -eq 0) {
    $copyEss = $false
} elseif ($EssentialsMode -eq 1) {
    $copyEss = $true
} elseif ($essentials.Count -eq 0) {
    $copyEss = $false
} elseif ($NoPause -or [Console]::IsInputRedirected) {
    # No interactive terminal to ask on (the admin page runs this headlessly, and
    # a redirected stdin can never answer). Default to skipping: essentials reset
    # console state, so repeating them unasked is the riskier choice. Wanted
    # essentials are requested up front with --essentials, which never gets here.
    Write-Host 'Note: no interactive prompt available; skipping essentials.'
    Write-Host '      (use --essentials to copy them without asking)'
    $copyEss = $false
} else {
    Write-Host "Copy $($essentials.Count) essential file(s) first? (already installed this session? then skip)"
    $answer = (Read-Host '> Essentials first? [Y/n]').Trim()
    $copyEss = -not ($answer -match '^n(o)?$')
}

# ---- essentials ---------------------------------------------------------------
$essentialOk = 0
$essentialFail = 0
$essSeconds = 0
$essentialsWatch = [System.Diagnostics.Stopwatch]::StartNew()
if ($copyEss -and $essentials.Count -gt 0) {
    Write-Host '--- Essentials ---'
    $totalEssentials = $essentials.Count
    $index = 0
    foreach ($item in $essentials) {
        if ([string]::IsNullOrWhiteSpace($item)) { continue }
        $index++
        $itemKey = Get-NormalizedKey $item
        $foundFile = $null

        # Exact key first, so a near-name file (prod.keys.bak) can never win
        # over the real file when both are present.
        foreach ($file in (Get-ChildItem -LiteralPath $NspDir -File -Force -ErrorAction SilentlyContinue)) {
            if ((Get-NormalizedKey $file.Name) -eq $itemKey) { $foundFile = $file; break }
        }
        # Fall back to the old substring only when nothing matches exactly, in
        # case the essential list carries a slightly different spelling.
        if ($null -eq $foundFile) {
            foreach ($file in (Get-ChildItem -LiteralPath $NspDir -File -Force -ErrorAction SilentlyContinue)) {
                if ($file.Name.IndexOf($item, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $foundFile = $file; break }
            }
        }

        if ($null -eq $foundFile) {
            Write-Host ('[{0}/{1}] Not Found: {2}' -f $index, $totalEssentials, $item)
            $essentialFail++
            continue
        }
        Write-Host ('[{0}/{1}] Found: {2}' -f $index, $totalEssentials, $foundFile.Name)
        $itemWatch = [System.Diagnostics.Stopwatch]::StartNew()
        if (Copy-ToTarget $session $destId $foundFile.FullName $foundFile.Name) {
            $essentialOk++
            if (-not $DryRun) {
                $itemWatch.Stop()
                Write-Host ('      -> took {0}' -f (Format-Duration ([int]$itemWatch.Elapsed.TotalSeconds)))
            }
        } else {
            $essentialFail++
        }
    }
    if (-not $DryRun) {
        $essentialsWatch.Stop()
        $essSeconds = [int]$essentialsWatch.Elapsed.TotalSeconds
        Write-Host ('Essentials finished in {0}.' -f (Format-Duration $essSeconds))
    }
} elseif ($essentials.Count -eq 0) {
    Write-Host 'Note: essential_files.txt missing or empty: skipping essentials.'
} else {
    Write-Host 'Skipping essentials (already installed this session).'
}

# ---- pause before games -------------------------------------------------------
# Pause only when essentials were just copied, so the Switch can be put into
# full DBI mode before the games; restarting a failed run that skips essentials
# does not need another pause.
if ($copyEss -and $requested.Count -gt 0 -and (-not $DryRun) -and (-not $NoPause)) {
    Write-Host ''
    Write-Host 'Essentials finished copying.'
    Write-Host 'Open DBI on the Switch for full DBI mode now, then press Enter to install the games.'
    [void](Read-Host '> Press Enter when ready (Ctrl+C cancels)')
}

# DBI drops and re-adds the MTP device when it changes mode, so the session
# opened before the pause is dead by the time the games start. Wait until the
# target answers again instead of failing the first game on a stale handle.
if ($copyEss -and $requested.Count -gt 0 -and (-not $DryRun)) {
    $spec = $parsed
    if ($null -eq $spec -and $null -ne $session) {
        $spec = New-Object psobject -Property @{ Device = $session.FriendlyName; Path = @() }
    }
    if ($null -ne $spec) {
        Write-Host 'Waiting for the Switch to answer again...'
        if ($null -ne $session) { $session.Dispose(); $session = $null }
        $destId = $null
        $reconnected = Wait-For-MtpTarget $spec 120
        if ($null -eq $reconnected) {
            Die 'the Switch did not come back - check that DBI is open and the cable is connected, then rerun'
        }
        $session = $reconnected.Session
        $destId = $reconnected.DestId
        Write-Host ('Ready: {0}\{1}' -f $session.FriendlyName, ($spec.Path -join '\'))
    }
}

# ---- games --------------------------------------------------------------------
$gameOk = 0
$gameFail = 0
$gamesSeconds = 0
if ($requested.Count -gt 0) {
    Write-Host '--- Games ---'
    # First pass: resolve every match, remember its size for byte-accurate progress.
    $foundDirs = New-Object System.Collections.Generic.List[string]
    $foundLabels = New-Object System.Collections.Generic.List[string]
    $foundSizes = New-Object System.Collections.Generic.List[long]

    foreach ($game in $requested) {
        if ([string]::IsNullOrWhiteSpace($game)) { continue }
        $gameKey = Get-NormalizedKey $game
        $found = $null
        $nearMiss = $null

        foreach ($folder in (Get-ChildItem -LiteralPath $NspDir -Directory -Force -ErrorAction SilentlyContinue)) {
            $key = Get-NormalizedKey $folder.Name
            if ($key -eq $gameKey) { $found = $folder; break }
            # First same-prefix folder, so "Not Found" can suggest the near name
            # instead of leaving the folder mystery unexplained.
            if (($null -eq $nearMiss) -and $key.StartsWith($gameKey)) { $nearMiss = $folder.Name }
        }

        if ($null -eq $found) {
            if ($null -ne $nearMiss) {
                Write-Host "  Not Found: $game (closest folder: $nearMiss)"
            } else {
                Write-Host "  Not Found: $game"
            }
            $gameFail++
            continue
        }
        $foundDirs.Add($found.FullName)
        $foundLabels.Add($found.Name)
        $size = [long](Get-ChildItem -LiteralPath $found.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                       Measure-Object -Property Length -Sum).Sum
        $foundSizes.Add($size)
    }

    $totalItems = $foundDirs.Count
    $totalBytes = [long]0
    foreach ($size in $foundSizes) { $totalBytes += $size }

    if ($totalItems -eq 0) {
        Write-Host '  (no matching game folders to copy)'
    } else {
        Write-Host ('  Copying {0} item(s), {1} total.' -f $totalItems, (Format-Size $totalBytes))
        $doneBytes = [long]0
        $index = 0
        $gamesWatch = [System.Diagnostics.Stopwatch]::StartNew()
        while ($index -lt $totalItems) {
            $label = $foundLabels[$index]
            $size = [double]$foundSizes[$index]
            $index++
            Write-Host ('  [{0}/{1}] {2} ({3})' -f $index, $totalItems, $label, (Format-Size $size))
            $itemWatch = [System.Diagnostics.Stopwatch]::StartNew()
            $itemOk = Copy-ToTarget $session $destId $foundDirs[$index - 1] $label
            $itemWatch.Stop()
            if ($itemOk) { $gameOk++ } else { $gameFail++ }

            if (-not $DryRun) {
                $itemSeconds = [int]$itemWatch.Elapsed.TotalSeconds
                $itemLine = '      -> took {0}' -f (Format-Duration $itemSeconds)
                if ($itemOk -and $itemSeconds -gt 0) {
                    $itemLine = '{0} ({1:f1} MB/s)' -f $itemLine, ($size / 1048576 / $itemSeconds)
                }
                Write-Host $itemLine
                $doneBytes += [long]$size
                if ($totalBytes -gt 0) {
                    $pct = [int][Math]::Floor($doneBytes * 100 / $totalBytes)
                } else {
                    $pct = 100
                }
                Write-Host ('      -> {0}% done ({1} of {2})' -f $pct, (Format-Size $doneBytes), (Format-Size $totalBytes))
            }
        }
        if (-not $DryRun) {
            $gamesWatch.Stop()
            $gamesSeconds = [int]$gamesWatch.Elapsed.TotalSeconds
            $gamesLine = 'Games finished in {0}' -f (Format-Duration $gamesSeconds)
            if ($gamesSeconds -gt 0) {
                $gamesLine = '{0} (avg {1:f0} MB/s)' -f $gamesLine, ($totalBytes / 1048576 / $gamesSeconds)
            }
            Write-Host ('{0}.' -f $gamesLine)
        }
    }
} else {
    Write-Host 'Note: no game names: skipping games.'
}

Write-Host ''
if ($DryRun) {
    Write-Host ('Dry run complete: {0} essential file(s), {1} game folder(s).' -f $essentialOk, $gameOk)
} else {
    $totalSeconds = $essSeconds + $gamesSeconds
    Write-Host ('Done. Copied {0} essential file(s) and {1} game folder(s) to {2}.' -f $essentialOk, $gameOk, $targetLabel)
    Write-Host ('Total copying time: {0}.' -f (Format-Duration $totalSeconds))
}
if ($essentialFail -gt 0) { Write-Host ('{0} essential name(s) not found or failed.' -f $essentialFail) }
if ($gameFail -gt 0) { Write-Host ('{0} game name(s) not found or failed.' -f $gameFail) }
if (($script:unconfirmed -gt 0) -and (-not $DryRun)) {
    Write-Host ('{0} file(s) were sent in full but never confirmed by the device - they usually install anyway; check the Switch before re-copying.' -f $script:unconfirmed)
}

if ($null -ne $session) { $session.Dispose() }
exit 0
