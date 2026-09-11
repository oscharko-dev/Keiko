import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
  type SecurityLogEvent,
} from "@oscharko-dev/keiko-security";

import {
  WINDOWS_RFC3161_VERIFIER_SOURCE,
  resolveWindowsAuthenticodeSystem,
  validateWindowsAuthenticodeVerifierAssembly,
  windowsAuthenticodeIdentityScript,
  windowsAuthenticodePublisherIdentityScript,
  windowsAuthenticodeVerifierAssemblyInput,
  windowsAuthenticodeVerifierLoaderScript,
  windowsPublisherIdentityMatches,
  windowsPublisherIdentityMatchesAsync,
  windowsSignerIdentity,
  type WindowsAuthenticodeCommandRunner,
  type WindowsAuthenticodeSystemOptions,
} from "./windowsPortableAuthenticode.js";

const SYSTEM_OPTIONS: WindowsAuthenticodeSystemOptions = {
  env: { SystemRoot: String.raw`D:\Windows` },
  existsAsFile: () => true,
  identityCheck: () => true,
};

const HAS_POWERSHELL =
  spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;
// Loading the producer SignedCms verifier can block in Apple's Security framework. The runtime
// DER-only probe remains active on macOS; full producer parity runs on Linux and Windows.
const HAS_PARITY_POWERSHELL = HAS_POWERSHELL && process.platform !== "darwin";
const PRODUCER_RFC3161_SOURCE = readFileSync("scripts/windows-portable-rfc3161.cs", "utf8");
const SIGNATURE_HEX = "010203";
const NONCANONICAL_OID_TST_INFO =
  "304d02010106022a033030300c060a608648800165030402010420" +
  "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" +
  "020101180f32303236303930353030303030305a";
const CANONICAL_TST_INFO =
  "304c02010106022a03302f300b06096086480165030402010420" +
  "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" +
  "020101180f32303236303930353030303030305a";
const FRACTIONAL_TST_INFO = CANONICAL_TST_INFO.replace("304c", "304e").replace(
  "180f32303236303930353030303030305a",
  "181132303236303930353030303030302e315a",
);
const TRAILING_ZERO_TST_INFO = FRACTIONAL_TST_INFO.replace("2e315a", "2e305a");

interface Rfc3161ParityEvidence {
  readonly canonical: readonly [boolean, boolean];
  readonly fractional: readonly [boolean, boolean];
  readonly noncanonicalOid: readonly [boolean, boolean];
  readonly oid: string;
  readonly producerOid: string;
  readonly trailingZero: readonly [boolean, boolean];
}

interface RuntimeDerEvidence {
  readonly canonical: boolean;
  readonly fractional: boolean;
  readonly noncanonicalOid: boolean;
  readonly oid: string;
  readonly trailingZero: boolean;
}

function powershellJsonProbe(sources: readonly string[], script: string, timeout: number): unknown {
  const result = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", input: JSON.stringify(sources), timeout },
  );
  if (result.status !== 0) throw new Error(result.stderr || "RFC3161 DER probe failed");
  return JSON.parse(result.stdout) as unknown;
}

function runtimeDerEvidence(): RuntimeDerEvidence {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sources=@([Console]::In.ReadToEnd()|ConvertFrom-Json)",
    "[Reflection.Assembly]::Load([Convert]::FromBase64String($sources[0]))|Out-Null",
    `function Test-RuntimeTst([string]$hex){[Keiko.Portable.Runtime.Rfc3161]::VerifyTstInfo([Convert]::FromHexString($hex),[Convert]::FromHexString('${SIGNATURE_HEX}'))}`,
    "$oidBytes=[Convert]::FromHexString('0603883703')",
    `$result=[ordered]@{canonical=(Test-RuntimeTst '${CANONICAL_TST_INFO}');fractional=(Test-RuntimeTst '${FRACTIONAL_TST_INFO}');noncanonicalOid=(Test-RuntimeTst '${NONCANONICAL_OID_TST_INFO}');trailingZero=(Test-RuntimeTst '${TRAILING_ZERO_TST_INFO}');oid=[Keiko.Portable.Runtime.Rfc3161]::DecodeOid($oidBytes)}`,
    "$result|ConvertTo-Json -Compress",
  ].join(";");
  return powershellJsonProbe(
    [windowsAuthenticodeVerifierAssemblyInput()],
    script,
    30_000,
  ) as RuntimeDerEvidence;
}

function rfc3161ParityEvidence(): Rfc3161ParityEvidence {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sources=@([Console]::In.ReadToEnd()|ConvertFrom-Json)",
    "[Reflection.Assembly]::Load([Convert]::FromBase64String($sources[0]))|Out-Null",
    "$refs=[string][AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator",
    "Add-Type -TypeDefinition $sources[1] -ReferencedAssemblies $refs",
    `function Test-ProducerParity([string]$hex){$bytes=[Convert]::FromHexString($hex);$signature=[Convert]::FromHexString('${SIGNATURE_HEX}');$runtime=[Keiko.Portable.Runtime.Rfc3161]::VerifyTstInfo($bytes,$signature);$method=[Keiko.Portable.WindowsPortableRfc3161].GetMethod('TryReadTstInfo',[Reflection.BindingFlags]'NonPublic,Static');$invokeArgs=[object[]]@($bytes,$signature,[DateTimeOffset]::MinValue);try{$producer=[bool]$method.Invoke($null,$invokeArgs)}catch{$producer=$false};return @($runtime,$producer)}`,
    `$oidBytes=[Convert]::FromHexString('0603883703')`,
    "$oidReader=[System.Formats.Asn1.AsnReader]::new($oidBytes,[System.Formats.Asn1.AsnEncodingRules]::DER)",
    `$result=[ordered]@{canonical=(Test-ProducerParity '${CANONICAL_TST_INFO}');fractional=(Test-ProducerParity '${FRACTIONAL_TST_INFO}');noncanonicalOid=(Test-ProducerParity '${NONCANONICAL_OID_TST_INFO}');trailingZero=(Test-ProducerParity '${TRAILING_ZERO_TST_INFO}');oid=[Keiko.Portable.Runtime.Rfc3161]::DecodeOid($oidBytes);producerOid=$oidReader.ReadObjectIdentifier()}`,
    "$result|ConvertTo-Json -Compress",
  ].join(";");
  return powershellJsonProbe(
    [windowsAuthenticodeVerifierAssemblyInput(), PRODUCER_RFC3161_SOURCE],
    script,
    60_000,
  ) as Rfc3161ParityEvidence;
}

function signerRunner(...identities: readonly string[]): {
  readonly commands: string[];
  readonly run: WindowsAuthenticodeCommandRunner;
} {
  const commands: string[] = [];
  let index = 0;
  return {
    commands,
    run: (command): ReturnType<WindowsAuthenticodeCommandRunner> => {
      commands.push(command);
      return {
        status: 0,
        stderr: "",
        stdout: identities[index++] ?? "",
      };
    },
  };
}

describe("Windows portable Authenticode identity", (): void => {
  it("keeps PowerShell boolean operators separated across script fragments", (): void => {
    const script = windowsAuthenticodeIdentityScript();

    expect(script).toContain("$s.SignerCertificate -or $null");
    expect(script).not.toContain("$s.SignerCertificate-or");
  });

  it("derives durable publisher identity from chain, code-signing, subscriber EKU, and timestamp checks", (): void => {
    const script = windowsAuthenticodePublisherIdentityScript();

    expect(script).toContain("X509Chain");
    expect(script).toContain("1.3.6.1.5.5.7.3.3");
    expect(script).toContain("311[.]97");
    expect(script).toContain("1.3.6.1.5.5.7.3.8");
    expect(script).toContain("TimeStamperCertificate");
    expect(script).toContain("SignerCertificate.Thumbprint");
    expect(script).toContain("GenerationTimes[0]");
    expect(script).toContain("LocalMachine\\AuthRoot");
    expect(script).toContain("[Reflection.Assembly]::Load($b)");
    expect(script).not.toContain("Add-Type");
    expect(script).not.toContain(WINDOWS_RFC3161_VERIFIER_SOURCE);
    expect(script).not.toContain("IgnoreNotTimeValid");
  });

  it("binds the precompiled verifier to exact source and assembly hashes", (): void => {
    const input = windowsAuthenticodeVerifierAssemblyInput();
    const loader = windowsAuthenticodeVerifierLoaderScript();

    expect(validateWindowsAuthenticodeVerifierAssembly(input)).toBe(input);
    expect(() => validateWindowsAuthenticodeVerifierAssembly(input.slice(0, -4))).toThrow(
      "Windows Authenticode verifier asset is invalid",
    );
    expect(() => validateWindowsAuthenticodeVerifierAssembly(`A${input.slice(1)}`)).toThrow(
      "Windows Authenticode verifier asset is invalid",
    );
    expect(loader).toContain("[Console]::In");
    expect(loader).toContain("$r.Peek() -ne -1");
    expect(loader).toContain("[Reflection.Assembly]::Load($b)");
    expect(loader).not.toContain("Add-Type");
  });

  it("embeds the producer-equivalent RFC3161 SHA-256 and historical-time gates", (): void => {
    expect(WINDOWS_RFC3161_VERIFIER_SOURCE).toContain(
      'LegacyCounterSignatureOid = "1.2.840.113549.1.9.6"',
    );
    expect(WINDOWS_RFC3161_VERIFIER_SOURCE).toContain('Sha256Oid = "2.16.840.1.101.3.4.2.1"');
    expect(WINDOWS_RFC3161_VERIFIER_SOURCE).toContain("FixedTimeEquals(observed, expected)");
    expect(WINDOWS_RFC3161_VERIFIER_SOURCE).toContain(
      "chain.ChainPolicy.VerificationTime = generationTime.UtcDateTime",
    );
    expect(WINDOWS_RFC3161_VERIFIER_SOURCE).toContain("found.EnhancedKeyUsages.Count == 1");
    expect(WINDOWS_RFC3161_VERIFIER_SOURCE).toContain("!extension.Critical");
  });

  it.skipIf(!HAS_POWERSHELL)(
    "rejects non-canonical DER and decodes a multibyte first OID arc in the runtime verifier",
    (): void => {
      expect(runtimeDerEvidence()).toEqual({
        canonical: true,
        fractional: true,
        noncanonicalOid: false,
        oid: "2.999.3",
        trailingZero: false,
      });
    },
  );

  it.skipIf(!HAS_PARITY_POWERSHELL)(
    "matches the producer on canonical OIDs and DER GeneralizedTime boundaries",
    (): void => {
      const evidence = rfc3161ParityEvidence();

      expect(evidence.canonical).toEqual([true, true]);
      expect(evidence.fractional).toEqual([true, true]);
      expect(evidence.noncanonicalOid).toEqual([false, false]);
      expect(evidence.trailingZero).toEqual([false, false]);
      expect(evidence.oid).toBe("2.999.3");
      expect(evidence.producerOid).toBe(evidence.oid);
    },
  );

  it("rejects private-root substitution at the runtime publisher boundary", (): void => {
    const script = windowsAuthenticodePublisherIdentityScript();

    expect(script).toContain("Get-ChildItem -LiteralPath Cert:\\LocalMachine\\AuthRoot");
    expect(script).toContain("if(-not (P $z)){return $null}");
    expect(script).toContain("$r -ne $sr -or $l -ne $sl");
  });

  it("uses the fixed system verifier and accepts only the trusted launcher's signer", (): void => {
    const signer = "A".repeat(40);
    const matching = signerRunner(signer, signer);

    expect(
      windowsPublisherIdentityMatches("Keiko.exe", "helper.exe", matching.run, SYSTEM_OPTIONS),
    ).toBe(true);
    const expectedCommand = resolveWindowsAuthenticodeSystem(SYSTEM_OPTIONS).command;
    expect(matching.commands).toEqual([expectedCommand, expectedCommand]);

    const mismatching = signerRunner(signer, "B".repeat(40));
    expect(
      windowsPublisherIdentityMatches("Keiko.exe", "helper.exe", mismatching.run, SYSTEM_OPTIONS),
    ).toBe(false);
  });

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])("rejects invalid signer output %#", (result): void => {
    expect(
      windowsSignerIdentity(
        "helper.exe",
        (): ReturnType<WindowsAuthenticodeCommandRunner> => result,
        SYSTEM_OPTIONS,
      ),
    ).toBeUndefined();
  });

  it("supports the same signer binding through a nonblocking command port", async (): Promise<void> => {
    const signer = "A".repeat(40);
    const results = [signer, signer];
    let index = 0;

    await expect(
      windowsPublisherIdentityMatchesAsync(
        "Keiko.exe",
        "helper.exe",
        (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> =>
          Promise.resolve({
            status: 0,
            stderr: "",
            stdout: results[index++] ?? "",
          }),
        SYSTEM_OPTIONS,
      ),
    ).resolves.toBe(true);
  });

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])(
    "rejects invalid signer output through the nonblocking command port %#",
    async (result): Promise<void> => {
      await expect(
        windowsPublisherIdentityMatchesAsync(
          "Keiko.exe",
          "helper.exe",
          (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> => Promise.resolve(result),
          SYSTEM_OPTIONS,
        ),
      ).resolves.toBe(false);
    },
  );

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "" },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])(
    "rejects invalid helper output through the nonblocking command port %#",
    async (result): Promise<void> => {
      const results = [{ status: 0, stderr: "", stdout: "A".repeat(40) }, result];
      let index = 0;

      await expect(
        windowsPublisherIdentityMatchesAsync(
          "Keiko.exe",
          "helper.exe",
          (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> =>
            Promise.resolve(results[index++] ?? result),
          SYSTEM_OPTIONS,
        ),
      ).resolves.toBe(false);
    },
  );

  it("rejects a nonblocking helper signed by a different publisher", async (): Promise<void> => {
    const results = ["A".repeat(40), "B".repeat(40)];
    let index = 0;

    await expect(
      windowsPublisherIdentityMatchesAsync(
        "Keiko.exe",
        "helper.exe",
        (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> =>
          Promise.resolve({
            status: 0,
            stderr: "",
            stdout: results[index++] ?? "",
          }),
        SYSTEM_OPTIONS,
      ),
    ).resolves.toBe(false);
  });

  it("loads lazily and emits body-free evidence when the system root is refused", (): void => {
    const events: SecurityLogEvent[] = [];
    const hostileRoot = String.raw`D:\workspace\planted-windows`;

    expect(() =>
      resolveWindowsAuthenticodeSystem({
        env: { SystemRoot: hostileRoot },
        identityCheck: () => false,
        securityLogSink: {
          write: (event): void => {
            events.push(event);
          },
        },
      }),
    ).toThrow(WindowsSystemDirectoryError);
    expect(events).toEqual([
      expect.objectContaining({
        category: "security",
        correlationId: "unknown-correlation-id",
        errorKind: "WindowsSystemDirectoryError",
        level: "warn",
        op: "portable.windows-authenticode.system-binary-refused",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(hostileRoot);
  });

  it("emits body-free diagnostic evidence when a trusted system binary is missing", (): void => {
    const events: SecurityLogEvent[] = [];
    const trustedRoot = String.raw`D:\Windows`;

    expect(() =>
      resolveWindowsAuthenticodeSystem({
        env: { SystemRoot: trustedRoot },
        existsAsFile: () => false,
        identityCheck: () => true,
        securityLogSink: {
          write: (event): void => {
            events.push(event);
          },
        },
      }),
    ).toThrow(WindowsSystemBinaryMissingError);
    expect(events).toEqual([
      expect.objectContaining({
        category: "diagnostic",
        correlationId: "unknown-correlation-id",
        errorKind: "WINDOWS_SYSTEM_BINARY_MISSING",
        level: "error",
        op: "portable.windows-authenticode.system-binary-refused",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(trustedRoot);
  });
});
