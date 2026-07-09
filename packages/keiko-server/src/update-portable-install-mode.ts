import { dirname, join, resolve, win32 } from "node:path";
import {
  UPDATE_SESSION_SCHEMA_VERSION,
  type UpdateInstallMode,
  type UpdatePortableInstallSummary,
  type UpdatePortableManagedRootKind,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";

export type PortableManagementMode = "user-local" | "organization-managed" | "machine-managed";

export interface PortableUpdateRuntimeFacts {
  readonly packageRoot?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly management?: PortableManagementMode | undefined;
}

export interface PortableDetectorFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly lstatSync: (path: string) => { isSymbolicLink: () => boolean };
}

type PathApi = Pick<typeof win32, "dirname" | "join" | "resolve">;

type PortableReadResult =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "present"; readonly summary: UpdatePortableInstallSummary };

const REGISTRATION_FILE = "portable-install-state.json";
const SETUP_MANIFEST = "setup-manifest.json";
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TOKEN_LENGTH = 128;
const PORTABLE_TARGETS: readonly UpdatePortableTarget[] = [
  "windows-x64",
  "macos-arm64",
  "macos-x64",
] as const;

function pathApiFor(value: string): PathApi {
  return value.includes("\\") || /^[a-z]:[\\/]/iu.test(value) ? win32 : { dirname, join, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPortableTarget(value: unknown): value is UpdatePortableTarget {
  return typeof value === "string" && (PORTABLE_TARGETS as readonly string[]).includes(value);
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  return /[\0\r\n]/u.test(value) ? undefined : value;
}

function safeSha256(value: unknown): string | undefined {
  return typeof value === "string" && HEX_SHA256.test(value) ? value : undefined;
}

function safeManagedRootKind(value: unknown): UpdatePortableManagedRootKind | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "default" || value.kind === "home-relative" || value.kind === "absolute-local")
    return value.kind;
  return undefined;
}

function isSymlink(path: string, fs: PortableDetectorFs): boolean {
  try {
    return fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
}

function hasSymlinkAncestor(path: string, fs: PortableDetectorFs): boolean {
  let cursor = resolve(path);
  for (;;) {
    if (isSymlink(cursor, fs)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function registrationPath(stateDir: string, fs: PortableDetectorFs): string | undefined {
  if (stateDir.length === 0 || /[\0\r\n]/u.test(stateDir)) return undefined;
  if (hasSymlinkAncestor(stateDir, fs)) return undefined;
  const path = join(stateDir, REGISTRATION_FILE);
  return isSymlink(path, fs) ? undefined : path;
}

function managedSummary(raw: Record<string, unknown>): UpdatePortableInstallSummary | undefined {
  if (raw.status !== "managed" || raw.updateEligible !== true) return undefined;
  if (!isPortableTarget(raw.platformTarget) || typeof raw.stable !== "boolean") return undefined;
  const packageVersion = safeToken(raw.packageVersion);
  if (packageVersion === undefined) return undefined;
  return {
    status: "managed",
    target: raw.platformTarget,
    updateEligible: true,
    packageVersion,
    stable: raw.stable,
    managedRootKind: safeManagedRootKind(raw.managedRootLocator) ?? "unknown",
    setupManifestSha256: safeSha256(raw.setupManifestSha256),
    installRootIdentitySha256: safeSha256(raw.installRootIdentitySha256),
    launcherIdentitySha256: safeSha256(raw.launcherIdentitySha256),
  };
}

function failedSetupSummary(
  raw: Record<string, unknown>,
): UpdatePortableInstallSummary | undefined {
  if (raw.status !== "setup-failed" || raw.updateEligible !== false) return undefined;
  if (!isPortableTarget(raw.platformTarget) || typeof raw.stable !== "boolean") return undefined;
  const packageVersion = safeToken(raw.packageVersion);
  if (packageVersion === undefined) return undefined;
  return {
    status: "setup-failed",
    target: raw.platformTarget,
    updateEligible: false,
    packageVersion,
    stable: raw.stable,
    failureReason: safeToken(raw.failureReason),
  };
}

function summaryFromRegistration(
  raw: Record<string, unknown>,
): UpdatePortableInstallSummary | undefined {
  if (raw.schemaVersion !== 1) return undefined;
  return managedSummary(raw) ?? failedSetupSummary(raw);
}

function readPortableRegistration(
  stateDir: string | undefined,
  fs: PortableDetectorFs,
): PortableReadResult {
  if (stateDir === undefined) return { status: "absent" };
  const path = registrationPath(stateDir, fs);
  if (path === undefined) return { status: "invalid" };
  if (!fs.existsSync(path)) return { status: "absent" };
  const raw = parseJsonObject(fs.readFileSync(path, "utf8"));
  if (raw === undefined) return { status: "invalid" };
  const summary = summaryFromRegistration(raw);
  return summary === undefined ? { status: "invalid" } : { status: "present", summary };
}

function setupManifestPath(packageRoot: string): string {
  const pathApi = pathApiFor(packageRoot);
  return pathApi.join(pathApi.dirname(packageRoot), ".portable", SETUP_MANIFEST);
}

function bootstrapSummaryFromManifest(
  packageRoot: string | undefined,
  fs: PortableDetectorFs,
  packageName: string,
): UpdatePortableInstallSummary | undefined {
  if (packageRoot === undefined) return undefined;
  const manifestPath = setupManifestPath(packageRoot);
  if (!fs.existsSync(manifestPath)) return undefined;
  const raw = parseJsonObject(fs.readFileSync(manifestPath, "utf8"));
  if (raw?.schemaVersion !== 1 || raw.packageName !== packageName) return undefined;
  if (!isPortableTarget(raw.platformTarget) || typeof raw.stable !== "boolean") return undefined;
  const packageVersion = safeToken(raw.packageVersion);
  if (packageVersion === undefined) return undefined;
  return {
    status: "bootstrap",
    target: raw.platformTarget,
    updateEligible: false,
    packageVersion,
    stable: raw.stable,
  };
}

function registrationMatchesManifest(
  registration: UpdatePortableInstallSummary,
  manifest: UpdatePortableInstallSummary,
): boolean {
  return (
    registration.target === manifest.target &&
    registration.packageVersion === manifest.packageVersion &&
    registration.stable === manifest.stable
  );
}

function normalizedPath(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/").toLowerCase();
}

function hasMachineManagedRoot(packageRoot: string | undefined): boolean {
  const normalized = normalizedPath(packageRoot);
  return (
    normalized.startsWith("/applications/keiko.app/") ||
    /^[a-z]:\/program files( \(x86\))?\/keiko\//u.test(normalized) ||
    /^[a-z]:\/programdata\/keiko\//u.test(normalized)
  );
}

function isOrganizationManaged(facts: PortableUpdateRuntimeFacts): boolean {
  return facts.management === "organization-managed" || facts.management === "machine-managed";
}

function manualInstructions(reason: UpdateInstallMode["reason"]): string {
  if (reason === "portable-bootstrap") {
    return "Run the portable setup flow from the Keiko launcher before using in-app updates.";
  }
  if (reason === "portable-it-managed") {
    return "This Keiko install is managed outside the app and is not eligible for self-update.";
  }
  if (reason === "portable-non-stable") {
    return "Only stable portable Keiko releases are eligible for in-app updates.";
  }
  if (reason === "portable-setup-failed") {
    return "Portable setup did not complete. Re-run setup or download the latest Keiko package.";
  }
  return "Portable update eligibility could not be attested. Download the latest Keiko package.";
}

function portableUnsupportedMode(
  packageName: string,
  reason: UpdateInstallMode["reason"],
  portable: UpdatePortableInstallSummary,
): UpdateInstallMode {
  const installKind =
    reason === "portable-setup-failed"
      ? "portable-setup-failed"
      : reason === "portable-it-managed"
        ? "portable-it-managed"
        : reason === "portable-non-stable" && portable.status === "managed"
          ? "portable-managed"
          : "portable-bootstrap";
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    status: "unsupported",
    packageName,
    installKind,
    portable,
    recommendedAction:
      reason === "portable-bootstrap" ? "portable-bootstrap-setup" : "manual-download",
    reason,
    manualInstructions: manualInstructions(reason),
  };
}

function portableSupportedMode(
  packageName: string,
  portable: UpdatePortableInstallSummary,
): UpdateInstallMode {
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    status: "supported",
    packageName,
    installKind: "portable-managed",
    portable,
    recommendedAction: "portable-managed-update",
  };
}

function modeForPortableSummary(
  summary: UpdatePortableInstallSummary,
  facts: PortableUpdateRuntimeFacts,
  packageName: string,
): UpdateInstallMode {
  if (summary.status === "setup-failed") {
    return portableUnsupportedMode(packageName, "portable-setup-failed", summary);
  }
  if (summary.status === "bootstrap") {
    return portableUnsupportedMode(packageName, "portable-bootstrap", summary);
  }
  if (!summary.stable) return portableUnsupportedMode(packageName, "portable-non-stable", summary);
  if (isOrganizationManaged(facts) || hasMachineManagedRoot(facts.packageRoot)) {
    return portableUnsupportedMode(packageName, "portable-it-managed", {
      ...summary,
      status: "it-managed",
      updateEligible: false,
    });
  }
  return portableSupportedMode(packageName, summary);
}

export function portableStateDirFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const stateDir = env.KEIKO_STATE_DIR;
  return stateDir === undefined || stateDir.length === 0 ? undefined : stateDir;
}

export function detectPortableUpdateInstallMode(
  facts: PortableUpdateRuntimeFacts,
  fs: PortableDetectorFs,
  packageName: string,
): UpdateInstallMode | undefined {
  const manifestSummary = bootstrapSummaryFromManifest(facts.packageRoot, fs, packageName);
  const registration = readPortableRegistration(facts.stateDir, fs);
  if (manifestSummary === undefined) return undefined;
  if (registration.status === "invalid") {
    return portableUnsupportedMode(packageName, "portable-registration-invalid", manifestSummary);
  }
  if (registration.status === "absent") {
    return modeForPortableSummary(manifestSummary, facts, packageName);
  }
  if (!registrationMatchesManifest(registration.summary, manifestSummary)) {
    return portableUnsupportedMode(packageName, "portable-registration-invalid", manifestSummary);
  }
  return modeForPortableSummary(registration.summary, facts, packageName);
}
