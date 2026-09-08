using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
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
  private const uint TokenAdjustDefault = 0x80;
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
  private const uint GenericAll = 0x10000000;
  private const uint CreateWindowStationOnly = 0x00000001;
  private const int UserObjectName = 2;
  private const uint Synchronize = 0x00100000;
  private const uint ProcessQueryLimitedInformation = 0x1000;
  private const uint ThreadQueryLimitedInformation = 0x0800;
  private const uint DaclSecurityInformation = 0x00000004;
  private const int SeKernelObject = 6;
  private const int TokenGroups = 2;
  private const int TokenOwner = 4;
  private const int TokenDefaultDacl = 6;
  private const int TokenElevationType = 18;
  private const int TokenLinkedToken = 19;
  private const int TokenIntegrityLevel = 25;
  private const uint SeGroupEnabled = 0x00000004;
  private const uint SeGroupUseForDenyOnlyMask = 0x00000010;
  private const uint SeGroupLogonId = 0xC0000000;

  public static int Main(string[] args) {
    if (args.Length != 3 && args.Length != 4) return Fail(100, "invalid-arguments");
    string mode = args.Length == 4 ? args[3] : "required";
    if (mode != "required" &&
      mode != "--original-token-control" &&
      mode != "--explicit-child-dacl-control" &&
      mode != "--group-only-control" &&
      mode != "--privilege-only-control" &&
      mode != "--token-default-dacl-control") return Fail(100, "invalid-arguments");
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
        TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustDefault,
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
      bool groupOnlyControl = mode == "--group-only-control";
      bool privilegeOnlyControl = mode == "--privilege-only-control";
      if (!CreateRestrictedToken(
        processToken,
        groupOnlyControl ? 0 : DisableMaxPrivilege,
        privilegeOnlyControl ? 0U : 1U,
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
      if (!privilegeOnlyControl && administratorsEnabled) {
        return Fail(116, "administrator-still-enabled");
      }
      int privilegeState = HasOnlyAllowedEnabledPrivilege(restrictedToken);
      if (privilegeState < 0) return Win32Failure(117, "query-restricted-privileges");
      if (!groupOnlyControl && privilegeState == 0) {
        return Fail(118, "unexpected-enabled-privilege");
      }
      if (mode != "required") {
        SecurityIdentifier user;
        SecurityIdentifier system;
        SecurityIdentifier administrators;
        try {
          user = GetCurrentUserSid();
          system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
          administrators = new SecurityIdentifier(
            WellKnownSidType.BuiltinAdministratorsSid,
            null);
        }
        catch (Exception error) {
          Console.Error.WriteLine(
            "standard-token-loader:prepare-control-security:Exception:hresult-" +
            unchecked((uint)error.HResult).ToString("X8"));
          return 122;
        }
        if (mode == "--token-default-dacl-control") {
          int defaultDaclError;
          bool defaultDaclErrorIsHResult;
          if (!TrySetPrivateTokenDefaultDacl(
            restrictedToken,
            user,
            out defaultDaclError,
            out defaultDaclErrorIsHResult)) {
            string classification = defaultDaclErrorIsHResult
              ? "Exception:hresult-" + unchecked((uint)defaultDaclError).ToString("X8")
              : "win32-" + defaultDaclError;
            Console.Error.WriteLine(
              "standard-token-loader:set-control-default-dacl:" + classification);
            return 123;
          }
        }
        int originalDacl = ClassifyTokenDefaultDacl(
          processToken,
          user,
          system,
          administrators);
        int restrictedDacl = ClassifyTokenDefaultDacl(
          restrictedToken,
          user,
          system,
          administrators);
        Console.Error.WriteLine(
          "standard-token-loader:control-token-dacl:original-" + originalDacl +
          ":restricted-" + restrictedDacl);
        WriteTokenShape(
          processToken,
          restrictedToken,
          user,
          system,
          administrators);
        bool useOriginalToken = mode == "--original-token-control";
        return RunChild(
          useOriginalToken ? processToken : restrictedToken,
          restrictedImpersonationToken,
          args[0],
          args[1],
          args[2],
          input,
          true,
          mode == "--explicit-child-dacl-control",
          user,
          system,
          administrators);
      }
      return RunChild(
        restrictedToken,
        IntPtr.Zero,
        args[0],
        args[1],
        args[2],
        input,
        false,
        false,
        null,
        null,
        null);
    }
    finally {
      if (sidPin.IsAllocated) sidPin.Free();
      if (restrictedImpersonationToken != IntPtr.Zero) CloseHandle(restrictedImpersonationToken);
      if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
      if (processToken != IntPtr.Zero) CloseHandle(processToken);
    }
  }

  private static SecurityIdentifier GetCurrentUserSid() {
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
      SecurityIdentifier user = identity.User;
      if (user == null) throw new InvalidOperationException();
      return user;
    }
  }

  private static bool TrySetPrivateTokenDefaultDacl(
    IntPtr token,
    SecurityIdentifier user,
    out int failureCode,
    out bool failureIsHResult) {
    failureCode = 0;
    failureIsHResult = false;
    IntPtr descriptor = IntPtr.Zero;
    IntPtr information = IntPtr.Zero;
    try {
      uint descriptorBytes;
      string descriptorText = "D:P(A;;GA;;;SY)(A;;GA;;;" + user.Value + ")";
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        descriptorText,
        1,
        out descriptor,
        out descriptorBytes)) {
        failureCode = Marshal.GetLastWin32Error();
        return false;
      }
      bool daclPresent;
      bool daclDefaulted;
      IntPtr dacl;
      if (!GetSecurityDescriptorDacl(
        descriptor,
        out daclPresent,
        out dacl,
        out daclDefaulted)) {
        failureCode = Marshal.GetLastWin32Error();
        return false;
      }
      if (!daclPresent || dacl == IntPtr.Zero) return false;
      information = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(information, dacl);
      if (!SetTokenInformation(
        token,
        TokenDefaultDacl,
        information,
        unchecked((uint)IntPtr.Size))) {
        failureCode = Marshal.GetLastWin32Error();
        return false;
      }
      return true;
    }
    catch (Exception error) {
      failureCode = error.HResult;
      failureIsHResult = true;
      return false;
    }
    finally {
      if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
    }
  }

  private static void WriteTokenShape(
    IntPtr originalToken,
    IntPtr candidateToken,
    SecurityIdentifier user,
    SecurityIdentifier system,
    SecurityIdentifier administrators) {
    byte[] userSid = GetSidBytes(user);
    byte[] systemSid = GetSidBytes(system);
    byte[] administratorsSid = GetSidBytes(administrators);
    var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
    var authenticated = new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null);
    var interactive = new SecurityIdentifier(WellKnownSidType.InteractiveSid, null);
    byte[] usersSid = GetSidBytes(users);
    byte[] authenticatedSid = GetSidBytes(authenticated);
    byte[] interactiveSid = GetSidBytes(interactive);
    int originalGroups = ClassifyTokenGroups(
      originalToken,
      usersSid,
      authenticatedSid,
      interactiveSid);
    int candidateGroups = ClassifyTokenGroups(
      candidateToken,
      usersSid,
      authenticatedSid,
      interactiveSid);
    int originalIntegrity = ClassifyTokenIntegrity(originalToken);
    int candidateIntegrity = ClassifyTokenIntegrity(candidateToken);
    int originalOwner = ClassifyTokenOwner(
      originalToken,
      userSid,
      systemSid,
      administratorsSid);
    int candidateOwner = ClassifyTokenOwner(
      candidateToken,
      userSid,
      systemSid,
      administratorsSid);
    Console.Error.WriteLine(
      "standard-token-loader:control-token-shape:original-" +
      FormatGroupStates(originalGroups) +
      "-integrity-" + originalIntegrity + "-owner-" + originalOwner +
      ":candidate-" + FormatGroupStates(candidateGroups) +
      "-integrity-" + candidateIntegrity +
      "-owner-" + candidateOwner);
    WriteLinkedTokenShape(
      originalToken,
      userSid,
      systemSid,
      administratorsSid,
      usersSid,
      authenticatedSid,
      interactiveSid);
  }

  private static void WriteLinkedTokenShape(
    IntPtr originalToken,
    byte[] userSid,
    byte[] systemSid,
    byte[] administratorsSid,
    byte[] usersSid,
    byte[] authenticatedSid,
    byte[] interactiveSid) {
    int elevationType = ReadTokenInt32(originalToken, TokenElevationType);
    IntPtr linkedToken = ReadLinkedToken(originalToken);
    if (linkedToken == IntPtr.Zero) {
      Console.Error.WriteLine(
        "standard-token-loader:control-linked-token:unavailable-elevation-" + elevationType);
      return;
    }
    try {
      int groups = ClassifyTokenGroups(
        linkedToken,
        usersSid,
        authenticatedSid,
        interactiveSid);
      int integrity = ClassifyTokenIntegrity(linkedToken);
      int owner = ClassifyTokenOwner(
        linkedToken,
        userSid,
        systemSid,
        administratorsSid);
      Console.Error.WriteLine(
        "standard-token-loader:control-linked-token:elevation-" + elevationType + "-" +
        FormatGroupStates(groups) + "-integrity-" + integrity + "-owner-" + owner);
    }
    finally {
      CloseHandle(linkedToken);
    }
  }

  private static int ReadTokenInt32(IntPtr token, int informationClass) {
    int value;
    uint returned;
    IntPtr information = Marshal.AllocHGlobal(4);
    try {
      if (!GetTokenInformation(token, informationClass, information, 4, out returned) ||
        returned != 4) return -1;
      value = Marshal.ReadInt32(information);
    }
    finally {
      Marshal.FreeHGlobal(information);
    }
    return value;
  }

  private static IntPtr ReadLinkedToken(IntPtr token) {
    uint returned;
    IntPtr information = Marshal.AllocHGlobal(IntPtr.Size);
    try {
      if (!GetTokenInformation(
        token,
        TokenLinkedToken,
        information,
        unchecked((uint)IntPtr.Size),
        out returned) || returned != unchecked((uint)IntPtr.Size)) return IntPtr.Zero;
      return Marshal.ReadIntPtr(information);
    }
    finally {
      Marshal.FreeHGlobal(information);
    }
  }

  private static string FormatGroupStates(int states) {
    if (states < 0) return "groups-error";
    return "users-" + (states & 3) +
      "-authenticated-" + ((states >> 2) & 3) +
      "-interactive-" + ((states >> 4) & 3) +
      "-logon-" + ((states >> 6) & 3);
  }

  private static byte[] GetSidBytes(SecurityIdentifier sid) {
    byte[] bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    return bytes;
  }

  private static int ClassifyTokenGroups(
    IntPtr token,
    byte[] usersSid,
    byte[] authenticatedSid,
    byte[] interactiveSid) {
    uint required = 0;
    GetTokenInformation(token, TokenGroups, IntPtr.Zero, 0, out required);
    if (Marshal.GetLastWin32Error() != 122 || required < 4 || required > 65536) return -1;
    IntPtr information = Marshal.AllocHGlobal((int)required);
    try {
      if (!GetTokenInformation(token, TokenGroups, information, required, out required)) return -1;
      int count = Marshal.ReadInt32(information);
      if (count < 0 || count > 1024) return -1;
      int firstGroupOffset = IntPtr.Size == 8 ? 8 : 4;
      int groupSize = Marshal.SizeOf(typeof(SidAndAttributes));
      if ((long)firstGroupOffset + (long)count * groupSize > required) return -1;
      int usersState = 0;
      int authenticatedState = 0;
      int interactiveState = 0;
      int logonState = 0;
      for (int index = 0; index < count; index++) {
        IntPtr entryAddress = IntPtr.Add(information, firstGroupOffset + index * groupSize);
        var entry = (SidAndAttributes)Marshal.PtrToStructure(
          entryAddress,
          typeof(SidAndAttributes));
        int state = ClassifyGroupState(entry.Attributes);
        if (EqualSid(entry.Sid, usersSid)) usersState = Math.Max(usersState, state);
        if (EqualSid(entry.Sid, authenticatedSid)) {
          authenticatedState = Math.Max(authenticatedState, state);
        }
        if (EqualSid(entry.Sid, interactiveSid)) {
          interactiveState = Math.Max(interactiveState, state);
        }
        if ((entry.Attributes & SeGroupLogonId) == SeGroupLogonId) {
          logonState = Math.Max(logonState, state);
        }
      }
      return usersState |
        (authenticatedState << 2) |
        (interactiveState << 4) |
        (logonState << 6);
    }
    catch (Exception) {
      return -1;
    }
    finally {
      Marshal.FreeHGlobal(information);
    }
  }

  private static int ClassifyGroupState(uint attributes) {
    if ((attributes & SeGroupUseForDenyOnlyMask) != 0) return 2;
    if ((attributes & SeGroupEnabled) != 0) return 3;
    return 1;
  }

  private static int ClassifyTokenIntegrity(IntPtr token) {
    uint required = 0;
    GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out required);
    if (Marshal.GetLastWin32Error() != 122 || required < IntPtr.Size || required > 65536) {
      return -1;
    }
    IntPtr information = Marshal.AllocHGlobal((int)required);
    try {
      if (!GetTokenInformation(
        token,
        TokenIntegrityLevel,
        information,
        required,
        out required)) return -1;
      IntPtr sid = Marshal.ReadIntPtr(information);
      IntPtr countAddress = GetSidSubAuthorityCount(sid);
      if (countAddress == IntPtr.Zero) return -1;
      byte count = Marshal.ReadByte(countAddress);
      if (count == 0) return -1;
      IntPtr ridAddress = GetSidSubAuthority(sid, unchecked((uint)(count - 1)));
      if (ridAddress == IntPtr.Zero) return -1;
      uint rid = unchecked((uint)Marshal.ReadInt32(ridAddress));
      if (rid < 0x1000) return 0;
      if (rid < 0x2000) return 1;
      if (rid < 0x3000) return 2;
      if (rid < 0x4000) return 3;
      if (rid < 0x5000) return 4;
      return 5;
    }
    catch (Exception) {
      return -1;
    }
    finally {
      Marshal.FreeHGlobal(information);
    }
  }

  private static int ClassifyTokenOwner(
    IntPtr token,
    byte[] userSid,
    byte[] systemSid,
    byte[] administratorsSid) {
    uint required = 0;
    GetTokenInformation(token, TokenOwner, IntPtr.Zero, 0, out required);
    if (Marshal.GetLastWin32Error() != 122 || required < IntPtr.Size || required > 65536) {
      return -1;
    }
    IntPtr information = Marshal.AllocHGlobal((int)required);
    try {
      if (!GetTokenInformation(token, TokenOwner, information, required, out required)) return -1;
      IntPtr owner = Marshal.ReadIntPtr(information);
      if (owner == IntPtr.Zero) return 0;
      if (EqualSid(owner, userSid)) return 1;
      if (EqualSid(owner, systemSid)) return 2;
      if (EqualSid(owner, administratorsSid)) return 4;
      return 8;
    }
    catch (Exception) {
      return -1;
    }
    finally {
      Marshal.FreeHGlobal(information);
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

  private static int ClassifyTokenDefaultDacl(
    IntPtr token,
    SecurityIdentifier user,
    SecurityIdentifier system,
    SecurityIdentifier administrators) {
    uint required = 0;
    GetTokenInformation(token, TokenDefaultDacl, IntPtr.Zero, 0, out required);
    if (Marshal.GetLastWin32Error() != 122 || required < IntPtr.Size || required > 65536) {
      return -1;
    }
    IntPtr information = Marshal.AllocHGlobal((int)required);
    try {
      if (!GetTokenInformation(token, TokenDefaultDacl, information, required, out required)) {
        return -1;
      }
      IntPtr acl = Marshal.ReadIntPtr(information);
      return ClassifyAcl(acl, user, system, administrators);
    }
    catch (Exception) {
      return -1;
    }
    finally {
      Marshal.FreeHGlobal(information);
    }
  }

  private static int ClassifyKernelObjectDacl(
    IntPtr handle,
    SecurityIdentifier user,
    SecurityIdentifier system,
    SecurityIdentifier administrators) {
    IntPtr owner;
    IntPtr group;
    IntPtr dacl;
    IntPtr sacl;
    IntPtr descriptor;
    uint status = GetSecurityInfo(
      handle,
      SeKernelObject,
      DaclSecurityInformation,
      out owner,
      out group,
      out dacl,
      out sacl,
      out descriptor);
    if (status != 0 || descriptor == IntPtr.Zero) return -1;
    try {
      return ClassifyAcl(dacl, user, system, administrators);
    }
    catch (Exception) {
      return -1;
    }
    finally {
      LocalFree(descriptor);
    }
  }

  private static int ClassifyAcl(
    IntPtr acl,
    SecurityIdentifier user,
    SecurityIdentifier system,
    SecurityIdentifier administrators) {
    if (acl == IntPtr.Zero) return 16;
    int size = unchecked((ushort)Marshal.ReadInt16(acl, 2));
    if (size < 8 || size > 65535) return -1;
    byte[] bytes = new byte[size];
    Marshal.Copy(acl, bytes, 0, size);
    var rawAcl = new RawAcl(bytes, 0);
    if (rawAcl.Count > 256) return -1;
    int classes = 0;
    for (int index = 0; index < rawAcl.Count; index++) {
      var ace = rawAcl[index] as QualifiedAce;
      if (ace == null ||
        ace.AceQualifier != AceQualifier.AccessAllowed ||
        ace.AccessMask == 0) continue;
      SecurityIdentifier sid = ace.SecurityIdentifier;
      if (sid.Equals(user)) classes |= 1;
      else if (sid.Equals(system)) classes |= 2;
      else if (sid.Equals(administrators)) classes |= 4;
      else classes |= 8;
    }
    return classes;
  }

  private static int ProbeRestrictedObjectAccess(
    IntPtr restrictedImpersonationToken,
    uint processId,
    uint threadId) {
    if (!SetThreadToken(IntPtr.Zero, restrictedImpersonationToken)) return -1;
    IntPtr process = IntPtr.Zero;
    IntPtr thread = IntPtr.Zero;
    try {
      process = OpenProcess(
        Synchronize | ProcessQueryLimitedInformation,
        false,
        processId);
      thread = OpenThread(
        Synchronize | ThreadQueryLimitedInformation,
        false,
        threadId);
      return (process != IntPtr.Zero ? 1 : 0) | (thread != IntPtr.Zero ? 2 : 0);
    }
    finally {
      if (thread != IntPtr.Zero) CloseHandle(thread);
      if (process != IntPtr.Zero) CloseHandle(process);
      if (!SetThreadToken(IntPtr.Zero, IntPtr.Zero)) {
        AbortHost(121, "restore-thread-token");
      }
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

  private sealed class DesktopAuthority : IDisposable {
    private IntPtr station;
    private IntPtr desktop;
    public string Name { get; private set; }
    public IntPtr SecurityDescriptor { get; private set; }

    private DesktopAuthority(
      IntPtr stationHandle,
      IntPtr desktopHandle,
      string name,
      IntPtr securityDescriptor) {
      station = stationHandle;
      desktop = desktopHandle;
      Name = name;
      SecurityDescriptor = securityDescriptor;
    }

    public static bool TryCreate(
      out DesktopAuthority authority,
      out string failureStage,
      out int failureCode,
      out bool failureIsHResult) {
      authority = null;
      failureStage = "prepare-security";
      failureCode = 0;
      failureIsHResult = false;
      IntPtr securityDescriptor = IntPtr.Zero;
      IntPtr originalStation = IntPtr.Zero;
      IntPtr privateStation = IntPtr.Zero;
      IntPtr privateDesktop = IntPtr.Zero;
      bool restoreRequired = false;
      try {
        SecurityIdentifier user;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
          user = identity.User;
        }
        if (user == null) return false;
        string descriptor = "D:P(A;;GA;;;SY)(A;;GA;;;" + user.Value + ")";
        uint descriptorBytes;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          descriptor,
          1,
          out securityDescriptor,
          out descriptorBytes)) {
          failureStage = "create-security-descriptor";
          failureCode = Marshal.GetLastWin32Error();
          return false;
        }
        var attributes = new SecurityAttributes {
          Length = Marshal.SizeOf(typeof(SecurityAttributes)),
          SecurityDescriptor = securityDescriptor,
          InheritHandle = false,
        };
        originalStation = GetProcessWindowStation();
        if (originalStation == IntPtr.Zero) {
          failureStage = "get-parent-station";
          failureCode = Marshal.GetLastWin32Error();
          return false;
        }
        string requestedStationName = "keiko-authenticode-" + Guid.NewGuid().ToString("N");
        privateStation = CreateWindowStationW(
          requestedStationName,
          CreateWindowStationOnly,
          GenericAll,
          ref attributes);
        if (privateStation == IntPtr.Zero) {
          failureStage = "create-private-station";
          failureCode = Marshal.GetLastWin32Error();
          return false;
        }
        restoreRequired = true;
        if (!SetProcessWindowStation(privateStation)) {
          failureStage = "select-private-station";
          failureCode = Marshal.GetLastWin32Error();
          return false;
        }
        const string desktopName = "keiko-authenticode";
        privateDesktop = CreateDesktopW(
          desktopName,
          null,
          IntPtr.Zero,
          0,
          GenericAll,
          ref attributes);
        if (privateDesktop == IntPtr.Zero) {
          failureStage = "create-private-desktop";
          failureCode = Marshal.GetLastWin32Error();
          return false;
        }
        var stationName = new StringBuilder(512);
        int requiredNameBytes;
        if (!GetUserObjectInformationW(
          privateStation,
          UserObjectName,
          stationName,
          stationName.Capacity * 2,
          out requiredNameBytes) ||
          requiredNameBytes <= 2 ||
          requiredNameBytes > stationName.Capacity * 2) {
          failureStage = "read-private-station-name";
          failureCode = Marshal.GetLastWin32Error();
          return false;
        }
        string actualStationName = stationName.ToString();
        if (!String.Equals(
          actualStationName,
          requestedStationName,
          StringComparison.OrdinalIgnoreCase)) {
          failureStage = "verify-private-station-name";
          return false;
        }
        if (!SetProcessWindowStation(originalStation)) {
          failureStage = "restore-parent-station";
          failureCode = Marshal.GetLastWin32Error();
          return false;
        }
        restoreRequired = false;
        authority = new DesktopAuthority(
          privateStation,
          privateDesktop,
          actualStationName + "\\" + desktopName,
          securityDescriptor);
        privateStation = IntPtr.Zero;
        privateDesktop = IntPtr.Zero;
        securityDescriptor = IntPtr.Zero;
        return true;
      }
      catch (Exception error) {
        failureStage = "prepare-security";
        failureCode = error.HResult;
        failureIsHResult = true;
        return false;
      }
      finally {
        if (restoreRequired && originalStation != IntPtr.Zero) {
          SetProcessWindowStation(originalStation);
        }
        if (privateDesktop != IntPtr.Zero) CloseDesktop(privateDesktop);
        if (privateStation != IntPtr.Zero) CloseWindowStation(privateStation);
        if (securityDescriptor != IntPtr.Zero) LocalFree(securityDescriptor);
      }
    }

    public void Dispose() {
      if (desktop != IntPtr.Zero) {
        CloseDesktop(desktop);
        desktop = IntPtr.Zero;
      }
      if (station != IntPtr.Zero) {
        CloseWindowStation(station);
        station = IntPtr.Zero;
      }
      if (SecurityDescriptor != IntPtr.Zero) {
        LocalFree(SecurityDescriptor);
        SecurityDescriptor = IntPtr.Zero;
      }
    }
  }

  private static int RunChild(
    IntPtr token,
    IntPtr restrictedImpersonationToken,
    string powershell,
    string systemRoot,
    string encodedCommand,
    string input,
    bool diagnostics,
    bool explicitChildSecurity,
    SecurityIdentifier user,
    SecurityIdentifier system,
    SecurityIdentifier administrators) {
    DesktopAuthority authority;
    string authorityStage;
    int authorityCode;
    bool authorityCodeIsHResult;
    if (!DesktopAuthority.TryCreate(
      out authority,
      out authorityStage,
      out authorityCode,
      out authorityCodeIsHResult)) {
      string classification = authorityCodeIsHResult
        ? "Exception:hresult-" + unchecked((uint)authorityCode).ToString("X8")
        : "win32-" + authorityCode;
      Console.Error.WriteLine(
        "standard-token-loader:" + authorityStage + ":" + classification);
      return 119;
    }
    using (authority)
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
          Desktop = authority.Name,
          Flags = StartfUseStdHandles,
          StandardInput = pipe.ClientSafePipeHandle.DangerousGetHandle(),
          StandardOutput = output,
          StandardError = output,
        };
        var command = new StringBuilder(
          "\"" + powershell + "\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " +
          encodedCommand);
        bool started;
        if (explicitChildSecurity) {
          var childSecurity = new SecurityAttributes {
            Length = Marshal.SizeOf(typeof(SecurityAttributes)),
            SecurityDescriptor = authority.SecurityDescriptor,
            InheritHandle = false,
          };
          started = CreateProcessAsUserWithSecurityW(
            token,
            powershell,
            command,
            ref childSecurity,
            ref childSecurity,
            true,
            CreateUnicodeEnvironment | CreateNoWindow,
            environment,
            system32,
            ref startup,
            out process);
        }
        else {
          started = CreateProcessAsUserW(
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
            out process);
        }
        if (!started) return Win32Failure(107, "start-restricted-process");
        if (diagnostics) {
          int processDacl = ClassifyKernelObjectDacl(
            process.Process,
            user,
            system,
            administrators);
          int threadDacl = ClassifyKernelObjectDacl(
            process.Thread,
            user,
            system,
            administrators);
          int access = ProbeRestrictedObjectAccess(
            restrictedImpersonationToken,
            process.ProcessId,
            process.ThreadId);
          Console.Error.WriteLine(
            "standard-token-loader:control-object-dacl:process-" + processDacl +
            ":thread-" + threadDacl + ":restricted-access-" + access);
        }
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
        uint exitCode;
        if (!GetExitCodeProcess(process.Process, out exitCode)) {
          return Win32Failure(112, "read-restricted-exit");
        }
        if (exitCode > 99) {
          Console.Error.WriteLine(
            "standard-token-loader:invalid-restricted-exit:child-" + exitCode.ToString("X8"));
          return 113;
        }
        if (exitCode != 0) return (int)exitCode;
        if (writerFailure != null) {
          Console.Error.WriteLine(
            "standard-token-loader:stdin-write:" + writerFailure.GetType().Name +
            ":hresult-" + writerFailure.HResult.ToString("X8"));
          return 111;
        }
        return 0;
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

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SetTokenInformation(
    IntPtr token,
    int informationClass,
    IntPtr information,
    uint informationLength);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetSecurityDescriptorDacl(
    IntPtr securityDescriptor,
    [MarshalAs(UnmanagedType.Bool)] out bool daclPresent,
    out IntPtr dacl,
    [MarshalAs(UnmanagedType.Bool)] out bool daclDefaulted);

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

  [DllImport("advapi32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EqualSid(IntPtr firstSid, byte[] secondSid);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
    string stringSecurityDescriptor,
    uint stringSdRevision,
    out IntPtr securityDescriptor,
    out uint securityDescriptorSize);

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

  [DllImport(
    "advapi32.dll",
    EntryPoint = "CreateProcessAsUserW",
    CharSet = CharSet.Unicode,
    SetLastError = true)]
  private static extern bool CreateProcessAsUserWithSecurityW(
    IntPtr token,
    string applicationName,
    StringBuilder commandLine,
    ref SecurityAttributes processAttributes,
    ref SecurityAttributes threadAttributes,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SetThreadToken(IntPtr thread, IntPtr token);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityInfo(
    IntPtr handle,
    int objectType,
    uint securityInformation,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor);

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
  private static extern IntPtr OpenProcess(
    uint desiredAccess,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
    uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenThread(
    uint desiredAccess,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
    uint threadId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr GetProcessWindowStation();

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateWindowStationW(
    string windowStation,
    uint flags,
    uint desiredAccess,
    ref SecurityAttributes securityAttributes);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateDesktopW(
    string desktop,
    string device,
    IntPtr deviceMode,
    uint flags,
    uint desiredAccess,
    ref SecurityAttributes securityAttributes);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetUserObjectInformationW(
    IntPtr userObject,
    int index,
    StringBuilder information,
    int informationLength,
    out int requiredLength);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool SetProcessWindowStation(IntPtr windowStation);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool CloseDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool CloseWindowStation(IntPtr windowStation);
}
