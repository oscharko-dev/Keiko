using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class StandardTokenLoader {
  private const int MaxInputChars = 1024 * 1024;
  private const uint DisableMaxPrivilege = 0x1;
  private const uint SeGroupUseForDenyOnly = 0x10;
  private const uint TokenAssignPrimary = 0x1;
  private const uint TokenDuplicate = 0x2;
  private const uint TokenQuery = 0x8;
  private const uint SePrivilegeEnabled = 0x2;
  private const uint CreateNoWindow = 0x08000000;
  private const uint CreateUnicodeEnvironment = 0x00000400;
  private const uint StartfUseStdHandles = 0x00000100;
  private const uint GenericWrite = 0x40000000;
  private const uint FileShareRead = 0x1;
  private const uint FileShareWrite = 0x2;
  private const uint OpenExisting = 3;
  private const uint WaitObject0 = 0;
  private const uint WaitTimeout = 258;
  private const int ChildTimeoutMs = 30000;
  private const int TeardownTimeoutMs = 5000;
  private const int WinBuiltinAdministratorsSid = 26;
  private const int SecurityImpersonation = 2;

  public static int Main(string[] args) {
    if (args.Length != 3) return Fail(100, "invalid-arguments");
    string input = ReadBoundedInput();
    if (input == null) return Fail(101, "input-too-large");
    IntPtr processToken = IntPtr.Zero;
    IntPtr restrictedToken = IntPtr.Zero;
    IntPtr restrictedImpersonationToken = IntPtr.Zero;
    byte[] administratorsSid = new byte[68];
    uint administratorsSidLength = (uint)administratorsSid.Length;
    GCHandle sidPin = default(GCHandle);
    try {
      if (!OpenProcessToken(
        GetCurrentProcess(),
        TokenAssignPrimary | TokenDuplicate | TokenQuery,
        out processToken)) return Win32Failure(102, "open-token");
      if (!CreateWellKnownSid(
        WinBuiltinAdministratorsSid,
        IntPtr.Zero,
        administratorsSid,
        ref administratorsSidLength)) return Win32Failure(103, "admin-sid");
      sidPin = GCHandle.Alloc(administratorsSid, GCHandleType.Pinned);
      var disabled = new[] {
        new SidAndAttributes {
          Sid = sidPin.AddrOfPinnedObject(),
          Attributes = SeGroupUseForDenyOnly,
        },
      };
      if (!CreateRestrictedToken(
        processToken,
        DisableMaxPrivilege,
        1,
        disabled,
        0,
        IntPtr.Zero,
        0,
        IntPtr.Zero,
        out restrictedToken)) return Win32Failure(104, "restrict-token");
      if (!DuplicateToken(
        restrictedToken,
        SecurityImpersonation,
        out restrictedImpersonationToken)) return Win32Failure(114, "duplicate-token");
      bool administratorsEnabled;
      if (!CheckTokenMembership(
        restrictedImpersonationToken,
        administratorsSid,
        out administratorsEnabled)) return Win32Failure(115, "check-admin-membership");
      if (administratorsEnabled) return Fail(116, "administrator-still-enabled");
      int privilegeState = HasOnlyAllowedEnabledPrivilege(restrictedToken);
      if (privilegeState < 0) return Win32Failure(117, "query-restricted-privileges");
      if (privilegeState == 0) return Fail(118, "unexpected-enabled-privilege");
      return RunChild(restrictedToken, args[0], args[1], args[2], input);
    }
    finally {
      if (sidPin.IsAllocated) sidPin.Free();
      if (restrictedImpersonationToken != IntPtr.Zero) CloseHandle(restrictedImpersonationToken);
      if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
      if (processToken != IntPtr.Zero) CloseHandle(processToken);
    }
  }

  private static int HasOnlyAllowedEnabledPrivilege(IntPtr token) {
    var changeNotify = new Luid();
    if (!LookupPrivilegeValueW(null, "SeChangeNotifyPrivilege", out changeNotify)) return -1;
    uint required = 0;
    GetTokenInformation(token, 3, IntPtr.Zero, 0, out required);
    if (Marshal.GetLastWin32Error() != 122 || required < 4 || required > 65536) return -1;
    IntPtr privileges = Marshal.AllocHGlobal((int)required);
    try {
      if (!GetTokenInformation(token, 3, privileges, required, out required)) return -1;
      int count = Marshal.ReadInt32(privileges);
      if (count < 0 || count > 256 || required < 4 + count * 12) return 0;
      for (int index = 0; index < count; index++) {
        int offset = 4 + index * 12;
        uint attributes = unchecked((uint)Marshal.ReadInt32(privileges, offset + 8));
        if ((attributes & SePrivilegeEnabled) == 0) continue;
        uint lowPart = unchecked((uint)Marshal.ReadInt32(privileges, offset));
        int highPart = Marshal.ReadInt32(privileges, offset + 4);
        if (lowPart != changeNotify.LowPart || highPart != changeNotify.HighPart) return 0;
      }
      return 1;
    }
    finally {
      Marshal.FreeHGlobal(privileges);
    }
  }

  private static string ReadBoundedInput() {
    var buffer = new char[MaxInputChars + 1];
    int offset = 0;
    while (offset < buffer.Length) {
      int read = Console.In.Read(buffer, offset, buffer.Length - offset);
      if (read == 0) break;
      offset += read;
    }
    if (offset > MaxInputChars || Console.In.Peek() != -1) return null;
    return new string(buffer, 0, offset);
  }

  private static int RunChild(
    IntPtr token,
    string powershell,
    string systemRoot,
    string encodedCommand,
    string input) {
    using (var pipe = new AnonymousPipeServerStream(
      PipeDirection.Out,
      HandleInheritability.Inheritable)) {
      var security = new SecurityAttributes {
        Length = Marshal.SizeOf(typeof(SecurityAttributes)),
        InheritHandle = true,
      };
      IntPtr output = CreateFileW(
        "NUL",
        GenericWrite,
        FileShareRead | FileShareWrite,
        ref security,
        OpenExisting,
        0,
        IntPtr.Zero);
      if (output == new IntPtr(-1)) return Win32Failure(106, "open-null-output");
      IntPtr environment = IntPtr.Zero;
      var process = new ProcessInformation();
      try {
        string system32 = Path.Combine(systemRoot, "System32");
        string environmentText =
          "ComSpec=" + Path.Combine(system32, "cmd.exe") + "\0" +
          "PATH=" + system32 + ";" + systemRoot + "\0" +
          "SystemRoot=" + systemRoot + "\0" +
          "WINDIR=" + systemRoot + "\0\0";
        environment = Marshal.StringToHGlobalUni(environmentText);
        var startup = new StartupInfo {
          Size = Marshal.SizeOf(typeof(StartupInfo)),
          Flags = StartfUseStdHandles,
          StandardInput = pipe.ClientSafePipeHandle.DangerousGetHandle(),
          StandardOutput = output,
          StandardError = output,
        };
        var command = new StringBuilder(
          "\"" + powershell + "\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " +
          encodedCommand);
        if (!CreateProcessAsUserW(
          token,
          powershell,
          command,
          IntPtr.Zero,
          IntPtr.Zero,
          true,
          CreateUnicodeEnvironment | CreateNoWindow,
          environment,
          system32,
          ref startup,
          out process)) return Win32Failure(107, "start-restricted-process");
        pipe.DisposeLocalCopyOfClientHandle();
        Exception writerFailure = null;
        var writer = new Thread(() => {
          try {
            byte[] bytes = Encoding.ASCII.GetBytes(input);
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
          }
          catch (Exception error) {
            writerFailure = error;
          }
          finally {
            pipe.Dispose();
          }
        });
        writer.IsBackground = true;
        writer.Start();
        uint wait = WaitForSingleObject(process.Process, ChildTimeoutMs);
        if (wait == WaitTimeout) {
          TerminateProcess(process.Process, 108);
          WaitForSingleObject(process.Process, TeardownTimeoutMs);
          if (!writer.Join(TeardownTimeoutMs)) AbortHost(109, "writer-did-not-stop");
          return Fail(108, "restricted-process-timeout");
        }
        if (wait != WaitObject0) {
          int error = Marshal.GetLastWin32Error();
          TerminateProcess(process.Process, 110);
          WaitForSingleObject(process.Process, TeardownTimeoutMs);
          if (!writer.Join(TeardownTimeoutMs)) AbortHost(109, "writer-did-not-stop");
          Console.Error.WriteLine("standard-token-loader:wait-restricted-process:win32-" + error);
          return 110;
        }
        if (!writer.Join(TeardownTimeoutMs)) AbortHost(109, "writer-did-not-stop");
        if (writerFailure != null) return Fail(111, "stdin-transport-failed");
        uint exitCode;
        if (!GetExitCodeProcess(process.Process, out exitCode)) {
          return Win32Failure(112, "read-restricted-exit");
        }
        return exitCode <= 99 ? (int)exitCode : Fail(113, "invalid-restricted-exit");
      }
      finally {
        if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
        if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        CloseHandle(output);
      }
    }
  }

  private static int Win32Failure(int code, string kind) {
    int error = Marshal.GetLastWin32Error();
    Console.Error.WriteLine("standard-token-loader:" + kind + ":win32-" + error);
    return code;
  }

  private static int Fail(int code, string kind) {
    Console.Error.WriteLine("standard-token-loader:" + kind);
    return code;
  }

  private static void AbortHost(int code, string kind) {
    Console.Error.WriteLine("standard-token-loader:" + kind);
    Environment.Exit(code);
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SidAndAttributes {
    public IntPtr Sid;
    public uint Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct Luid {
    public uint LowPart;
    public int HighPart;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct StartupInfo {
    public int Size;
    public string Reserved;
    public string Desktop;
    public string Title;
    public uint X;
    public uint Y;
    public uint XSize;
    public uint YSize;
    public uint XCountChars;
    public uint YCountChars;
    public uint FillAttribute;
    public uint Flags;
    public ushort ShowWindow;
    public ushort Reserved2;
    public IntPtr Reserved2Bytes;
    public IntPtr StandardInput;
    public IntPtr StandardOutput;
    public IntPtr StandardError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr Process;
    public IntPtr Thread;
    public uint ProcessId;
    public uint ThreadId;
  }

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool DuplicateToken(
    IntPtr existingToken,
    int impersonationLevel,
    out IntPtr duplicateToken);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool OpenProcessToken(
    IntPtr process,
    uint desiredAccess,
    out IntPtr token);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool CreateRestrictedToken(
    IntPtr existingToken,
    uint flags,
    uint disableSidCount,
    [In] SidAndAttributes[] sidsToDisable,
    uint deletePrivilegeCount,
    IntPtr privilegesToDelete,
    uint restrictedSidCount,
    IntPtr sidsToRestrict,
    out IntPtr newToken);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool CheckTokenMembership(
    IntPtr token,
    byte[] sid,
    [MarshalAs(UnmanagedType.Bool)] out bool isMember);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetTokenInformation(
    IntPtr token,
    int informationClass,
    IntPtr information,
    uint informationLength,
    out uint returnLength);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LookupPrivilegeValueW(
    string systemName,
    string name,
    out Luid luid);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool CreateWellKnownSid(
    int sidType,
    IntPtr domainSid,
    byte[] sid,
    ref uint sidSize);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessAsUserW(
    IntPtr token,
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    ref SecurityAttributes securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, int milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
}
