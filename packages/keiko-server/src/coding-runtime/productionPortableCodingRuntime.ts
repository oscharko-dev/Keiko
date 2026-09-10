import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { assertWindowsLocalVolume } from "@oscharko-dev/keiko-security/windows-local-volume";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import type {
  LongLivedRuntimeQualification,
  RuntimeQualificationComponentDigest,
  RuntimeQualificationReceiptBinding,
} from "@oscharko-dev/keiko-contracts/runtime/runtime-qualification";
import { qualificationFromReceipt } from "@oscharko-dev/keiko-sandbox";

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
import { verifyLinuxQualificationBundle } from "./linuxPortableSigstore.js";
import {
  windowsPublisherIdentityMatches,
  windowsSignerIdentity,
  windowsSystemEnvironment,
} from "./windowsPortableAuthenticode.js";
import {
  generationBindingMatchesPackageLayout,
  parseWindowsGenerationBinding,
  portablePackageLayout,
  resolveWindowsGenerationLayout,
  type PortablePackageLayout,
} from "../update-portable-windows-generation.js";

const ACTIVATION_PATH = ".portable/runtime-activation.json";
const QUALIFICATION_RECEIPT_PATH = ".portable/runtime-qualification.json";
const QUALIFICATION_SIGSTORE_BUNDLE_PATH = ".portable/runtime-qualification.sigstore.json";
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_ATTESTATION_BYTES = 65_536;
const MAX_WINDOWS_SETUP_BYTES = 64 * 1024;
const MAX_WINDOWS_LAUNCHER_BYTES = 64 * 1024 * 1024;
const WINDOWS_IDENTITY_READ_CHUNK_BYTES = 64 * 1024;
const WINDOWS_IDENTITY_READ_DEADLINE_MS = 5_000;
const MACOS_SYSTEM_EXTENSION_IDENTIFIER = "com.oscharko.keiko.runtime-monitor.systemextension";
const TARGETS = new Set<UpdatePortableTarget>([
  "linux-x64",
  "windows-x64",
  "macos-arm64",
  "macos-x64",
]);

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
    readonly installRoot: string;
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
  /** Test seam for the lane-downgrade probe; production spawns the real platform verifier. */
  readonly commandRunner?: PortableRuntimeCommandRunner | undefined;
}

interface PortableRuntimeCandidate {
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly target: UpdatePortableTarget;
  readonly activation: Record<string, unknown>;
  readonly activationSha256: string;
  readonly sourceCommitSha: string;
  readonly supervisorSha256: string;
  readonly secureReadSha256: string;
  readonly runtimeComponents?: readonly RuntimeQualificationComponentDigest[];
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly platformAssurance: PortableRuntimeLane;
}

interface TrustedPortableRoots {
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly packageLayout?: PortablePackageLayout | undefined;
}

interface BoundActivation {
  readonly activation: Record<string, unknown>;
  readonly activationPath: string;
  readonly sourceCommitSha: string;
}

interface CandidateRuntimeBindings {
  readonly supervisorSha256: string;
  readonly secureReadSha256: string;
  readonly runtimeComponents?: readonly RuntimeQualificationComponentDigest[];
  readonly sidecar: PortableSidecarRuntimeVerification;
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
  const roots = trustedPortableRoots(input, target);
  if (roots === undefined) return undefined;
  const selectedRoots = setupBoundRoots(roots, target);
  if (selectedRoots === undefined) return undefined;
  const bound = boundActivation(selectedRoots.resourceRoot, target);
  if (bound === undefined) return undefined;
  const platformAssurance = honouredLane(bound.activation, selectedRoots, target, input);
  if (platformAssurance === undefined) return undefined;
  const bindings = candidateRuntimeBindings(
    selectedRoots.resourceRoot,
    bound.activation,
    target,
    platformAssurance,
  );
  if (bindings === undefined) return undefined;
  return {
    ...selectedRoots,
    target,
    activation: bound.activation,
    activationSha256: sha256File(bound.activationPath),
    sourceCommitSha: bound.sourceCommitSha,
    ...bindings,
    platformAssurance,
  };
}

function candidateRuntimeBindings(
  root: string,
  activation: Record<string, unknown>,
  target: UpdatePortableTarget,
  lane: PortableRuntimeLane,
): CandidateRuntimeBindings | undefined {
  const helpers = boundHelperDigests(root, activation, target);
  if (helpers === undefined) return undefined;
  const sidecar = qualifiedSidecar(root, activation, target, lane);
  if (sidecar === undefined) return undefined;
  const runtimeComponents = boundRuntimeComponents(root, activation, target);
  if (target === "linux-x64" && runtimeComponents === undefined) {
    throw new Error("runtime-component-binding-invalid");
  }
  return {
    ...helpers,
    ...(runtimeComponents === undefined ? {} : { runtimeComponents }),
    sidecar,
  };
}

/**
 * The lane this artifact declares, once it is safe to honour. The evaluation lane is refused on an
 * install that carries a release signature — see releaseSignedInstall for why that anchor is the
 * only one an artifact cannot forge from inside itself.
 */
function honouredLane(
  activation: Record<string, unknown>,
  roots: TrustedPortableRoots,
  target: UpdatePortableTarget,
  input: PortableOpenCodeDiscoveryInput,
): PortableRuntimeLane | undefined {
  const declared = artifactDeclaredLane(activation);
  if (declared === undefined) return undefined;
  if (target === "linux-x64" && declared !== "release-qualified") return undefined;
  if (
    declared === "evaluation-unqualified" &&
    releaseSignedInstall(roots.installRoot, roots.resourceRoot, target, input.commandRunner)
  ) {
    return undefined;
  }
  return declared;
}

/**
 * Public form of the release-signature anchor for other launch surfaces. The portable launcher
 * uses it to decide whether platform runtime containment can exist at all: an install that carries
 * no release signature can never load its Endpoint Security extension, so requiring activation
 * there turns an impossible precondition into a permanent silent launch failure. The fail-closed
 * direction is unchanged — a probe that cannot answer reports "signed", which keeps every strict
 * requirement in force.
 */
export function portableInstallCarriesReleaseSignature(
  root: string,
  target: UpdatePortableTarget,
  commandRunner?: PortableRuntimeCommandRunner,
): boolean {
  return releaseSignedInstall(root, root, target, commandRunner);
}

/**
 * Refuses a LANE DOWNGRADE. The evaluation lane is a property of an artifact that was never signed,
 * and honouring it is what turns off `codesign --verify --deep` / the Authenticode publisher match
 * further down. But the declaration lives in `.portable/runtime-activation.json`, inside the
 * resource root — so without this check, anyone able to rewrite that one file could switch off the
 * very seal that would have detected the rewrite, and every surviving predicate would still pass
 * because they are all recomputed against the manifest the attacker now owns.
 *
 * The anchor therefore has to be something the artifact cannot forge from inside itself: the
 * platform's own answer to "is this install signed?". A release-signed macOS bundle reports a real
 * `TeamIdentifier`; an unsigned or ad-hoc one reports `not set` (measured). A release-signed Windows
 * launcher yields a signer thumbprint; an unsigned one yields none. So an unsigned evaluation build
 * is unaffected, and a signed install can never be talked out of its own verification.
 *
 * A probe that cannot answer is treated as "signed" — the fail-closed direction, since the only
 * thing this predicate may do is REFUSE the weaker lane.
 */
function releaseSignedInstall(
  installRoot: string,
  resourceRoot: string,
  target: UpdatePortableTarget,
  commandRunner: PortableRuntimeCommandRunner | undefined,
): boolean {
  // Linux has no platform code-signing seal equivalent to Authenticode or Developer ID. Its
  // production runtime is admitted only through the OIDC-attested qualification lane, so Linux
  // may never self-declare the weaker evaluation lane.
  if (target === "linux-x64") return true;
  const signedCode = releaseSignedCodePath(installRoot, resourceRoot, target);
  // No signable code where a real install always has some: there is no release seal to downgrade
  // FROM, so this is not the attack this predicate guards. Discovery's own checks still apply.
  if (signedCode === undefined) return false;
  try {
    const run = commandRunner ?? runPortableRuntimeCommand;
    if (target === "windows-x64") {
      return (
        windowsSignerIdentity(signedCode, (command, args, options) =>
          run(command, args, { env: options.env, timeout: options.timeout }),
        ) !== undefined
      );
    }
    const result = run("/usr/bin/codesign", ["-d", "--verbose=4", signedCode], {
      env: { PATH: "/usr/bin:/usr/sbin" },
      timeout: 15_000,
    });
    if (result.status !== 0) return false;
    return macosTeamIdentifierFromOutput(`${result.stdout}\n${result.stderr}`) !== undefined;
  } catch {
    // The probe itself failed on code that IS present. Refusing the weaker lane is the only
    // fail-closed direction available here.
    return true;
  }
}

/** The signed artifact for the target, or undefined when the install carries none. */
function releaseSignedCodePath(
  installRoot: string,
  resourceRoot: string,
  target: UpdatePortableTarget,
): string | undefined {
  try {
    return target === "windows-x64"
      ? safeRealFile(join(installRoot, "Keiko.exe"))
      : macosRuntimeCodePaths(resourceRoot).appRoot;
  } catch {
    return undefined;
  }
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
    // This legacy field is consumed as the immutable resource root by the backend and secure-read
    // pipeline. Keep that contract while using candidate.installRoot for root-level authorities.
    installRoot: candidate.resourceRoot,
    target: candidate.target,
    manifest: candidate.activation,
    sidecar: candidate.sidecar,
    qualification,
    nativeHelperPath: helperPath(
      candidate.resourceRoot,
      candidate.target,
      "keiko-runtime-supervisor",
    ),
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
    ...(candidate.runtimeComponents === undefined
      ? {}
      : { runtimeComponents: candidate.runtimeComponents }),
  };
}

function platformQualification(
  candidate: PortableRuntimeCandidate,
  binding: RuntimeQualificationReceiptBinding,
  port: PortableRuntimeAttestationPort | undefined,
): LongLivedRuntimeQualification | undefined {
  const receipt = (port ?? PLATFORM_ATTESTATION).readReceipt({
    installRoot: candidate.installRoot,
    resourceRoot: candidate.resourceRoot,
    target: candidate.target,
  });
  const result = qualificationFromReceipt(receipt, binding);
  if (!result.ok) throw new Error("runtime-qualification-binding-invalid");
  return result.qualification;
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
    // macos-arm64 is the only Apple Silicon target; the other two are x64.
    arch: candidate.target === "macos-arm64" ? "arm64" : "x64",
    backend: windows ? "windows-job-object" : "macos-app-sandbox",
    releaseReceipt: `sha256:${sha256Text(
      JSON.stringify({ lane: "evaluation-unqualified", ...binding }),
    )}`,
  };
}

const PLATFORM_ATTESTATION: PortableRuntimeAttestationPort = Object.freeze({
  readReceipt: ({
    installRoot,
    resourceRoot,
    target,
  }: {
    readonly installRoot: string;
    readonly resourceRoot: string;
    readonly target: UpdatePortableTarget;
  }): unknown => readPlatformAttestation(installRoot, resourceRoot, target),
});

function readPlatformAttestation(
  installRoot: string,
  resourceRoot: string,
  target: UpdatePortableTarget,
): unknown {
  if (target === "windows-x64") {
    return readWindowsAttestation(resourceRoot, runPortableRuntimeCommand, installRoot);
  }
  if (target === "linux-x64") return readLinuxAttestation(resourceRoot);
  return readMacosAttestation(resourceRoot, target);
}

export function readLinuxAttestation(resourceRoot: string): unknown {
  const receiptPath = safeRealFile(join(resourceRoot, ...QUALIFICATION_RECEIPT_PATH.split("/")));
  const bundlePath = safeRealFile(
    join(resourceRoot, ...QUALIFICATION_SIGSTORE_BUNDLE_PATH.split("/")),
  );
  const receipt = readBoundedFile(receiptPath);
  const bundle = JSON.parse(readBoundedFile(bundlePath).toString("utf8")) as unknown;
  verifyLinuxQualificationBundle(receipt, bundle);
  const parsed: unknown = JSON.parse(receipt.toString("utf8"));
  return record(parsed);
}

function readBoundedFile(path: string): Buffer {
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_ATTESTATION_BYTES) {
    throw new Error("runtime-attestation-size-invalid");
  }
  return readFileSync(path);
}

export function readWindowsAttestation(
  resourceRoot: string,
  run: PortableRuntimeCommandRunner = runPortableRuntimeCommand,
  installRoot: string = resourceRoot,
): unknown {
  const executable = safeRealFile(
    join(resourceRoot, "runtime", "native", "keiko-runtime-attestation.exe"),
  );
  const launcher = safeRealFile(join(installRoot, "Keiko.exe"));
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
  return readRecord(safeRealFile(join(resourceRoot, ...QUALIFICATION_RECEIPT_PATH.split("/"))));
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

function trustedPortableRoots(
  input: PortableOpenCodeDiscoveryInput,
  target: UpdatePortableTarget,
): TrustedPortableRoots | undefined {
  const packageLayout =
    input.installRoot === undefined
      ? portablePackageLayout(target, productionUpdateFacts(input.env).packageRoot)
      : undefined;
  if (target === "windows-x64") {
    const lexicalInstallRoot = input.installRoot ?? packageLayout?.installRoot;
    if (lexicalInstallRoot === undefined) return undefined;
    try {
      // This must precede realpathSync: a canonical path is evidence, not locality authority.
      assertWindowsLocalVolume(lexicalInstallRoot);
    } catch {
      return undefined;
    }
  }
  return realPortableRoots(input.installRoot, packageLayout);
}

function realPortableRoots(
  injectedRoot: string | undefined,
  packageLayout: PortablePackageLayout | undefined,
): TrustedPortableRoots | undefined {
  const installCandidate = injectedRoot ?? packageLayout?.installRoot;
  const resourceCandidate = injectedRoot ?? packageLayout?.resourceRoot;
  if (installCandidate === undefined || resourceCandidate === undefined) return undefined;
  try {
    const installRoot = realpathSync(installCandidate);
    const resourceRoot = realpathSync(resourceCandidate);
    if (![installRoot, resourceRoot].every((path) => statSync(path).isDirectory())) {
      return undefined;
    }
    return { installRoot, resourceRoot, packageLayout };
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
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  return undefined;
}

function setupBoundRoots(
  roots: TrustedPortableRoots,
  target: UpdatePortableTarget,
): TrustedPortableRoots | undefined {
  const setupRoot = target === "windows-x64" ? roots.installRoot : roots.resourceRoot;
  const setupPath = join(setupRoot, ".portable", "setup-manifest.json");
  const setup = readSetupForTarget(setupPath, target);
  if (setup?.platformTarget !== target || setup.stable !== true) return undefined;
  if (target !== "windows-x64") return setup.schemaVersion === 1 ? roots : undefined;
  if (setup.schemaVersion === 1) {
    return roots.packageLayout?.kind === "windows-generation-v1" ? undefined : roots;
  }
  return windowsSetupBoundRoots(roots, setup);
}

function readSetupForTarget(
  path: string,
  target: UpdatePortableTarget,
): Record<string, unknown> | undefined {
  return target === "windows-x64" ? readWindowsSetupMarker(path) : readSetupMarker(path);
}

function windowsSetupBoundRoots(
  roots: TrustedPortableRoots,
  setup: Record<string, unknown>,
): TrustedPortableRoots | undefined {
  if (!windowsSetupIdentityValid(setup)) return undefined;
  const binding = parseWindowsGenerationBinding(setup.windowsGeneration);
  if (binding === undefined) return undefined;
  if (
    roots.packageLayout !== undefined &&
    !generationBindingMatchesPackageLayout(binding, roots.packageLayout)
  ) {
    return undefined;
  }
  const generation = resolveWindowsGenerationLayout(roots.installRoot, binding);
  const resourceRoot = existingRealDirectory(generation.resourceRoot);
  if (resourceRoot === undefined) return undefined;
  if (resourceRoot !== roots.resourceRoot && roots.packageLayout !== undefined) return undefined;
  const packageManifest = readRecord(safeRealFile(join(resourceRoot, "app", "package.json")));
  if (!windowsPackageMatchesSetup(packageManifest, setup)) return undefined;
  if (!windowsLauncherMatchesBinding(generation.rootLauncherPath, binding.launcherSha256)) {
    return undefined;
  }
  return { ...roots, resourceRoot };
}

function windowsSetupIdentityValid(setup: Record<string, unknown>): boolean {
  const runtime = record(setup.runtime);
  return [
    setup.schemaVersion === 2,
    setup.packageName === "@oscharko-dev/keiko",
    typeof setup.packageVersion === "string",
    setup.primaryLauncher === "Keiko.exe",
    setup.bootstrapUpdateEligible === false,
    runtime?.nodePlatform === "win32",
    runtime?.nodeArchitecture === "x64",
  ].every(Boolean);
}

function existingRealDirectory(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
}

function windowsPackageMatchesSetup(
  packageManifest: Record<string, unknown> | undefined,
  setup: Record<string, unknown>,
): boolean {
  return [
    packageManifest?.name === setup.packageName,
    packageManifest?.version === setup.packageVersion,
  ].every(Boolean);
}

function windowsLauncherMatchesBinding(path: string, expectedSha256: string): boolean {
  return hashSecureWindowsFile(path, MAX_WINDOWS_LAUNCHER_BYTES) === expectedSha256;
}

function windowsFileIsUnsafe(stat: Stats, maxBytes: number): boolean {
  return !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes;
}

function windowsFileIdentityChanged(before: Stats, after: Stats, total: number): boolean {
  return [
    windowsFileIsUnsafe(after, before.size),
    after.dev !== before.dev,
    after.ino !== before.ino,
    after.size !== before.size,
    after.mtimeMs !== before.mtimeMs,
    after.ctimeMs !== before.ctimeMs,
    total !== before.size,
  ].some(Boolean);
}

function windowsNamedFileChanged(opened: Stats, named: Stats): boolean {
  return [
    windowsFileIsUnsafe(named, opened.size),
    named.dev !== opened.dev,
    named.ino !== opened.ino,
    named.size !== opened.size,
    named.mtimeMs !== opened.mtimeMs,
    named.ctimeMs !== opened.ctimeMs,
  ].some(Boolean);
}

function withSecureWindowsFile<T>(
  path: string,
  maxBytes: number,
  read: (descriptor: number, deadline: number) => { readonly result: T; readonly total: number },
): T {
  const namedBefore = lstatSync(path);
  if (windowsFileIsUnsafe(namedBefore, maxBytes)) {
    throw new Error("portable Windows identity file is unsafe or oversized");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (windowsFileIsUnsafe(opened, maxBytes) || windowsNamedFileChanged(opened, namedBefore)) {
      throw new Error("portable Windows identity path changed before it was read");
    }
    const { result, total } = read(descriptor, Date.now() + WINDOWS_IDENTITY_READ_DEADLINE_MS);
    if (
      windowsFileIdentityChanged(opened, fstatSync(descriptor), total) ||
      windowsNamedFileChanged(opened, lstatSync(path))
    ) {
      throw new Error("portable Windows identity file changed while it was read");
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function readSecureWindowsFile(path: string, maxBytes: number): Buffer {
  return withSecureWindowsFile(path, maxBytes, (descriptor, deadline) => {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error("portable Windows identity read timed out");
      const chunk = Buffer.allocUnsafe(
        Math.min(WINDOWS_IDENTITY_READ_CHUNK_BYTES, maxBytes - total + 1),
      );
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) return { result: Buffer.concat(chunks, total), total };
      total += count;
      if (total > maxBytes) throw new Error("portable Windows identity file is oversized");
      chunks.push(chunk.subarray(0, count));
    }
  });
}

function hashSecureWindowsFile(path: string, maxBytes: number): string {
  return withSecureWindowsFile(path, maxBytes, (descriptor, deadline) => {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(WINDOWS_IDENTITY_READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error("portable Windows identity read timed out");
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) return { result: hash.digest("hex"), total };
      total += count;
      if (total > maxBytes) throw new Error("portable Windows identity file is oversized");
      hash.update(chunk.subarray(0, count));
    }
  });
}

function readWindowsSetupMarker(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      readSecureWindowsFile(path, MAX_WINDOWS_SETUP_BYTES),
    );
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

function boundRuntimeComponents(
  root: string,
  activation: Record<string, unknown>,
  target: UpdatePortableTarget,
): readonly RuntimeQualificationComponentDigest[] | undefined {
  if (target !== "linux-x64") return undefined;
  const launcher = installedFileDigest(root, "Keiko");
  const node = installedFileDigest(root, "runtime/node/bin/node");
  const usearch = boundUsearchDigest(root, activation);
  if (launcher === undefined || node === undefined || usearch === undefined) return undefined;
  return [
    { name: "primary-launcher", sha256: launcher },
    { name: "node-runtime", sha256: node },
    { name: "usearch", sha256: usearch },
  ];
}

function installedFileDigest(root: string, relativePath: string): string | undefined {
  const path = safeRealFile(join(root, ...relativePath.split("/")));
  return statSync(path).size > 0 ? sha256File(path) : undefined;
}

function boundUsearchDigest(root: string, activation: Record<string, unknown>): string | undefined {
  const addons = Array.isArray(activation.nativeAddons) ? activation.nativeAddons : [];
  const matches = addons.map(record).filter((addon) => addon?.name === "usearch");
  if (matches.length !== 1) return undefined;
  const addon = matches[0];
  const expectedSize = addon?.sizeBytes;
  const expectedDigest = stringField(addon, "shippedSha256", DIGEST);
  if (!usearchBindingIsValid(addon, expectedSize, expectedDigest)) return undefined;
  const path = safeRealFile(join(root, "runtime", "native", "usearch.node"));
  const entry = statSync(path);
  return entry.size === expectedSize && sha256File(path) === expectedDigest
    ? expectedDigest
    : undefined;
}

function usearchBindingIsValid(
  addon: Record<string, unknown> | undefined,
  expectedSize: unknown,
  expectedDigest: string | undefined,
): expectedSize is number {
  return (
    addon?.platformTarget === "linux-x64" &&
    addon.executablePath === "runtime/native/usearch.node" &&
    typeof expectedSize === "number" &&
    Number.isSafeInteger(expectedSize) &&
    expectedSize > 0 &&
    expectedDigest !== undefined
  );
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
  if (target === "linux-x64" && name === "keiko-runtime-supervisor") {
    return "app/node_modules/@oscharko-dev/keiko-sandbox/dist/runtime.js";
  }
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
