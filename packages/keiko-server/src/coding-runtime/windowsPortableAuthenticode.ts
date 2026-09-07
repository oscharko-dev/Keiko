import { execFile, spawnSync } from "node:child_process";
import { win32 as win32Path } from "node:path";
import {
  emitSecurityLogEvent,
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemBinary,
  resolveWindowsSystemDirectory,
  securityErrorKind,
  type SecurityLogSink,
  type WindowsBinaryExistsCheck,
  type WindowsSystemDirectoryIdentityCheck,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "@oscharko-dev/keiko-security";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

const WINDOWS_SIGNATURE_TIMEOUT_MS = 10_000;
const WINDOWS_SIGNER_THUMBPRINT = /^[A-F0-9]{40}$/u;

export interface WindowsAuthenticodeCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly windowsHide: boolean;
}

export interface WindowsAuthenticodeCommandResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type WindowsAuthenticodeCommandRunner = (
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
) => WindowsAuthenticodeCommandResult;

export type WindowsAuthenticodeAsyncCommandRunner = (
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
) => Promise<WindowsAuthenticodeCommandResult>;

export interface WindowsAuthenticodeSystemOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly existsAsFile?: WindowsBinaryExistsCheck | undefined;
  readonly identityCheck?: WindowsSystemDirectoryIdentityCheck | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export interface WindowsAuthenticodeSystem {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}

function logSystemResolutionFailure(error: unknown, sink: SecurityLogSink | undefined): void {
  const target = sink ?? processServerLogSink();
  if (error instanceof WindowsSystemDirectoryError) {
    emitSecurityLogEvent(target, {
      level: "warn",
      category: "security",
      op: "portable.windows-authenticode.system-binary-refused",
      correlationId: UNKNOWN_CORRELATION_ID,
      errorKind: securityErrorKind(error),
    });
  } else if (error instanceof WindowsSystemBinaryMissingError) {
    emitSecurityLogEvent(target, {
      level: "error",
      category: "diagnostic",
      op: "portable.windows-authenticode.system-binary-refused",
      correlationId: UNKNOWN_CORRELATION_ID,
      errorKind: securityErrorKind(error),
    });
  }
}

export function resolveWindowsAuthenticodeSystem(
  options: WindowsAuthenticodeSystemOptions = {},
): WindowsAuthenticodeSystem {
  const env = options.env ?? process.env;
  try {
    const systemRoot = resolveWindowsSystemDirectory(env, options.identityCheck);
    const command = resolveWindowsPowerShellExecutable(
      env,
      options.existsAsFile,
      options.identityCheck,
    );
    const cmd = resolveWindowsSystemBinary(
      "cmd.exe",
      env,
      options.existsAsFile,
      options.identityCheck,
    );
    return {
      command,
      env: {
        ComSpec: cmd,
        PATH: `${win32Path.dirname(cmd)};${systemRoot}`,
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
      },
    };
  } catch (error) {
    logSystemResolutionFailure(error, options.securityLogSink);
    throw error;
  }
}

export function windowsSystemEnvironment(
  options: WindowsAuthenticodeSystemOptions = {},
): NodeJS.ProcessEnv {
  return resolveWindowsAuthenticodeSystem(options).env;
}

function authenticodeResult(
  executable: string,
  run: WindowsAuthenticodeCommandRunner,
  systemOptions: WindowsAuthenticodeSystemOptions,
): WindowsAuthenticodeCommandResult {
  const system = resolveWindowsAuthenticodeSystem(systemOptions);
  return run(
    system.command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsAuthenticodeIdentityScript(),
      executable,
    ],
    {
      env: system.env,
      timeout: WINDOWS_SIGNATURE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}

function acceptedSignerIdentity(result: WindowsAuthenticodeCommandResult): string | undefined {
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") return undefined;
  const identity = result.stdout.trim().toUpperCase();
  return result.status === 0 && result.stderr === "" && WINDOWS_SIGNER_THUMBPRINT.test(identity)
    ? identity
    : undefined;
}

export function windowsAuthenticodeIdentityScript(): string {
  return (
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0];" +
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate" +
    " -or $null -eq $s.TimeStamperCertificate){exit 1};" +
    "[Console]::Out.Write($s.SignerCertificate.Thumbprint)"
  );
}

// Runtime copy of the release producer's bounded RFC 3161 verifier. Keep the CMS parser and
// SHA-256 imprint rules aligned with scripts/windows-portable-rfc3161.cs.
export const WINDOWS_RFC3161_VERIFIER_SOURCE = String.raw`
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;

namespace Keiko.Portable.Runtime {
public sealed class TimestampResult {
  public bool Valid { get; set; }
  public X509Certificate2[] Certificates { get; set; }
  public DateTimeOffset[] GenerationTimes { get; set; }
  public TimestampResult() {
    Certificates = new X509Certificate2[0];
    GenerationTimes = new DateTimeOffset[0];
  }
}

public static class Rfc3161 {
  private const string TimestampTokenOid = "1.2.840.113549.1.9.16.2.14";
  private const string LegacyCounterSignatureOid = "1.2.840.113549.1.9.6";
  private const string TstInfoOid = "1.2.840.113549.1.9.16.1.4";
  private const string Sha256Oid = "2.16.840.1.101.3.4.2.1";
  private const int CertQueryObjectFile = 1;
  private const int CertQueryContentFlagPkcs7SignedEmbed = 0x400;
  private const int CertQueryFormatFlagBinary = 2;
  private const int CertQueryContentPkcs7SignedEmbed = 10;
  private const int CmsgEncodedMessageParam = 29;
  private const int MaxCmsBytes = 4 * 1024 * 1024;

  public static bool VerifyTstInfo(byte[] encoded, byte[] signature) {
    DateTimeOffset generationTime;
    try { return TryReadTstInfo(encoded, signature, out generationTime); }
    catch (ArgumentException) { return false; }
    catch (CryptographicException) { return false; }
    catch (FormatException) { return false; }
    catch (InvalidOperationException) { return false; }
    catch (OverflowException) { return false; }
  }

  public static string DecodeOid(byte[] encoded) {
    var reader = new DerReader(encoded);
    string value = reader.ReadOid();
    if (reader.HasData) throw new CryptographicException();
    return value;
  }

  public static TimestampResult VerifyFile(string path) {
    try { return VerifyCms(ReadCms(path)); }
    catch (ArgumentException) { return Failure(); }
    catch (CryptographicException) { return Failure(); }
    catch (IOException) { return Failure(); }
    catch (NotSupportedException) { return Failure(); }
    catch (OverflowException) { return Failure(); }
    catch (UnauthorizedAccessException) { return Failure(); }
  }

  private static TimestampResult VerifyCms(byte[] encoded) {
    try {
      if (encoded.Length == 0 || encoded.Length > MaxCmsBytes) return Failure();
      var outer = new SignedCms();
      outer.Decode(encoded);
      outer.CheckSignature(verifySignatureOnly: true);
      if (outer.SignerInfos.Count == 0) return Failure();
      var certificates = new X509Certificate2[outer.SignerInfos.Count];
      var times = new DateTimeOffset[outer.SignerInfos.Count];
      for (int index = 0; index < outer.SignerInfos.Count; index++) {
        X509Certificate2 certificate;
        DateTimeOffset time;
        if (!TryVerifyTimestamp(outer.SignerInfos[index], out certificate, out time)) {
          return Failure();
        }
        certificates[index] = certificate;
        times[index] = time;
      }
      return new TimestampResult { Valid = true, Certificates = certificates, GenerationTimes = times };
    }
    catch (ArgumentException) { return Failure(); }
    catch (CryptographicException) { return Failure(); }
    catch (FormatException) { return Failure(); }
    catch (InvalidOperationException) { return Failure(); }
  }

  private static bool TryVerifyTimestamp(
    SignerInfo signer,
    out X509Certificate2 certificate,
    out DateTimeOffset generationTime) {
    certificate = null;
    generationTime = default(DateTimeOffset);
    CryptographicAttributeObject tokenAttribute = null;
    foreach (CryptographicAttributeObject attribute in signer.UnsignedAttributes) {
      if (attribute.Oid != null && attribute.Oid.Value == LegacyCounterSignatureOid) return false;
      if (attribute.Oid != null && attribute.Oid.Value == TimestampTokenOid) {
        if (tokenAttribute != null) return false;
        tokenAttribute = attribute;
      }
    }
    if (tokenAttribute == null || tokenAttribute.Values.Count != 1) return false;
    var token = new SignedCms();
    token.Decode(tokenAttribute.Values[0].RawData);
    if (token.ContentInfo.ContentType.Value != TstInfoOid || token.SignerInfos.Count != 1) return false;
    token.CheckSignature(verifySignatureOnly: true);
    certificate = token.SignerInfos[0].Certificate;
    if (certificate == null || !TryReadTstInfo(
      token.ContentInfo.Content,
      signer.GetSignature(),
      out generationTime)) return false;
    return HasExactTimestampEku(certificate) &&
      VerifyTimestampChain(certificate, token.Certificates, generationTime);
  }

  private static bool TryReadTstInfo(
    byte[] encoded,
    byte[] signerSignature,
    out DateTimeOffset generationTime) {
    generationTime = default(DateTimeOffset);
    var reader = new DerReader(encoded);
    var tstInfo = reader.ReadConstructed(0x30);
    if (!tstInfo.ReadIntegerEqualsOne() || string.IsNullOrEmpty(tstInfo.ReadOid())) return false;
    var imprint = tstInfo.ReadConstructed(0x30);
    var algorithm = imprint.ReadConstructed(0x30);
    if (algorithm.ReadOid() != Sha256Oid) return false;
    if (algorithm.HasData && !algorithm.ReadNull()) return false;
    if (algorithm.HasData) return false;
    byte[] observed = imprint.ReadOctets();
    if (imprint.HasData || observed.Length != 32 || !tstInfo.ReadPositiveInteger()) return false;
    generationTime = tstInfo.ReadGeneralizedTime();
    ReadOptionalFields(tstInfo);
    if (tstInfo.HasData || reader.HasData) return false;
    byte[] expected;
    using (var sha = SHA256.Create()) { expected = sha.ComputeHash(signerSignature); }
    return FixedTimeEquals(observed, expected);
  }

  private static void ReadOptionalFields(DerReader tstInfo) {
    var expected = new byte[] { 0x30, 0x01, 0x02, 0xA0, 0xA1 };
    int next = 0;
    while (tstInfo.HasData) {
      byte observed = tstInfo.PeekTag();
      while (next < expected.Length && observed != expected[next]) next++;
      if (next == expected.Length) throw new CryptographicException();
      tstInfo.SkipValue();
      next++;
    }
  }

  private static bool VerifyTimestampChain(
    X509Certificate2 certificate,
    X509Certificate2Collection tokenCertificates,
    DateTimeOffset generationTime) {
    using (var chain = new X509Chain()) {
      chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
      chain.ChainPolicy.RevocationFlag = X509RevocationFlag.EntireChain;
      chain.ChainPolicy.VerificationTime = generationTime.UtcDateTime;
      chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.8"));
      chain.ChainPolicy.ExtraStore.AddRange(tokenCertificates);
      return chain.Build(certificate);
    }
  }

  private static bool HasExactTimestampEku(X509Certificate2 certificate) {
    X509EnhancedKeyUsageExtension found = null;
    foreach (X509Extension extension in certificate.Extensions) {
      if (extension.Oid == null || extension.Oid.Value != "2.5.29.37") continue;
      if (found != null || !extension.Critical) return false;
      found = new X509EnhancedKeyUsageExtension(extension, extension.Critical);
    }
    return found != null && found.EnhancedKeyUsages.Count == 1 &&
      found.EnhancedKeyUsages[0].Value == "1.3.6.1.5.5.7.3.8";
  }

  private static bool FixedTimeEquals(byte[] left, byte[] right) {
    if (left.Length != right.Length) return false;
    int difference = 0;
    for (int index = 0; index < left.Length; index++) difference |= left[index] ^ right[index];
    return difference == 0;
  }

  private sealed class DerReader {
    private readonly byte[] data;
    private readonly int end;
    private int offset;

    public DerReader(byte[] value) : this(value, 0, value.Length) { }
    private DerReader(byte[] value, int start, int length) {
      data = value;
      offset = start;
      end = checked(start + length);
    }
    public bool HasData { get { return offset < end; } }
    public byte PeekTag() {
      if (!HasData) throw new CryptographicException();
      return data[offset];
    }
    public DerReader ReadConstructed(byte expectedTag) {
      int length;
      ReadHeader(expectedTag, out length);
      var value = new DerReader(data, offset, length);
      offset += length;
      return value;
    }
    public bool ReadIntegerEqualsOne() {
      byte[] value = ReadPrimitive(0x02);
      return value.Length == 1 && value[0] == 1;
    }
    public bool ReadPositiveInteger() {
      byte[] value = ReadPrimitive(0x02);
      if (value.Length == 0 || (value[0] & 0x80) != 0) return false;
      if (value.Length > 1 && value[0] == 0 && (value[1] & 0x80) == 0) return false;
      for (int index = 0; index < value.Length; index++) if (value[index] != 0) return true;
      return false;
    }
    public string ReadOid() {
      byte[] value = ReadPrimitive(0x06);
      if (value.Length == 0) throw new CryptographicException();
      int index = 0;
      long combined = ReadBase128(value, ref index);
      long first = combined < 40 ? 0 : combined < 80 ? 1 : 2;
      long second = combined - first * 40;
      string text = first.ToString(CultureInfo.InvariantCulture) + "." +
        second.ToString(CultureInfo.InvariantCulture);
      while (index < value.Length) {
        long component = ReadBase128(value, ref index);
        text += "." + component.ToString(CultureInfo.InvariantCulture);
      }
      return text;
    }
    public byte[] ReadOctets() { return ReadPrimitive(0x04); }
    public bool ReadNull() { return ReadPrimitive(0x05).Length == 0; }
    public DateTimeOffset ReadGeneralizedTime() {
      string value = Encoding.ASCII.GetString(ReadPrimitive(0x18));
      if (!Regex.IsMatch(value, @"^[0-9]{14}(?:[.][0-9]{1,7})?Z$")) {
        throw new CryptographicException();
      }
      DateTime instant = DateTime.ParseExact(
        value.Substring(0, 14), "yyyyMMddHHmmss", CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
      int dot = value.IndexOf('.');
      if (dot >= 0) {
        string fraction = value.Substring(dot + 1, value.Length - dot - 2);
        if (fraction.EndsWith("0", StringComparison.Ordinal)) throw new CryptographicException();
        instant = instant.AddTicks(long.Parse(fraction.PadRight(7, '0'), CultureInfo.InvariantCulture));
      }
      return new DateTimeOffset(instant);
    }
    public void SkipValue() {
      byte tag = PeekTag();
      int length;
      ReadHeader(tag, out length);
      offset += length;
    }
    private byte[] ReadPrimitive(byte expectedTag) {
      int length;
      ReadHeader(expectedTag, out length);
      var value = new byte[length];
      Buffer.BlockCopy(data, offset, value, 0, length);
      offset += length;
      return value;
    }
    private static long ReadBase128(byte[] value, ref int index) {
      if (index >= value.Length || value[index] == 0x80) throw new CryptographicException();
      long component = 0;
      while (index < value.Length) {
        byte current = value[index++];
        if (component > (long.MaxValue >> 7)) throw new CryptographicException();
        component = (component << 7) | (uint)(current & 0x7F);
        if ((current & 0x80) == 0) return component;
      }
      throw new CryptographicException();
    }
    private void ReadHeader(byte expectedTag, out int length) {
      if (!HasData || data[offset++] != expectedTag || offset >= end) {
        throw new CryptographicException();
      }
      int first = data[offset++];
      if ((first & 0x80) == 0) length = first;
      else {
        int count = first & 0x7F;
        if (count == 0 || count > 4 || offset + count > end || data[offset] == 0) {
          throw new CryptographicException();
        }
        length = 0;
        for (int index = 0; index < count; index++) length = checked((length << 8) | data[offset++]);
        if (length < 128) throw new CryptographicException();
      }
      if (length < 0 || length > end - offset) throw new CryptographicException();
    }
  }

  private static byte[] ReadCms(string path) {
    int encodingType;
    int contentType;
    int formatType;
    IntPtr store;
    IntPtr message;
    if (!CryptQueryObject(
      CertQueryObjectFile, path, CertQueryContentFlagPkcs7SignedEmbed,
      CertQueryFormatFlagBinary, 0, out encodingType, out contentType, out formatType,
      out store, out message, IntPtr.Zero)) throw new CryptographicException();
    try {
      if (contentType != CertQueryContentPkcs7SignedEmbed) throw new CryptographicException();
      int size = 0;
      if (!CryptMsgGetParam(message, CmsgEncodedMessageParam, 0, null, ref size) ||
        size <= 0 || size > MaxCmsBytes) throw new CryptographicException();
      byte[] encoded = new byte[size];
      if (!CryptMsgGetParam(message, CmsgEncodedMessageParam, 0, encoded, ref size) ||
        size != encoded.Length) throw new CryptographicException();
      return encoded;
    }
    finally {
      if (message != IntPtr.Zero) CryptMsgClose(message);
      if (store != IntPtr.Zero) CertCloseStore(store, 0);
    }
  }

  private static TimestampResult Failure() { return new TimestampResult(); }

  [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool CryptQueryObject(
    int objectType, string objectPath, int expectedContentTypeFlags,
    int expectedFormatTypeFlags, int flags, out int encodingType,
    out int contentType, out int formatType, out IntPtr certificateStore,
    out IntPtr message, IntPtr context);

  [DllImport("crypt32.dll", SetLastError = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool CryptMsgGetParam(
    IntPtr message, int paramType, int index, [Out] byte[] data, ref int dataSize);

  [DllImport("crypt32.dll")]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool CryptMsgClose(IntPtr message);

  [DllImport("crypt32.dll")]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool CertCloseStore(IntPtr store, int flags);
}}
`;

export function windowsAuthenticodePublisherIdentityScript(): string {
  return (
    "$ErrorActionPreference='Stop';" +
    "$src=@'\n" +
    WINDOWS_RFC3161_VERIFIER_SOURCE +
    "\n'@;Add-Type -TypeDefinition $src -ReferencedAssemblies @('System.dll','System.Core.dll','System.Security.dll');" +
    "function E($c){@($c.Extensions|?{$_.Oid.Value -eq '2.5.29.37'}|%{" +
    "([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($_,$_.Critical)).EnhancedKeyUsages|%{$_.Value}})};" +
    "function P($c){@(Get-ChildItem -LiteralPath Cert:\\LocalMachine\\AuthRoot|?{$_.Thumbprint -eq $c.Thumbprint}).Count -eq 1};" +
    "function R($c,$time,$eku){$x=[Security.Cryptography.X509Certificates.X509Chain]::new();try{" +
    "$x.ChainPolicy.RevocationMode='Online';$x.ChainPolicy.RevocationFlag='EntireChain';" +
    "$x.ChainPolicy.VerificationTime=$time.UtcDateTime;" +
    "$x.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new($eku));" +
    "if(-not $x.Build($c) -or $x.ChainElements.Count -lt 2){return $null};" +
    "$z=$x.ChainElements[$x.ChainElements.Count-1].Certificate;if(-not (P $z)){return $null};$z.Thumbprint}finally{$x.Dispose()}};" +
    "$p=Get-Item -LiteralPath $args[0] -Force;" +
    "$f=@(if($p.PSIsContainer){Get-ChildItem -LiteralPath $p.FullName -Recurse -Force -File|" +
    "?{$_.Extension -in '.exe','.dll','.node'}}else{$p});if($f.Count -eq 0){exit 1};" +
    "$i=$null;$r=$null;$l=$null;" +
    "foreach($v in $f){$s=Get-AuthenticodeSignature -LiteralPath $v.FullName;" +
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $null -eq $s.TimeStamperCertificate){exit 1};" +
    "$q=[Keiko.Portable.Runtime.Rfc3161]::VerifyFile($v.FullName);" +
    "if(-not $q.Valid -or $q.Certificates.Count -ne 1 -or $q.GenerationTimes.Count -ne 1){exit 1};" +
    "if($s.TimeStamperCertificate.Thumbprint -ne $q.Certificates[0].Thumbprint){exit 1};" +
    "$e=@(E $s.SignerCertificate);$j=@($e|?{$_ -match '^1[.]3[.]6[.]1[.]4[.]1[.]311[.]97[.][0-9]+(?:[.][0-9]+)*$'});" +
    "$sr=R $s.SignerCertificate $q.GenerationTimes[0] '1.3.6.1.5.5.7.3.3';" +
    "$tr=R $q.Certificates[0] $q.GenerationTimes[0] '1.3.6.1.5.5.7.3.8';" +
    "if($e -notcontains '1.3.6.1.5.5.7.3.3' -or $j.Count -ne 1 -or $null -eq $sr){exit 1};" +
    "if($null -eq $tr){exit 1};" +
    "$sl=$s.SignerCertificate.Thumbprint;" +
    "if($null -eq $i){$i=$j[0];$r=$sr;$l=$sl}elseif($i -ne $j[0] -or $r -ne $sr -or $l -ne $sl){exit 1}};" +
    "[Console]::Out.Write(('{0}|{1}|{2}' -f $i,$r,$l))"
  );
}

export function windowsSignerIdentity(
  executable: string,
  run: WindowsAuthenticodeCommandRunner = runWindowsAuthenticodeCommand,
  systemOptions: WindowsAuthenticodeSystemOptions = {},
): string | undefined {
  return acceptedSignerIdentity(authenticodeResult(executable, run, systemOptions));
}

export function windowsPublisherIdentityMatches(
  trustedLauncher: string,
  executable: string,
  run: WindowsAuthenticodeCommandRunner = runWindowsAuthenticodeCommand,
  systemOptions: WindowsAuthenticodeSystemOptions = {},
): boolean {
  const trustedIdentity = windowsSignerIdentity(trustedLauncher, run, systemOptions);
  return (
    trustedIdentity !== undefined &&
    windowsSignerIdentity(executable, run, systemOptions) === trustedIdentity
  );
}

export async function windowsPublisherIdentityMatchesAsync(
  trustedLauncher: string,
  executable: string,
  run: WindowsAuthenticodeAsyncCommandRunner = runWindowsAuthenticodeCommandAsync,
  systemOptions: WindowsAuthenticodeSystemOptions = {},
): Promise<boolean> {
  const trustedIdentity = await windowsSignerIdentityAsync(trustedLauncher, run, systemOptions);
  return (
    trustedIdentity !== undefined &&
    (await windowsSignerIdentityAsync(executable, run, systemOptions)) === trustedIdentity
  );
}

async function windowsSignerIdentityAsync(
  executable: string,
  run: WindowsAuthenticodeAsyncCommandRunner,
  systemOptions: WindowsAuthenticodeSystemOptions,
): Promise<string | undefined> {
  const system = resolveWindowsAuthenticodeSystem(systemOptions);
  const result = await run(
    system.command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsAuthenticodeIdentityScript(),
      executable,
    ],
    {
      env: system.env,
      timeout: WINDOWS_SIGNATURE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const identity = result.stdout.trim().toUpperCase();
  return result.status === 0 && result.stderr === "" && WINDOWS_SIGNER_THUMBPRINT.test(identity)
    ? identity
    : undefined;
}

function runWindowsAuthenticodeCommandAsync(
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
): Promise<WindowsAuthenticodeCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env: options.env,
        shell: false,
        timeout: options.timeout,
        windowsHide: options.windowsHide,
      },
      (error, stdout, stderr) => {
        let status: number | null = null;
        if (error === null) {
          status = 0;
        } else if (typeof error.code === "number") {
          status = error.code;
        }
        resolve({
          status,
          stderr,
          stdout,
        });
      },
    );
  });
}

function runWindowsAuthenticodeCommand(
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
): WindowsAuthenticodeCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: options.env,
    shell: false,
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}
