import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import {
  qualificationFromReceipt,
  type LongLivedRuntimeQualification,
  type RuntimeQualificationReceiptBinding,
} from "@oscharko-dev/keiko-sandbox";

import { productionUpdateFacts } from "../update-install-mode.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import {
  evaluatePortableSidecarAvailability,
  verifyPortableAttestedSidecars,
  type PortableSidecarRuntimeVerification,
} from "../update-portable-sidecar-verification.js";
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
import {
  macosDeveloperIdRequirement,
  macosReleaseTeamIdentifier,
  macosTeamIdentifierFromOutput,
} from "./macosPortableCodeIdentity.js";
import { safeRealDirectory, safeRealFile } from "./nativeRuntimeProcessPaths.js";
import { declaredPortableRuntimeLane, type PortableRuntimeLane } from "./portableRuntimeLane.js";
import {
  windowsPublisherIdentityMatches,
  windowsSystemEnvironment,
} from "./windowsPortableAuthenticode.js";

const ACTIVATION_PATH = ".portable/runtime-activation.json";
const MACOS_RECEIPT_PATH = ".portable/runtime-qualification.json";
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_ATTESTATION_BYTES = 65_536;
const MACOS_SYSTEM_EXTENSION_IDENTIFIER = "com.oscharko.keiko.runtime-monitor.systemextension";
const TARGETS = new Set<UpdatePortableTarget>(["windows-x64", "macos-arm64", "macos-x64"]);

export interface QualifiedPortableOpenCodeRuntime {
  readonly installRoot: string;
  readonly target: UpdatePortableTarget;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly qualification: LongLivedRuntimeQualification;
  readonly nativeHelperPath: string;
  /**
   * The lane this artifact DECLARES in its own activation document (ADR-0163 D9). The field is
   * deliberately not called `evidenceClass` or `lane`: both names are structural discriminators
   * elsewhere (`"evidenceClass" in portable` at productionOpenCodeActivation.ts and
   * `"lane" in portable` there and in productionOpenCodeBackend.ts), and either would silently
   * reroute every packaged runtime to a different code path with no diagnostic.
   */
  readonly platformAssurance: PortableRuntimeLane;
}

interface PortableRuntimeAttestationPort {
  readReceipt(input: {
    readonly resourceRoot: string;
    readonly target: UpdatePortableTarget;
  }): unknown;
}

export interface PortableRuntimeCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer?: number | undefined;
  readonly timeout: number;
  readonly windowsHide?: boolean | undefined;
}

export interface PortableRuntimeCommandResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type PortableRuntimeCommandRunner = (
  command: string,
  args: readonly string[],
  options: PortableRuntimeCommandOptions,
) => PortableRuntimeCommandResult;

export interface PortableOpenCodeDiscoveryInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  /** Resource root injection for deterministic tests; production derives it from the package. */
  readonly installRoot?: string | undefined;
  readonly attestation?: PortableRuntimeAttestationPort | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
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
  readonly platformAssurance: PortableRuntimeLane;
}

interface BoundActivation {
  readonly activation: Record<string, unknown>;
  readonly activationPath: string;
  readonly sourceCommitSha: string;
}

/**
 * Discovers the packaged portable OpenCode runtime. An absent installation — no install root or
 * no `.portable/setup-manifest.json` presence marker, the expected state on dev machines — is a
 * silent "not found" that returns undefined. Only a PRESENT installation that fails verification
 * (unreadable or malformed manifests, partial tree, attestation errors) emits the redacted
 * discovery diagnostic (audit finding F-12c).
 */
export function discoverQualifiedPortableOpenCode(
  input: PortableOpenCodeDiscoveryInput,
): QualifiedPortableOpenCodeRuntime | undefined {
  try {
    const candidate = portableRuntimeCandidate(input);
    return candidate === undefined ? undefined : qualifiedRuntime(candidate, input.attestation);
  } catch (error) {
    emitServerDiagnostic(
      input.diagnostics,
      serverDiagnosticFromError({
        correlationId: randomUUID(),
        operation: "coding.runtime.discover",
        source: "coding.runtime.discovery",
        error,
        redact: () => DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      }),
    );
    return undefined;
  }
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
  const platformAssurance = artifactDeclaredLane(bound.activation);
  if (platformAssurance === undefined) return undefined;
  const helpers = boundHelperDigests(root, bound.activation, target);
  const sidecar = qualifiedSidecar(root, bound.activation, target, platformAssurance);
  if (helpers === undefined || sidecar === undefined) return undefined;
  return {
    root,
    target,
    activation: bound.activation,
    activationSha256: sha256File(bound.activationPath),
    sourceCommitSha: bound.sourceCommitSha,
    ...helpers,
    sidecar,
    platformAssurance,
  };
}

/**
 * The lane is a fact the artifact declares about ITSELF, never an argument a caller supplies, and
 * it must be declared coherently artifact-wide. A staging or pull-request artifact resolves to
 * `undefined` and is refused here, before any other work; a hand-edited manifest that declares one
 * lane at the top level and another in a sidecar or native-helper signing block is a refusal, not
 * a partial waiver.
 */
function artifactDeclaredLane(
  activation: Record<string, unknown>,
): PortableRuntimeLane | undefined {
  const declared = declaredPortableRuntimeLane(record(activation.security));
  if (declared === undefined) return undefined;
  const blocks = [
    ...signingBlocks(activation.sidecarRuntimes),
    ...signingBlocks(activation.nativeHelpers),
  ];
  if (blocks.length === 0) return undefined;
  return blocks.every((block) => blockDeclaresLane(block, declared)) ? declared : undefined;
}

function signingBlocks(entries: unknown): readonly (Record<string, unknown> | undefined)[] {
  return Array.isArray(entries) ? entries.map((entry) => record(record(entry)?.signing)) : [];
}

/**
 * The native-helper signing block carries `verificationStatus` but no `verificationPolicy`, so the
 * lane is matched on the status alone for those; sidecar blocks carry the full declared pair.
 */
function blockDeclaresLane(
  block: Record<string, unknown> | undefined,
  lane: PortableRuntimeLane,
): boolean {
  if (block === undefined) return false;
  if (block.verificationPolicy !== undefined) return declaredPortableRuntimeLane(block) === lane;
  return (
    block.verificationStatus ===
    (lane === "release-qualified" ? "verified-production" : "evaluation-unqualified")
  );
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
  const binding = receiptBinding(candidate);
  const qualification =
    candidate.platformAssurance === "evaluation-unqualified"
      ? evaluationQualification(candidate, binding)
      : platformQualification(candidate, binding, port);
  if (qualification === undefined) return undefined;
  return {
    installRoot: candidate.root,
    target: candidate.target,
    manifest: candidate.activation,
    sidecar: candidate.sidecar,
    qualification,
    nativeHelperPath: helperPath(candidate.root, candidate.target, "keiko-runtime-supervisor"),
    platformAssurance: candidate.platformAssurance,
  };
}

function receiptBinding(candidate: PortableRuntimeCandidate): RuntimeQualificationReceiptBinding {
  return {
    platformTarget: candidate.target,
    sourceCommitSha: candidate.sourceCommitSha,
    activationManifestSha256: candidate.activationSha256,
    supervisorSha256: candidate.supervisorSha256,
    secureReadSha256: candidate.secureReadSha256,
    sidecars: [
      { name: candidate.sidecar.summary.name, sha256: candidate.sidecar.summary.payloadSha256 },
    ],
  };
}

function platformQualification(
  candidate: PortableRuntimeCandidate,
  binding: RuntimeQualificationReceiptBinding,
  port: PortableRuntimeAttestationPort | undefined,
): LongLivedRuntimeQualification | undefined {
  const receipt = (port ?? PLATFORM_ATTESTATION).readReceipt({
    resourceRoot: candidate.root,
    target: candidate.target,
  });
  const result = qualificationFromReceipt(receipt, binding);
  return result.ok ? result.qualification : undefined;
}

/**
 * THE ONE PLACE THE PLATFORM-ATTESTATION WAIVER LIVES (ADR-0163 D9). On the declared evaluation
 * lane the codesign/spctl/system-extension chain and the Authenticode carrier probe are skipped
 * STRUCTURALLY — never attempted and tolerated on failure — and the qualification is synthesized
 * from the same binding the platform receipt would have had to match.
 *
 * It cannot be routed through `qualificationFromReceipt`: `backendMatchesTarget` forces
 * `macos-endpoint-security` for macOS receipts, and an unsigned build has no Endpoint Security
 * system extension, so a synthetic receipt would have to FORGE a containment claim. The declared
 * backend here is the containment the build actually has — a Job Object on Windows, the app
 * sandbox on macOS.
 *
 * The receipt is computed over the COMPLETE binding, so the activation-manifest digest, both
 * native-helper digests and the sidecar payload digest all stay load-bearing for the runtime
 * identity: a swapped supervisor binary still changes the receipt.
 */
function evaluationQualification(
  candidate: PortableRuntimeCandidate,
  binding: RuntimeQualificationReceiptBinding,
): LongLivedRuntimeQualification {
  const windows = candidate.target === "windows-x64";
  return {
    platform: windows ? "win32" : "darwin",
    arch: candidate.target === "macos-x64" ? "x64" : windows ? "x64" : "arm64",
    backend: windows ? "windows-job-object" : "macos-app-sandbox",
    releaseReceipt: `sha256:${sha256Text(
      JSON.stringify({ lane: "evaluation-unqualified", ...binding }),
    )}`,
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
      : readMacosAttestation(resourceRoot, target),
});

export function readWindowsAttestation(
  resourceRoot: string,
  run: PortableRuntimeCommandRunner = runPortableRuntimeCommand,
): unknown {
  const executable = safeRealFile(
    join(resourceRoot, "runtime", "native", "keiko-runtime-attestation.exe"),
  );
  const launcher = safeRealFile(join(resourceRoot, "Keiko.exe"));
  verifyWindowsSignature(launcher, executable, run);
  const result = run(executable, ["--emit"], {
    env: windowsSystemEnvironment(),
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: MAX_ATTESTATION_BYTES,
  });
  if (result.status !== 0 || result.stderr !== "" || Buffer.byteLength(result.stdout) === 0) {
    throw new Error("runtime-attestation-unavailable");
  }
  return JSON.parse(result.stdout);
}

function verifyWindowsSignature(
  launcher: string,
  executable: string,
  run: PortableRuntimeCommandRunner,
): void {
  if (!windowsPublisherIdentityMatches(launcher, executable, run)) {
    throw new Error("runtime-attestation-signature-invalid");
  }
}

export function readMacosAttestation(
  resourceRoot: string,
  target: Extract<UpdatePortableTarget, "macos-arm64" | "macos-x64">,
  run: PortableRuntimeCommandRunner = runPortableRuntimeCommand,
  expectedTeamIdentifier: string | undefined = macosReleaseTeamIdentifier(),
): unknown {
  const paths = macosRuntimeCodePaths(resourceRoot);
  const teamIdentifier = readMacosTeamIdentifier(paths.appRoot, run);
  if (expectedTeamIdentifier === undefined || teamIdentifier !== expectedTeamIdentifier) {
    throw new Error("runtime-app-seal-invalid");
  }
  const bundleIdentifier = `dev.oscharko.keiko.${target}`;
  runMacosVerifier(
    "/usr/bin/codesign",
    [
      "--verify",
      "--deep",
      "--strict",
      `-R=${macosDeveloperIdRequirement(expectedTeamIdentifier, bundleIdentifier)}`,
      paths.appRoot,
    ],
    run,
  );
  runMacosVerifier("/usr/sbin/spctl", ["--assess", "--type", "execute", paths.appRoot], run);
  verifyMacosNestedCode(paths.manager, macosDeveloperIdRequirement(expectedTeamIdentifier), run);
  verifyMacosNestedCode(
    paths.systemExtension,
    macosDeveloperIdRequirement(expectedTeamIdentifier, MACOS_SYSTEM_EXTENSION_IDENTIFIER),
    run,
  );
  const status = run(paths.manager, ["--status"], {
    env: {},
    timeout: 10_000,
  });
  if (status.status !== 0 || status.stdout.trim() !== "active" || status.stderr !== "") {
    throw new Error("runtime-system-extension-inactive");
  }
  return readRecord(safeRealFile(join(resourceRoot, ...MACOS_RECEIPT_PATH.split("/"))));
}

function macosRuntimeCodePaths(resourceRoot: string): {
  readonly appRoot: string;
  readonly manager: string;
  readonly systemExtension: string;
} {
  const appRoot = safeRealDirectory(dirname(dirname(resourceRoot)));
  return {
    appRoot,
    manager: safeRealFile(join(appRoot, "Contents", "MacOS", "KeikoSystemExtensionManager")),
    systemExtension: safeRealDirectory(
      join(appRoot, "Contents", "Library", "SystemExtensions", MACOS_SYSTEM_EXTENSION_IDENTIFIER),
    ),
  };
}

function readMacosTeamIdentifier(appRoot: string, run: PortableRuntimeCommandRunner): string {
  const result = run("/usr/bin/codesign", ["-d", "--verbose=4", appRoot], {
    env: { PATH: "/usr/bin:/usr/sbin" },
    timeout: 15_000,
  });
  const identifier =
    result.status === 0
      ? macosTeamIdentifierFromOutput(`${result.stdout}\n${result.stderr}`)
      : undefined;
  if (identifier === undefined) throw new Error("runtime-app-seal-invalid");
  return identifier;
}

function verifyMacosNestedCode(
  path: string,
  requirement: string,
  run: PortableRuntimeCommandRunner,
): void {
  runMacosVerifier(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", `-R=${requirement}`, path],
    run,
  );
}

function runMacosVerifier(
  command: string,
  args: readonly string[],
  run: PortableRuntimeCommandRunner,
): void {
  const result = run(command, args, {
    env: { PATH: "/usr/bin:/usr/sbin" },
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error("runtime-app-seal-invalid");
}

function runPortableRuntimeCommand(
  command: string,
  args: readonly string[],
  options: PortableRuntimeCommandOptions,
): PortableRuntimeCommandResult {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer,
    shell: false,
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  });
}

function trustedResourceRoot(input: PortableOpenCodeDiscoveryInput): string | undefined {
  const packageRoot = productionUpdateFacts(input.env).packageRoot;
  const candidate =
    input.installRoot ?? (packageRoot === undefined ? undefined : dirname(packageRoot));
  if (candidate === undefined) return undefined;
  try {
    const root = realpathSync(candidate);
    return statSync(root).isDirectory() ? root : undefined;
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
}

// ONLY a genuinely missing path is an expected absence. ENOTDIR deliberately does NOT belong here:
// it means a path component exists but is the wrong kind (e.g. `.portable` is a regular file), which
// is a malformed installation and must keep reaching the corruption diagnostic (#2843 review).
function isAbsentPathError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function runtimeTarget(platform: NodeJS.Platform, arch: string): UpdatePortableTarget | undefined {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  return undefined;
}

function setupMatches(root: string, target: UpdatePortableTarget): boolean {
  const setup = readSetupMarker(join(root, ".portable", "setup-manifest.json"));
  return setup?.platformTarget === target && setup.stable === true;
}

/**
 * Reads the portable presence marker. An absent marker means no portable installation — the
 * expected state on dev machines — and reports "not installed" silently; a marker that is
 * present but unreadable or malformed (including valid JSON that is not an object, such as `null`
 * or `[]`) still throws so discovery emits its corruption diagnostic (#2843 review).
 */
function readSetupMarker(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
  const parsed = record(JSON.parse(raw));
  if (parsed === undefined) {
    throw new Error("portable setup marker is present but is not a JSON object");
  }
  return parsed;
}

function qualifiedSidecar(
  root: string,
  activation: Record<string, unknown>,
  target: UpdatePortableTarget,
  lane: PortableRuntimeLane,
): PortableSidecarRuntimeVerification | undefined {
  const sidecars = verifyPortableAttestedSidecars(activation, target, lane).sidecars;
  if (sidecars.length !== 1 || sidecars[0]?.summary.name !== "opencode-compatible") {
    return undefined;
  }
  const sidecar = sidecars[0];
  const disk = inspectStagedSidecarPayload(root, sidecar);
  const availability = evaluatePortableSidecarAvailability(sidecar, {
    target,
    platformAttested: lane === "release-qualified",
    ...disk,
  });
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

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
