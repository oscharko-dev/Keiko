import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import {
  UPDATE_SESSION_SCHEMA_VERSION,
  type UpdateCommandPreview,
  type UpdateInstallMode,
  type UpdateInstallPackageManager,
  type UpdateMutationPolicy,
} from "@oscharko-dev/keiko-contracts";
import {
  detectPortableUpdateInstallMode,
  portableStateDirFromEnv,
  type PortableManagementMode,
} from "./update-portable-install-mode.js";

export const PACKAGE_NAME = "@oscharko-dev/keiko";
const DISABLED_ENV = "KEIKO_UPDATE_MUTATION_DISABLED";

export const UPDATE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "npm",
    allowedSubcommands: Object.freeze(["install"]),
    denyFlags: Object.freeze([
      "-c",
      "--call",
      "--prefix",
      "-w",
      "--workspace",
      "--workspaces",
      "--script-shell",
    ]),
  },
  {
    executable: "yarn",
    allowedSubcommands: Object.freeze(["global"]),
    denyFlags: Object.freeze([
      "--cwd",
      "--mutex",
      "--modules-folder",
      "--offline",
      "--proxy",
      "--https-proxy",
    ]),
  },
] as const satisfies readonly CommandRule[]);

type InstallScope = "global" | "local" | "unknown";
type PackageManagerResolution =
  | { readonly status: "ok"; readonly packageManager: UpdateInstallPackageManager }
  | { readonly status: "unsupported" | "ambiguous" | "transient" };
type PathApi = Pick<typeof win32, "dirname" | "join" | "resolve">;

export interface UpdateRuntimeFacts {
  readonly entryPath?: string | undefined;
  readonly launcherPath?: string | undefined;
  readonly packageRoot?: string | undefined;
  readonly packageName?: string | undefined;
  readonly packageManagerHint?: string | undefined;
  readonly installScope?: InstallScope | undefined;
  readonly localCheckout?: boolean | undefined;
  readonly linkedPackage?: boolean | undefined;
  readonly transientRunner?: boolean | undefined;
  readonly launcherDrift?: boolean | undefined;
  readonly portableStateDir?: string | undefined;
  readonly portableManagement?: PortableManagementMode | undefined;
}

interface DetectorFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly realpathSync: (path: string) => string;
  readonly lstatSync: (path: string) => { isSymbolicLink: () => boolean };
}

const nodeDetectorFs: DetectorFs = {
  existsSync,
  readFileSync,
  realpathSync,
  lstatSync,
};
const nativePathApi: PathApi = { dirname, join, resolve };

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function pathApiFor(value: string): PathApi {
  return value.includes("\\") || /^[a-z]:[\\/]/iu.test(value) ? win32 : nativePathApi;
}

function findPackageRoot(
  startPath: string,
  packageName: string,
  fs: DetectorFs,
): string | undefined {
  const pathApi = pathApiFor(startPath);
  let current = pathApi.dirname(pathApi.resolve(startPath));
  for (;;) {
    const manifest = pathApi.join(current, "package.json");
    const record = fs.existsSync(manifest)
      ? parseJsonObject(fs.readFileSync(manifest, "utf8"))
      : undefined;
    if (record?.name === packageName) return current;
    const parent = pathApi.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

export function resolveUpdateMutationPolicy(
  env: NodeJS.ProcessEnv | undefined,
): UpdateMutationPolicy {
  if (isTruthyEnv(env?.[DISABLED_ENV]?.toLowerCase())) {
    return {
      enabled: false,
      source: "environment",
      reason: `${DISABLED_ENV} disables in-app package mutation.`,
    };
  }
  return { enabled: true, source: "default" };
}

function normalizedPath(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/").toLowerCase();
}

function isTransientPath(path: string | undefined): boolean {
  const normalized = normalizedPath(path);
  return (
    normalized.includes("/_npx/") ||
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/.yarn/unplugged/") ||
    normalized.includes("/.yarn/cache/")
  );
}

function isGlobalPackageRoot(root: string | undefined): boolean {
  const normalized = normalizedPath(root);
  return (
    normalized.includes("/lib/node_modules/@oscharko-dev/keiko") ||
    normalized.includes("/npm/node_modules/@oscharko-dev/keiko") ||
    normalized.includes("/.config/yarn/global/node_modules/@oscharko-dev/keiko") ||
    normalized.includes("/.yarn/global/node_modules/@oscharko-dev/keiko") ||
    normalized.includes("/yarn/data/global/node_modules/@oscharko-dev/keiko")
  );
}

function packageManagerHintFromRoot(
  root: string | undefined,
): UpdateInstallPackageManager | undefined {
  const normalized = normalizedPath(root);
  if (
    normalized.includes("/.config/yarn/global/node_modules/@oscharko-dev/keiko") ||
    normalized.includes("/.yarn/global/node_modules/@oscharko-dev/keiko") ||
    normalized.includes("/yarn/data/global/node_modules/@oscharko-dev/keiko")
  ) {
    return "yarn";
  }
  if (
    normalized.includes("/lib/node_modules/@oscharko-dev/keiko") ||
    normalized.includes("/npm/node_modules/@oscharko-dev/keiko")
  ) {
    return "npm";
  }
  return undefined;
}

function isLocalCheckout(root: string | undefined, fs: DetectorFs): boolean {
  if (root === undefined) return false;
  return fs.existsSync(join(root, ".git")) || fs.existsSync(join(root, "tsconfig.packages.json"));
}

function isLinked(root: string | undefined, fs: DetectorFs): boolean {
  if (root === undefined) return false;
  try {
    return fs.lstatSync(root).isSymbolicLink();
  } catch {
    return false;
  }
}

function looksTransientPackageManager(lower: string): boolean {
  return lower === "npx" || lower.includes("npx") || lower.includes("yarn dlx");
}

function looksNpm(lower: string): boolean {
  return lower === "npm" || lower.startsWith("npm/") || lower.includes("npm-cli");
}

function looksYarn(lower: string): boolean {
  return lower === "yarn" || lower.startsWith("yarn/") || lower.includes("yarn");
}

function packageManagerFromToken(value: string | undefined): PackageManagerResolution | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const lower = value.toLowerCase();
  if (looksTransientPackageManager(lower)) return { status: "transient" };
  if (looksNpm(lower)) return { status: "ok", packageManager: "npm" };
  if (looksYarn(lower)) return { status: "ok", packageManager: "yarn" };
  return { status: "unsupported" };
}

function mergePackageManagerHints(
  left: PackageManagerResolution | undefined,
  right: PackageManagerResolution | undefined,
): PackageManagerResolution | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left.status !== "ok" || right.status !== "ok") {
    return left.status === right.status ? left : { status: "ambiguous" };
  }
  return left.packageManager === right.packageManager ? left : { status: "ambiguous" };
}

function resolvePackageManager(
  facts: UpdateRuntimeFacts,
  env: NodeJS.ProcessEnv,
): PackageManagerResolution | undefined {
  let resolved = packageManagerFromToken(facts.packageManagerHint);
  resolved = mergePackageManagerHints(resolved, packageManagerFromToken(env.npm_config_user_agent));
  resolved = mergePackageManagerHints(resolved, packageManagerFromToken(env.npm_execpath));
  if (env.npm_command === "exec") return { status: "transient" };
  return resolved;
}

function inferScope(facts: UpdateRuntimeFacts, env: NodeJS.ProcessEnv): InstallScope {
  if (facts.installScope !== undefined) return facts.installScope;
  if (env.npm_config_global === "true" || env.npm_config_location === "global") return "global";
  if (isGlobalPackageRoot(facts.packageRoot)) return "global";
  return facts.packageRoot === undefined ? "unknown" : "local";
}

function manual(reason: string): string {
  return `Automatic update is unavailable: ${reason}. Use your package manager outside Keiko, then restart Keiko.`;
}

function unsupportedMode(reason: UpdateInstallMode["reason"], message: string): UpdateInstallMode {
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    status: "unsupported",
    packageName: PACKAGE_NAME,
    installKind: "package-manager",
    recommendedAction: "manual-download",
    reason,
    manualInstructions: manual(message),
  };
}

function commandPreview(
  packageManager: UpdateInstallPackageManager,
  targetVersion = "<target-version>",
): UpdateCommandPreview {
  const spec = `${PACKAGE_NAME}@${targetVersion}`;
  const args =
    packageManager === "npm"
      ? ["install", "--global", "--ignore-scripts", spec]
      : ["global", "add", "--ignore-scripts", spec];
  return { executable: packageManager, args, label: `${packageManager} ${args.join(" ")}` };
}

export function buildUpdateCommand(
  packageManager: UpdateInstallPackageManager,
  targetVersion: string,
): UpdateCommandPreview {
  return commandPreview(packageManager, targetVersion);
}

function supportedMode(
  packageManager: UpdateInstallPackageManager,
  installRoot: string,
): UpdateInstallMode {
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    status: "supported",
    packageName: PACKAGE_NAME,
    installKind: "package-manager",
    packageManager,
    installRoot,
    recommendedAction: "package-manager-maintenance",
    commandPreview: commandPreview(packageManager),
  };
}

function modeFromPackageManager(
  resolution: PackageManagerResolution | undefined,
  root: string | undefined,
): UpdateInstallMode | undefined {
  if (resolution === undefined) return undefined;
  if (resolution.status === "ok" && root !== undefined) {
    return supportedMode(resolution.packageManager, root);
  }
  if (resolution.status === "transient") {
    return unsupportedMode("transient-runner", "this launch appears to be transient");
  }
  if (resolution.status === "ambiguous") {
    return unsupportedMode("package-manager-ambiguous", "the package manager is ambiguous");
  }
  return unsupportedMode("package-manager-unsupported", "the package manager is unsupported");
}

interface InstallModeBlocker {
  readonly reason: UpdateInstallMode["reason"];
  readonly message: string;
}

function pathBlocker(facts: UpdateRuntimeFacts): InstallModeBlocker | undefined {
  const root = facts.packageRoot;
  if (root === undefined) return { reason: "unknown-path", message: "the install path is unknown" };
  if (facts.transientRunner === true || isTransientPath(facts.entryPath) || isTransientPath(root)) {
    return { reason: "transient-runner", message: "this launch appears to be transient" };
  }
  if (facts.launcherDrift === true) {
    return { reason: "launcher-drift", message: "the launcher does not match the running package" };
  }
  return undefined;
}

function packageRootBlocker(
  facts: UpdateRuntimeFacts,
  env: NodeJS.ProcessEnv,
  fs: DetectorFs,
): InstallModeBlocker | undefined {
  const root = facts.packageRoot;
  if (facts.linkedPackage === true || isLinked(root, fs)) {
    return { reason: "linked-package", message: "the package appears to be linked" };
  }
  if (facts.localCheckout === true || isLocalCheckout(root, fs)) {
    return { reason: "local-checkout", message: "this is a repository checkout" };
  }
  if (inferScope(facts, env) !== "global") {
    return { reason: "local-install", message: "this is not a deterministic global install" };
  }
  return undefined;
}

function installModeBlocker(
  facts: UpdateRuntimeFacts,
  env: NodeJS.ProcessEnv,
  fs: DetectorFs,
): InstallModeBlocker | undefined {
  return pathBlocker(facts) ?? packageRootBlocker(facts, env, fs);
}

export function detectUpdateInstallMode(
  facts: UpdateRuntimeFacts,
  env: NodeJS.ProcessEnv = {},
  fs: DetectorFs = nodeDetectorFs,
): UpdateInstallMode {
  const portableMode = detectPortableUpdateInstallMode(
    {
      packageRoot: facts.packageRoot,
      stateDir: facts.portableStateDir,
      management: facts.portableManagement,
    },
    fs,
    PACKAGE_NAME,
  );
  if (portableMode !== undefined) return portableMode;
  const blocker = installModeBlocker(facts, env, fs);
  if (blocker !== undefined) return unsupportedMode(blocker.reason, blocker.message);
  return (
    modeFromPackageManager(resolvePackageManager(facts, env), facts.packageRoot) ??
    unsupportedMode("package-manager-ambiguous", "the package manager cannot be determined safely")
  );
}

export function productionUpdateFacts(
  env: NodeJS.ProcessEnv,
  fs: DetectorFs = nodeDetectorFs,
): UpdateRuntimeFacts {
  const entryPath = env.KEIKO_CLI_BIN_PATH ?? process.argv[1] ?? fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(entryPath, PACKAGE_NAME, fs);
  return {
    entryPath,
    packageRoot,
    packageName: PACKAGE_NAME,
    packageManagerHint: packageManagerHintFromRoot(packageRoot),
    portableStateDir: portableStateDirFromEnv(env),
  };
}
