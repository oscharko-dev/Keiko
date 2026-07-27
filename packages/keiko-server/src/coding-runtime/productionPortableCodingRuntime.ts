import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, win32 } from "node:path";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import {
  qualificationFromReceipt,
  type LongLivedRuntimeQualification,
  type RuntimeQualificationReceiptBinding,
} from "@oscharko-dev/keiko-sandbox";

import { productionUpdateFacts } from "../update-install-mode.js";
import {
  evaluatePortableSidecarAvailability,
  verifyPortableAttestedSidecars,
  type PortableSidecarRuntimeVerification,
} from "../update-portable-sidecar-verification.js";
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
import { safeRealFile } from "./nativeRuntimeProcessPaths.js";

const ACTIVATION_PATH = ".portable/runtime-activation.json";
const MACOS_RECEIPT_PATH = ".portable/runtime-qualification.json";
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_ATTESTATION_BYTES = 65_536;
const TARGETS = new Set<UpdatePortableTarget>(["windows-x64", "macos-arm64", "macos-x64"]);

export interface QualifiedPortableOpenCodeRuntime {
  readonly installRoot: string;
  readonly target: UpdatePortableTarget;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly qualification: LongLivedRuntimeQualification;
  readonly nativeHelperPath: string;
}

interface PortableRuntimeAttestationPort {
  readReceipt(input: {
    readonly resourceRoot: string;
    readonly target: UpdatePortableTarget;
  }): unknown;
}

export interface PortableOpenCodeDiscoveryInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  /** Resource root injection for deterministic tests; production derives it from the package. */
  readonly installRoot?: string | undefined;
  readonly attestation?: PortableRuntimeAttestationPort | undefined;
}

interface PortableRuntimeCandidate {
  readonly root: string;
  readonly target: UpdatePortableTarget;
  readonly activation: Record<string, unknown>;
  readonly activationSha256: string;
  readonly sourceCommitSha: string;
  readonly supervisorSha256: string;
  readonly secureReadSha256: string;
  readonly sidecar: PortableSidecarRuntimeVerification;
}

interface BoundActivation {
  readonly activation: Record<string, unknown>;
  readonly activationPath: string;
  readonly sourceCommitSha: string;
}

export function discoverQualifiedPortableOpenCode(
  input: PortableOpenCodeDiscoveryInput,
): QualifiedPortableOpenCodeRuntime | undefined {
  try {
    const candidate = portableRuntimeCandidate(input);
    return candidate === undefined ? undefined : qualifiedRuntime(candidate, input.attestation);
  } catch {
    return undefined;
  }
}

/** Re-runs platform trust and exact-byte discovery before each privileged helper admission. */
export function verifyQualifiedPortableRuntimeAtPointOfUse(
  runtime: QualifiedPortableOpenCodeRuntime,
): boolean {
  const host = hostForTarget(runtime.target);
  const current = discoverQualifiedPortableOpenCode({
    env: {},
    installRoot: runtime.installRoot,
    ...host,
  });
  return (
    current?.target === runtime.target &&
    current.qualification.releaseReceipt === runtime.qualification.releaseReceipt
  );
}

function portableRuntimeCandidate(
  input: PortableOpenCodeDiscoveryInput,
): PortableRuntimeCandidate | undefined {
  const target = runtimeTarget(input.platform ?? process.platform, input.arch ?? process.arch);
  if (target === undefined) return undefined;
  const root = trustedResourceRoot(input);
  if (root === undefined || !setupMatches(root, target)) return undefined;
  const bound = boundActivation(root, target);
  if (bound === undefined) return undefined;
  const helpers = boundHelperDigests(root, bound.activation, target);
  const sidecar = qualifiedSidecar(root, bound.activation, target);
  if (helpers === undefined || sidecar === undefined) return undefined;
  return {
    root,
    target,
    activation: bound.activation,
    activationSha256: sha256File(bound.activationPath),
    sourceCommitSha: bound.sourceCommitSha,
    ...helpers,
    sidecar,
  };
}

function boundActivation(root: string, target: UpdatePortableTarget): BoundActivation | undefined {
  const activationPath = safeRealFile(join(root, ...ACTIVATION_PATH.split("/")));
  const activation = readRecord(activationPath);
  if (activation === undefined || activationTarget(activation) !== target) return undefined;
  const sourceCommitSha = stringField(activation, "sourceCommitSha", /^[a-f0-9]{40}$/u);
  return sourceCommitSha === undefined
    ? undefined
    : { activation, activationPath, sourceCommitSha };
}

function qualifiedRuntime(
  candidate: PortableRuntimeCandidate,
  port: PortableRuntimeAttestationPort | undefined,
): QualifiedPortableOpenCodeRuntime | undefined {
  const receipt = (port ?? PLATFORM_ATTESTATION).readReceipt({
    resourceRoot: candidate.root,
    target: candidate.target,
  });
  const binding: RuntimeQualificationReceiptBinding = {
    platformTarget: candidate.target,
    sourceCommitSha: candidate.sourceCommitSha,
    activationManifestSha256: candidate.activationSha256,
    supervisorSha256: candidate.supervisorSha256,
    secureReadSha256: candidate.secureReadSha256,
    sidecars: [
      { name: candidate.sidecar.summary.name, sha256: candidate.sidecar.summary.payloadSha256 },
    ],
  };
  const result = qualificationFromReceipt(receipt, binding);
  if (!result.ok) return undefined;
  return {
    installRoot: candidate.root,
    target: candidate.target,
    manifest: candidate.activation,
    sidecar: candidate.sidecar,
    qualification: result.qualification,
    nativeHelperPath: helperPath(candidate.root, candidate.target, "keiko-runtime-supervisor"),
  };
}

const PLATFORM_ATTESTATION: PortableRuntimeAttestationPort = Object.freeze({
  readReceipt: ({
    resourceRoot,
    target,
  }: {
    readonly resourceRoot: string;
    readonly target: UpdatePortableTarget;
  }) =>
    target === "windows-x64"
      ? readWindowsAttestation(resourceRoot)
      : readMacosAttestation(resourceRoot),
});

function readWindowsAttestation(resourceRoot: string): unknown {
  const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
  const executable = safeRealFile(
    join(resourceRoot, "runtime", "native", "keiko-runtime-attestation.exe"),
  );
  verifyWindowsSignature(executable);
  const result = spawnSync(executable, ["--emit"], {
    encoding: "utf8",
    env: {
      SystemRoot: systemRoot,
    },
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: MAX_ATTESTATION_BYTES,
  });
  if (result.status !== 0 || result.stderr !== "" || Buffer.byteLength(result.stdout) === 0) {
    throw new Error("runtime-attestation-unavailable");
  }
  return JSON.parse(result.stdout);
}

function verifyWindowsSignature(executable: string): void {
  const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
  const powershell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script =
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0];" +
    "if($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate){exit 1}";
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, executable],
    {
      encoding: "utf8",
      env: {
        SystemRoot: systemRoot,
      },
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (result.status !== 0) throw new Error("runtime-attestation-signature-invalid");
}

function readMacosAttestation(resourceRoot: string): unknown {
  const appRoot = dirname(dirname(resourceRoot));
  runMacosVerifier("/usr/bin/codesign", ["--verify", "--deep", "--strict", appRoot]);
  runMacosVerifier("/usr/sbin/spctl", ["--assess", "--type", "execute", appRoot]);
  const manager = safeRealFile(
    join(dirname(dirname(resourceRoot)), "Contents", "MacOS", "KeikoSystemExtensionManager"),
  );
  const status = spawnSync(manager, ["--status"], {
    encoding: "utf8",
    env: {},
    shell: false,
    timeout: 10_000,
  });
  if (status.status !== 0 || status.stdout.trim() !== "active" || status.stderr !== "") {
    throw new Error("runtime-system-extension-inactive");
  }
  return readRecord(safeRealFile(join(resourceRoot, ...MACOS_RECEIPT_PATH.split("/"))));
}

function runMacosVerifier(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/usr/sbin" },
    shell: false,
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error("runtime-app-seal-invalid");
}

function trustedResourceRoot(input: PortableOpenCodeDiscoveryInput): string | undefined {
  const packageRoot = productionUpdateFacts(input.env).packageRoot;
  const candidate =
    input.installRoot ?? (packageRoot === undefined ? undefined : dirname(packageRoot));
  if (candidate === undefined) return undefined;
  const root = realpathSync(candidate);
  return statSync(root).isDirectory() ? root : undefined;
}

function runtimeTarget(platform: NodeJS.Platform, arch: string): UpdatePortableTarget | undefined {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  return undefined;
}

function hostForTarget(target: UpdatePortableTarget): {
  readonly platform: NodeJS.Platform;
  readonly arch: "arm64" | "x64";
} {
  return target === "windows-x64"
    ? { platform: "win32", arch: "x64" }
    : {
        platform: "darwin",
        arch: target === "macos-arm64" ? "arm64" : "x64",
      };
}

function setupMatches(root: string, target: UpdatePortableTarget): boolean {
  const setup = readRecord(join(root, ".portable", "setup-manifest.json"));
  return setup?.platformTarget === target && setup.stable === true;
}

function qualifiedSidecar(
  root: string,
  activation: Record<string, unknown>,
  target: UpdatePortableTarget,
): PortableSidecarRuntimeVerification | undefined {
  const sidecars = verifyPortableAttestedSidecars(activation, target).sidecars;
  if (sidecars.length !== 1 || sidecars[0]?.summary.name !== "opencode-compatible") {
    return undefined;
  }
  const sidecar = sidecars[0];
  const disk = inspectStagedSidecarPayload(root, sidecar);
  const availability = evaluatePortableSidecarAvailability(sidecar, { target, ...disk });
  return availability.available ? sidecar : undefined;
}

function boundHelperDigests(
  root: string,
  activation: Record<string, unknown>,
  target: UpdatePortableTarget,
): { readonly supervisorSha256: string; readonly secureReadSha256: string } | undefined {
  const helpers = Array.isArray(activation.nativeHelpers) ? activation.nativeHelpers : [];
  if (helpers.length !== 2) return undefined;
  const supervisor = boundHelperDigest(root, helpers, target, "keiko-runtime-supervisor");
  const secureRead = boundHelperDigest(root, helpers, target, "keiko-secure-workspace-read");
  return supervisor === undefined || secureRead === undefined
    ? undefined
    : { supervisorSha256: supervisor, secureReadSha256: secureRead };
}

function boundHelperDigest(
  root: string,
  helpers: readonly unknown[],
  target: UpdatePortableTarget,
  name: "keiko-runtime-supervisor" | "keiko-secure-workspace-read",
): string | undefined {
  const matches = helpers.map(record).filter((helper) => helper?.name === name);
  if (matches.length !== 1) return undefined;
  const helper = matches[0];
  const expectedPath = helperRelativePath(target, name);
  const expectedDigest = stringField(helper, "shippedSha256", DIGEST);
  const expectedSize = helper?.sizeBytes;
  if (
    expectedDigest === undefined ||
    !helperBindingIsValid(helper, target, expectedPath, expectedSize)
  )
    return undefined;
  const path = safeRealFile(join(root, ...expectedPath.split("/")));
  const entry = statSync(path);
  return entry.size === expectedSize && sha256File(path) === expectedDigest
    ? expectedDigest
    : undefined;
}

function helperBindingIsValid(
  helper: Record<string, unknown> | undefined,
  target: UpdatePortableTarget,
  expectedPath: string,
  expectedSize: unknown,
): expectedSize is number {
  return (
    helper?.platformTarget === target &&
    helper.executablePath === expectedPath &&
    Number.isSafeInteger(expectedSize) &&
    Number(expectedSize) > 0
  );
}

function helperPath(
  root: string,
  target: UpdatePortableTarget,
  name: "keiko-runtime-supervisor" | "keiko-secure-workspace-read",
): string {
  return safeRealFile(join(root, ...helperRelativePath(target, name).split("/")));
}

function helperRelativePath(
  target: UpdatePortableTarget,
  name: "keiko-runtime-supervisor" | "keiko-secure-workspace-read",
): string {
  return `runtime/native/${name}${target === "windows-x64" ? ".exe" : ""}`;
}

function readRecord(path: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return record(parsed);
}

function activationTarget(manifest: Record<string, unknown>): UpdatePortableTarget | undefined {
  const value = manifest.platformTarget;
  return typeof value === "string" && TARGETS.has(value as UpdatePortableTarget)
    ? (value as UpdatePortableTarget)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
  pattern: RegExp,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && pattern.test(candidate) ? candidate : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
