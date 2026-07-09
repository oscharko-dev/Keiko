// Epic #1941 — static native-dialog platform scripts (ADR-0118 D3).
//
// Both scripts are DETERMINISTIC CONSTANTS embedded in TypeScript (not packaged files) so the npm
// artifact needs no extra assets and the executed program can never drift from what this module
// was reviewed with. User-controlled values NEVER appear in the script text: the adapter passes
// them on stdin (macOS: UTF-8 JSON; Windows: base64-wrapped UTF-8 JSON, which keeps the stdin
// bytes ASCII-only and independent of the console input codepage).
//
// Output contract for both scripts — exactly one JSON object on stdout:
//   { "cancelled": boolean, "paths": string[] }
// User cancellation exits 0 with `cancelled: true`. Real failures exit non-zero with a message on
// stderr; the adapter treats stderr as confidential and never forwards it to the browser.

// macOS: executed as `/usr/bin/osascript -l JavaScript -e <script>` (JXA). `choose file` /
// `choose folder` are StandardAdditions user-interaction primitives — they require no TCC
// automation grant because no Apple events target another application.
export const MACOS_NATIVE_FILE_DIALOG_SCRIPT = String.raw`
function run() {
  ObjC.import("Foundation");
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const stdinData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const stdinText = $.NSString.alloc.initWithDataEncoding(stdinData, $.NSUTF8StringEncoding).js;
  const config = JSON.parse(stdinText);
  const options = {};
  if (typeof config.title === "string" && config.title.length > 0) {
    options.withPrompt = config.title;
  }
  if (typeof config.defaultPath === "string" && config.defaultPath.length > 0) {
    options.defaultLocation = Path(config.defaultPath);
  }
  if (
    config.mode !== "open-directory" &&
    Array.isArray(config.extensions) &&
    config.extensions.length > 0
  ) {
    options.ofType = config.extensions;
  }
  try {
    // Focus hint only: osascript runs headless behind the browser, so ask macOS to bring the
    // dialog forward. Best effort — a failed activate must never fail the selection itself.
    try {
      app.activate();
    } catch (activateError) {}
    let picked;
    if (config.mode === "open-directory") {
      picked = [app.chooseFolder(options)];
    } else if (config.mode === "open-files") {
      options.multipleSelectionsAllowed = true;
      picked = app.chooseFile(options);
    } else {
      picked = [app.chooseFile(options)];
    }
    const list = Array.isArray(picked) ? picked : [picked];
    const paths = list.map(function (item) {
      return item.toString();
    });
    return JSON.stringify({ cancelled: false, paths: paths });
  } catch (error) {
    // -128 is the AppleScript "User canceled" error: a normal outcome, not a failure.
    if (error && error.errorNumber === -128) {
      return JSON.stringify({ cancelled: true, paths: [] });
    }
    throw error;
  }
}
`;

// Windows: executed as `powershell.exe -NoProfile -STA -EncodedCommand <base64(utf16le(script))>`.
// File modes use System.Windows.Forms.OpenFileDialog (needs STA). The folder mode uses the modern
// Explorer Common Item Dialog (IFileOpenDialog, FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM) — all COM
// marshalling lives in the embedded C# helper compiled via Add-Type, so PowerShell itself only
// hosts stdin/stdout and never touches [ref] interop. Both modes anchor the dialog to an invisible
// top-most owner window (New-DialogOwner) so it opens in front of the browser rather than behind
// it — the folder Common Item Dialog receives that owner's handle for IFileOpenDialog::Show.
//
// ConvertTo-Json on Windows PowerShell 5.1 escapes every non-ASCII character as \uXXXX, so the
// stdout JSON is codepage-independent; OutputEncoding is still pinned to UTF-8 defensively.
export const WINDOWS_NATIVE_FILE_DIALOG_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rawStdin = [Console]::In.ReadToEnd()
$configJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($rawStdin.Trim()))
$config = $configJson | ConvertFrom-Json

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace KeikoNativeFileDialog {
  internal static class NativeConstants {
    internal const uint FOS_PICKFOLDERS = 0x00000020;
    internal const uint FOS_FORCEFILESYSTEM = 0x00000040;
    internal const uint FOS_NOCHANGEDIR = 0x00000008;
    internal const uint SIGDN_FILESYSPATH = 0x80058000;
    internal const int ERROR_CANCELLED = unchecked((int)0x800704C7);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  // IFileDialog vtable order followed by the IFileOpenDialog extensions. Members that Keiko never
  // calls are declared (vtable slots must line up) but not used.
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName(out IntPtr pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  internal class FileOpenDialogRcw { }

  public static class FolderPicker {
    public static string[] Show(string title, string defaultPath, IntPtr owner) {
      IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRcw();
      dialog.SetOptions(
        NativeConstants.FOS_PICKFOLDERS |
        NativeConstants.FOS_FORCEFILESYSTEM |
        NativeConstants.FOS_NOCHANGEDIR);
      if (!string.IsNullOrEmpty(title)) {
        dialog.SetTitle(title);
      }
      if (!string.IsNullOrEmpty(defaultPath)) {
        try {
          Guid shellItemGuid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
          IShellItem folder;
          SHCreateItemFromParsingName(defaultPath, IntPtr.Zero, ref shellItemGuid, out folder);
          dialog.SetFolder(folder);
        } catch (Exception) {
          // Starting-location hint is best effort; an unresolvable hint must not break the dialog.
        }
      }
      // Owner the modal to the caller-supplied top-most window so it opens in the foreground,
      // in front of the browser, instead of behind it (issue #2151). IntPtr.Zero here would make
      // the dialog ownerless and, from this background helper process, land it behind the browser.
      int hr = dialog.Show(owner);
      if (hr == NativeConstants.ERROR_CANCELLED) {
        return null;
      }
      if (hr != 0) {
        Marshal.ThrowExceptionForHR(hr);
      }
      IShellItem item;
      dialog.GetResult(out item);
      IntPtr pathPtr;
      item.GetDisplayName(NativeConstants.SIGDN_FILESYSPATH, out pathPtr);
      try {
        return new string[] { Marshal.PtrToStringUni(pathPtr) };
      } finally {
        Marshal.FreeCoTaskMem(pathPtr);
      }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
      [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
      IntPtr pbc,
      ref Guid riid,
      [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
  }
}
'@

function New-DialogOwner {
  # Invisible top-most owner form so the dialog opens in the foreground instead of behind the
  # browser window that triggered the request.
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $owner.Opacity = 0
  $owner.Width = 1
  $owner.Height = 1
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  return $owner
}

function Show-KeikoFileDialog {
  param($Config, [bool]$Multi)
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Multiselect = $Multi
  $dialog.CheckFileExists = $true
  $dialog.CheckPathExists = $true
  $dialog.RestoreDirectory = $true
  $dialog.DereferenceLinks = $true
  if ($null -ne $Config.title -and [string]$Config.title -ne '') {
    $dialog.Title = [string]$Config.title
  }
  if ($null -ne $Config.defaultPath -and [string]$Config.defaultPath -ne '') {
    $dialog.InitialDirectory = [string]$Config.defaultPath
  }
  $filterParts = @()
  if ($null -ne $Config.filters) {
    foreach ($filter in @($Config.filters)) {
      $patterns = @(@($filter.extensions) | ForEach-Object { '*.' + $_ }) -join ';'
      $filterParts += ('{0} ({1})|{1}' -f [string]$filter.name, $patterns)
    }
  }
  $filterParts += 'All files (*.*)|*.*'
  $dialog.Filter = ($filterParts -join '|')
  $owner = New-DialogOwner
  try {
    $result = $dialog.ShowDialog($owner)
  } finally {
    $owner.Dispose()
  }
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    return $null
  }
  return @($dialog.FileNames)
}

function Show-KeikoFolderDialog {
  param($Config)
  $title = ''
  if ($null -ne $Config.title) { $title = [string]$Config.title }
  $defaultPath = ''
  if ($null -ne $Config.defaultPath) { $defaultPath = [string]$Config.defaultPath }
  # Anchor the Common Item Dialog to the same invisible top-most owner the file dialog uses, so
  # the folder picker opens in the foreground instead of behind the browser that triggered it
  # (issue #2151). The owner form's window handle is created on first access and torn down with
  # the form once the pick settles.
  $owner = New-DialogOwner
  try {
    $paths = [KeikoNativeFileDialog.FolderPicker]::Show($title, $defaultPath, $owner.Handle)
  } finally {
    $owner.Dispose()
  }
  if ($null -eq $paths) {
    return $null
  }
  return @($paths)
}

$mode = [string]$config.mode
$paths = $null
if ($mode -eq 'open-directory') {
  $paths = Show-KeikoFolderDialog -Config $config
} elseif ($mode -eq 'open-files') {
  $paths = Show-KeikoFileDialog -Config $config -Multi $true
} elseif ($mode -eq 'open-file') {
  $paths = Show-KeikoFileDialog -Config $config -Multi $false
} else {
  throw 'unsupported native dialog mode'
}

if ($null -eq $paths) {
  Write-Output (@{ cancelled = $true; paths = @() } | ConvertTo-Json -Compress)
} else {
  Write-Output (@{ cancelled = $false; paths = @($paths) } | ConvertTo-Json -Compress)
}
`;
