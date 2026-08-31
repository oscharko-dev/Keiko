import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, win32 as win32Path } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  WINDOWS_SHORTCUT_MAX_BYTES,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
  equivalentWindowsShortcutPath,
  readWindowsShortcutDefinition,
  resolveWindowsPowerShellExecutable,
  type SecurityLogSink,
  writeWindowsShortcutDefinition,
} from "@oscharko-dev/keiko-security";
import {
  parseWindowsLauncherContent,
  type WindowsLauncherParseOptions,
  windowsLauncherContentMatches,
  windowsLauncherNeedsPowerShell,
} from "./launcher-platforms.js";
import type { CliIo } from "./runner.js";
import { emitCliWindowsSystemFailure } from "./security-log.js";
import { defaultManagedRoot, type PortableLayout, type PortableTarget } from "./portable-shared.js";

export type ManagedRootMode = "default" | "custom";
export type NativeRegistrationKind = "windows-start-menu" | "macos-system-applications";

export interface PortableRegistrationOptions {
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly resolveWindowsPowerShell?: ((env: EnvSource) => string) | undefined;
}

export interface PortableRegistrationRemovalInput {
  readonly layout: PortableLayout;
  readonly target: PortableTarget;
  readonly managedRoot: string;
  readonly env: EnvSource;
  readonly home: string;
  readonly dryRun: boolean;
  readonly io: CliIo;
  readonly options?: PortableRegistrationOptions | undefined;
}

interface RegistrationPlan {
  readonly kind: NativeRegistrationKind;
  readonly path: string;
  readonly artifact: RegistrationArtifact;
  // The environment that resolved this plan's path. The Windows shortcut host resolves
  // cscript.exe against the same source, so one operation never mixes two trust inputs.
  readonly env: EnvSource;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

interface TextFileRegistrationArtifact {
  readonly type: "text-file";
  readonly expectedContent: string;
  readonly fileMode: number;
}

interface WindowsShortcutRegistrationArtifact {
  readonly type: "windows-shortcut";
  readonly targetPath: string;
  readonly workingDirectory: string;
  readonly iconPath: string;
}

interface DirectoryRegistrationArtifact {
  readonly type: "directory";
}

type RegistrationArtifact =
  | TextFileRegistrationArtifact
  | WindowsShortcutRegistrationArtifact
  | DirectoryRegistrationArtifact;

interface ManagedInstallScan {
  readonly files: readonly string[];
  readonly directories: readonly string[];
  readonly issues: readonly string[];
}

const MANAGED_INSTALL_RULES: Readonly<
  Record<
    PortableLayout["rootKind"],
    {
      readonly exactFiles: readonly string[];
      readonly recursivePrefixes: readonly string[];
    }
  >
> = {
  "windows-root": {
    exactFiles: [
      "Keiko.exe",
      ".portable/setup-manifest.json",
      "app/package.json",
      "app/release-impact.catalog.json",
      "support/keiko-support.cmd",
    ],
    recursivePrefixes: ["app/dist/", "app/node_modules/", "runtime/node/"],
  },
  "macos-app": {
    exactFiles: [
      "Contents/Info.plist",
      "Contents/PkgInfo",
      "Contents/MacOS/Keiko",
      "Contents/Resources/.portable/setup-manifest.json",
      "Contents/Resources/app/package.json",
      "Contents/Resources/app/release-impact.catalog.json",
    ],
    recursivePrefixes: [
      "Contents/Resources/app/dist/",
      "Contents/Resources/app/node_modules/",
      "Contents/Resources/runtime/node/",
      "Contents/_CodeSignature/",
      "Contents/Frameworks/",
      "Contents/Helpers/",
      "Contents/Library/",
      "Contents/PlugIns/",
      "Contents/SharedSupport/",
    ],
  },
};
const WINDOWS_LAUNCHER_MAX_BYTES = 64 * 1024;

function appDataDir(env: EnvSource, home: string): string {
  // Absolute-only: an empty or relative APPDATA must not re-anchor registration paths at the
  // process working directory — fall back to the canonical profile location instead.
  const configured = env.APPDATA;
  return configured !== undefined && win32Path.isAbsolute(configured)
    ? configured
    : join(home, "AppData", "Roaming");
}

export function windowsStartMenuRegistrationPath(env: EnvSource, home: string): string {
  return join(appDataDir(env, home), "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk");
}

export function windowsLegacyStartMenuRegistrationPath(env: EnvSource, home: string): string {
  return join(appDataDir(env, home), "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat");
}

// A trust-boundary refusal or an unavailable System32 binary must never collapse into the SAME
// "this candidate is absent" signal an ordinary missing/unreadable registration produces below.
// The shared reader emits a body-free, correlation-bound event before this frame sees either typed
// error. Current callers then surface it through their existing nonzero/error path
// (`launchPortable`/`setupPortable`'s own `io.err`, `uninstall.ts`'s top-level catch, and repair's
// action result). Split out so `parseWindowsStartMenuRegistration` stays inside the complexity bar.
function reraiseShortcutHostFailure(error: unknown): undefined {
  if (
    error instanceof WindowsSystemDirectoryError ||
    error instanceof WindowsSystemBinaryMissingError
  ) {
    throw error;
  }
  return undefined;
}

export function parseWindowsStartMenuRegistration(
  path: string,
  env: EnvSource = process.env,
  options?: PortableRegistrationOptions,
): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    assertNoSymlinkAncestor(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return undefined;
    if (path.toLowerCase().endsWith(".lnk"))
      return parseWindowsShortcutRegistration(
        path,
        stat.size,
        env,
        registrationSecurityLogSink(options),
      );
    if (stat.size <= 0 || stat.size > WINDOWS_LAUNCHER_MAX_BYTES) return undefined;
    return parseWindowsLauncherContent(
      readFileSync(path, "utf8"),
      windowsLauncherParseOptions(env, options),
    );
  } catch (error) {
    reraiseShortcutHostFailure(error);
    return undefined;
  }
}

function registrationSecurityLogSink(
  options: PortableRegistrationOptions | undefined,
): SecurityLogSink | undefined {
  return options === undefined ? undefined : options.securityLogSink;
}

function resolveWindowsPowerShell(
  env: EnvSource,
  options: PortableRegistrationOptions | undefined,
): string {
  return options?.resolveWindowsPowerShell?.(env) ?? resolveWindowsPowerShellExecutable(env);
}

function windowsLauncherParseOptions(
  env: EnvSource,
  options: PortableRegistrationOptions | undefined,
): WindowsLauncherParseOptions {
  return { resolveTrustedWindowsPowerShell: () => resolveWindowsPowerShell(env, options) };
}

function parseWindowsShortcutRegistration(
  path: string,
  size: number,
  env: EnvSource,
  securityLogSink?: SecurityLogSink,
): string | undefined {
  if (size <= 0 || size > WINDOWS_SHORTCUT_MAX_BYTES) return undefined;
  const shortcut = readWindowsShortcut(path, env, securityLogSink);
  return shortcut?.targetPath;
}

function resolvedDefaultManagedRoot(target: PortableTarget, env: EnvSource, home: string): string {
  return resolve(defaultManagedRoot(target, env, home));
}

export function portableManagedRootMode(
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
): ManagedRootMode {
  return resolve(managedRoot) === resolvedDefaultManagedRoot(target, env, home)
    ? "default"
    : "custom";
}

export function nativeRegistrationKinds(
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
): readonly NativeRegistrationKind[] {
  if (target === "windows-x64") return ["windows-start-menu"];
  return portableManagedRootMode(target, managedRoot, env, home) === "default"
    ? ["macos-system-applications"]
    : [];
}

function registrationPlans(
  layout: PortableLayout,
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
  options: PortableRegistrationOptions,
): readonly RegistrationPlan[] {
  return nativeRegistrationKinds(target, managedRoot, env, home).map((kind) =>
    kind === "windows-start-menu"
      ? {
          kind,
          path: windowsStartMenuRegistrationPath(env, home),
          artifact: {
            type: "windows-shortcut",
            targetPath: layout.primaryLauncherPath,
            workingDirectory: layout.installRoot,
            iconPath: layout.primaryLauncherPath,
          },
          env,
          securityLogSink: options.securityLogSink,
        }
      : {
          kind,
          path: resolvedDefaultManagedRoot(target, env, home),
          artifact: { type: "directory" },
          env,
          securityLogSink: options.securityLogSink,
        },
  );
}

function isUnsafeHardlink(path: string): boolean {
  try {
    return lstatSync(path).nlink > 1;
  } catch {
    return false;
  }
}

function assertNoSymlinkAncestor(path: string): void {
  let cursor = dirname(resolve(path));
  for (;;) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`portable registration refused symlinked ancestor at ${cursor}`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function ensureTextFileArtifactSafe(
  path: string,
  artifact: TextFileRegistrationArtifact,
): "missing" | "managed" {
  const status = ensureRegularUnlinkedArtifact(path, WINDOWS_LAUNCHER_MAX_BYTES);
  if (status === "missing") return "missing";
  if (readFileSync(path, "utf8") !== artifact.expectedContent) {
    throw new Error(`portable registration refused unknown artifact at ${path}`);
  }
  return "managed";
}

function ensureRegularUnlinkedArtifact(path: string, maxBytes: number): "missing" | "managed" {
  assertNoSymlinkAncestor(path);
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`portable registration refused symlink at ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`portable registration refused unknown artifact at ${path}`);
  }
  if (stat.nlink > 1) {
    throw new Error(`portable registration refused hardlink at ${path}`);
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`portable registration refused unknown artifact at ${path}`);
  }
  return "managed";
}

function ensureWindowsShortcutArtifactSafe(
  path: string,
  artifact: WindowsShortcutRegistrationArtifact,
  env: EnvSource,
  securityLogSink?: SecurityLogSink,
): "missing" | "managed" {
  const status = ensureRegularUnlinkedArtifact(path, WINDOWS_SHORTCUT_MAX_BYTES);
  if (status === "missing") return "missing";
  const shortcut = readWindowsShortcut(path, env, securityLogSink);
  if (shortcut === undefined || !windowsShortcutMatches(shortcut, artifact)) {
    throw new Error(`portable registration refused unknown artifact at ${path}`);
  }
  return "managed";
}

function ensureDirectoryArtifactSafe(path: string): "missing" | "managed" {
  assertNoSymlinkAncestor(path);
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`portable registration refused symlink at ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`portable registration refused unknown artifact at ${path}`);
  }
  return "managed";
}

function ensureRegistrationArtifactSafe(plan: RegistrationPlan): "missing" | "managed" {
  if (plan.artifact.type === "directory") return ensureDirectoryArtifactSafe(plan.path);
  if (plan.artifact.type === "windows-shortcut") {
    return ensureWindowsShortcutArtifactSafe(
      plan.path,
      plan.artifact,
      plan.env,
      plan.securityLogSink,
    );
  }
  return ensureTextFileArtifactSafe(plan.path, plan.artifact);
}

function writeTextFileArtifact(path: string, artifact: TextFileRegistrationArtifact): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, artifact.expectedContent, {
    encoding: "utf8",
    mode: artifact.fileMode,
  });
  try {
    chmodSync(path, artifact.fileMode);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

function writeWindowsShortcutArtifact(
  path: string,
  artifact: WindowsShortcutRegistrationArtifact,
  env: EnvSource,
  securityLogSink?: SecurityLogSink,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeWindowsShortcutDefinition(path, artifact, env, SHORTCUT_FAILURE_PREFIX, {
    sink: securityLogSink,
  });
}

function writeRegistrationArtifact(plan: RegistrationPlan): void {
  if (plan.artifact.type === "directory") {
    // The directory registration artifact is the managed-root anchor itself: repairing a
    // missing registration recreates the anchor directory (contents are the setup flow's job).
    if (ensureRegistrationArtifactSafe(plan) === "missing") {
      mkdirSync(plan.path, { recursive: true, mode: 0o755 });
    }
    return;
  }
  const status = ensureRegistrationArtifactSafe(plan);
  if (status === "managed") return;
  if (plan.artifact.type === "windows-shortcut") {
    writeWindowsShortcutArtifact(plan.path, plan.artifact, plan.env, plan.securityLogSink);
  } else {
    writeTextFileArtifact(plan.path, plan.artifact);
  }
  ensureRegistrationArtifactSafe(plan);
}

const SHORTCUT_FAILURE_PREFIX = "portable registration shortcut command failed";

function readWindowsShortcut(
  path: string,
  env: EnvSource,
  securityLogSink?: SecurityLogSink,
): WindowsShortcutRegistrationArtifact | undefined {
  const definition = readWindowsShortcutDefinition(path, env, SHORTCUT_FAILURE_PREFIX, {
    sink: securityLogSink,
  });
  return definition === undefined ? undefined : { type: "windows-shortcut", ...definition };
}

function windowsShortcutMatches(
  actual: WindowsShortcutRegistrationArtifact,
  expected: WindowsShortcutRegistrationArtifact,
): boolean {
  return (
    equivalentWindowsShortcutPath(actual.targetPath, expected.targetPath) &&
    equivalentWindowsShortcutPath(actual.workingDirectory, expected.workingDirectory)
  );
}

function legacyWindowsParseOptions(
  layout: PortableLayout,
  env: EnvSource,
  options: PortableRegistrationOptions,
): WindowsLauncherParseOptions | undefined {
  if (!windowsLauncherNeedsPowerShell(layout.primaryLauncherPath)) return undefined;
  const trustedPowerShell = resolveWindowsPowerShell(env, options);
  return { resolveTrustedWindowsPowerShell: () => trustedPowerShell };
}

function removeManagedLegacyWindowsLauncher(
  path: string,
  executablePath: string,
  parseOptions: WindowsLauncherParseOptions | undefined,
  dryRun: boolean,
  io: CliIo,
): boolean {
  const status = ensureRegularUnlinkedArtifact(path, WINDOWS_LAUNCHER_MAX_BYTES);
  if (status === "missing") return false;
  const content = readFileSync(path, "utf8");
  if (
    !windowsLauncherContentMatches(content, { exe: executablePath, port: undefined }, parseOptions)
  ) {
    throw new Error(`portable registration refused unknown artifact at ${path}`);
  }
  if (dryRun) {
    io.out(`would-remove: ${path}\n`);
    return true;
  }
  unlinkSync(path);
  io.out(`removed: ${path}\n`);
  return true;
}

function removeLegacyWindowsRegistration(
  layout: PortableLayout,
  env: EnvSource,
  home: string,
  dryRun: boolean,
  io: CliIo,
  options: PortableRegistrationOptions,
): boolean {
  try {
    const parseOptions = legacyWindowsParseOptions(layout, env, options);
    return removeManagedLegacyWindowsLauncher(
      windowsLegacyStartMenuRegistrationPath(env, home),
      layout.primaryLauncherPath,
      parseOptions,
      dryRun,
      io,
    );
  } catch (error) {
    const systemFailure = emitCliWindowsSystemFailure(
      error,
      options.securityLogSink,
      "legacy-start-menu-cleanup",
    );
    const refusalReason = error instanceof Error ? error.message : "removal was refused";
    io.err(
      systemFailure
        ? "keiko portable: legacy Start Menu launcher was left in place because the trusted Windows launch helper is unavailable.\n"
        : `keiko portable: legacy Start Menu launcher was left in place: ${refusalReason}\n`,
    );
    return false;
  }
}

export function installNativeRegistration(
  layout: PortableLayout,
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
  io: CliIo,
  options: PortableRegistrationOptions = {},
): void {
  for (const plan of registrationPlans(layout, target, managedRoot, env, home, options)) {
    writeRegistrationArtifact(plan);
    if (plan.artifact.type === "windows-shortcut") {
      // Migration from the pre-.lnk release: once the shortcut registration is verified, a
      // legacy `Keiko.bat` whose content exactly matches the managed launcher contract is
      // retired so users do not keep two Start Menu entries. Foreign or edited files are left
      // untouched (the removal path is content-verified and fails soft, reporting the refusal
      // through the installing CLI's own io).
      removeLegacyWindowsRegistration(layout, env, home, false, io, options);
    }
  }
}

function fileRegistrationStatus(plan: RegistrationPlan): "ok" | "missing" | "action-required" {
  try {
    return ensureRegistrationArtifactSafe(plan) === "managed" ? "ok" : "missing";
  } catch {
    return "action-required";
  }
}

export function portableRegistrationHealth(
  layout: PortableLayout,
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
  options: PortableRegistrationOptions = {},
): {
  readonly ok: number;
  readonly missing: number;
  readonly actionRequired: number;
} {
  let ok = 0;
  let missing = 0;
  let actionRequired = 0;
  for (const plan of registrationPlans(layout, target, managedRoot, env, home, options)) {
    const status = fileRegistrationStatus(plan);
    if (status === "ok") ok += 1;
    else if (status === "missing") missing += 1;
    else actionRequired += 1;
  }
  return { ok, missing, actionRequired };
}

export function repairUserLocalRegistration(
  layout: PortableLayout,
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
  io: CliIo,
  options: PortableRegistrationOptions = {},
): number {
  let repaired = 0;
  for (const plan of registrationPlans(layout, target, managedRoot, env, home, options)) {
    if (fileRegistrationStatus(plan) === "missing") {
      writeRegistrationArtifact(plan);
      repaired += 1;
    }
    // Same migration as setup: once the shortcut registration verifies, a legacy `Keiko.bat`
    // whose content exactly matches the managed launcher contract is retired — a repair that
    // recreates the `.lnk` must not leave the user with two Start Menu entries.
    if (plan.artifact.type === "windows-shortcut" && fileRegistrationStatus(plan) === "ok") {
      removeLegacyWindowsRegistration(layout, env, home, false, io, options);
    }
  }
  return repaired;
}

function removeVerifiedFileArtifact(plan: RegistrationPlan, dryRun: boolean, io: CliIo): boolean {
  if (plan.artifact.type === "directory") return false;
  const status = ensureRegistrationArtifactSafe(plan);
  if (status === "missing") return false;
  if (dryRun) {
    io.out(`would-remove: ${plan.path}\n`);
    return true;
  }
  unlinkSync(plan.path);
  io.out(`removed: ${plan.path}\n`);
  return true;
}

function topLevelUnknown(relPath: string): string {
  return `portable managed install contains unknown entry: ${relPath}`;
}

function normalizedRelativePath(root: string, absPath: string): string {
  return relative(root, absPath).replaceAll("\\", "/");
}

function pathMatchesRecursivePrefix(path: string, prefix: string): boolean {
  return path.startsWith(prefix);
}

function allowlistedDirectory(relPath: string, layout: PortableLayout): boolean {
  const rules = MANAGED_INSTALL_RULES[layout.rootKind];
  return (
    rules.exactFiles.some((path) => path.startsWith(`${relPath}/`)) ||
    rules.recursivePrefixes.some(
      (prefix) =>
        prefix === `${relPath}/` || prefix.startsWith(`${relPath}/`) || relPath.startsWith(prefix),
    )
  );
}

function allowlistedFile(relPath: string, layout: PortableLayout): boolean {
  const rules = MANAGED_INSTALL_RULES[layout.rootKind];
  return (
    rules.exactFiles.includes(relPath) ||
    rules.recursivePrefixes.some((prefix) => pathMatchesRecursivePrefix(relPath, prefix))
  );
}

function scanManagedTree(
  absPath: string,
  layout: PortableLayout,
  files: string[],
  directories: string[],
  issues: string[],
): void {
  directories.push(absPath);
  for (const name of readdirSync(absPath)) {
    const entryPath = join(absPath, name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      issues.push(`portable managed install refused symlink at ${entryPath}`);
      continue;
    }
    const relPath = normalizedRelativePath(layout.installRoot, entryPath);
    if (stat.isDirectory()) {
      if (!allowlistedDirectory(relPath, layout)) {
        issues.push(topLevelUnknown(relPath));
        continue;
      }
      scanManagedTree(entryPath, layout, files, directories, issues);
      continue;
    }
    if (!stat.isFile()) {
      issues.push(`portable managed install refused unsupported filesystem entry at ${entryPath}`);
      continue;
    }
    if (isUnsafeHardlink(entryPath)) {
      issues.push(`portable managed install refused hardlink at ${entryPath}`);
      continue;
    }
    if (!allowlistedFile(relPath, layout)) {
      issues.push(topLevelUnknown(relPath));
      continue;
    }
    files.push(entryPath);
  }
}

export function inspectPortableManagedInstall(layout: PortableLayout): ManagedInstallScan {
  const files: string[] = [];
  const directories: string[] = [];
  const issues: string[] = [];
  scanManagedTree(layout.installRoot, layout, files, directories, issues);
  return { files, directories, issues };
}

export function portableManagedInstallHealth(layout: PortableLayout): {
  readonly issueCount: number;
} {
  return { issueCount: inspectPortableManagedInstall(layout).issues.length };
}

export function removePortableManagedInstall(
  layout: PortableLayout,
  io: CliIo,
  dryRun: boolean,
): void {
  const scan = inspectPortableManagedInstall(layout);
  if (scan.issues.length > 0) {
    throw new Error(scan.issues[0]);
  }
  for (const file of scan.files) {
    if (dryRun) {
      io.out(`would-remove: ${file}\n`);
      continue;
    }
    unlinkSync(file);
    io.out(`removed: ${file}\n`);
  }
  for (const directory of [...scan.directories].reverse()) {
    if (dryRun) {
      io.out(`would-remove: ${directory}\n`);
      continue;
    }
    rmdirSync(directory);
    io.out(`removed: ${directory}\n`);
  }
}

export function removePortableRegistrationArtifacts({
  layout,
  target,
  managedRoot,
  env,
  home,
  dryRun,
  io,
  options = {},
}: PortableRegistrationRemovalInput): number {
  let removed = 0;
  for (const plan of registrationPlans(layout, target, managedRoot, env, home, options)) {
    removed += removeVerifiedFileArtifact(plan, dryRun, io) ? 1 : 0;
  }
  if (target === "windows-x64") {
    removed += removeLegacyWindowsRegistration(layout, env, home, dryRun, io, options) ? 1 : 0;
  }
  return removed;
}
