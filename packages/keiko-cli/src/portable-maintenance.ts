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
import { dirname, join, relative, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  WINDOWS_SHORTCUT_MAX_BYTES,
  equivalentWindowsShortcutPath,
  readWindowsShortcutDefinition,
  writeWindowsShortcutDefinition,
} from "@oscharko-dev/keiko-security";
import { parseWindowsLauncherContent, windowsLauncher } from "./launcher-platforms.js";
import type { CliIo } from "./runner.js";
import { defaultManagedRoot, type PortableLayout, type PortableTarget } from "./portable-shared.js";

export type ManagedRootMode = "default" | "custom";
export type NativeRegistrationKind = "windows-start-menu" | "macos-system-applications";

interface RegistrationPlan {
  readonly kind: NativeRegistrationKind;
  readonly path: string;
  readonly artifact: RegistrationArtifact;
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
  return env.APPDATA ?? join(home, "AppData", "Roaming");
}

export function windowsStartMenuRegistrationPath(env: EnvSource, home: string): string {
  return join(appDataDir(env, home), "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk");
}

export function windowsLegacyStartMenuRegistrationPath(env: EnvSource, home: string): string {
  return join(appDataDir(env, home), "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat");
}

export function parseWindowsStartMenuRegistration(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    assertNoSymlinkAncestor(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return undefined;
    if (path.toLowerCase().endsWith(".lnk"))
      return parseWindowsShortcutRegistration(path, stat.size);
    if (stat.size <= 0 || stat.size > WINDOWS_LAUNCHER_MAX_BYTES) return undefined;
    return parseWindowsLauncherContent(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function parseWindowsShortcutRegistration(path: string, size: number): string | undefined {
  if (size <= 0 || size > WINDOWS_SHORTCUT_MAX_BYTES) return undefined;
  const shortcut = readWindowsShortcut(path);
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
        }
      : {
          kind,
          path: resolvedDefaultManagedRoot(target, env, home),
          artifact: { type: "directory" },
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
): "missing" | "managed" {
  const status = ensureRegularUnlinkedArtifact(path, WINDOWS_SHORTCUT_MAX_BYTES);
  if (status === "missing") return "missing";
  const shortcut = readWindowsShortcut(path);
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
    return ensureWindowsShortcutArtifactSafe(plan.path, plan.artifact);
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
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeWindowsShortcutDefinition(path, artifact, process.env, SHORTCUT_FAILURE_PREFIX);
}

function writeRegistrationArtifact(plan: RegistrationPlan): void {
  if (plan.artifact.type === "directory") return;
  const status = ensureRegistrationArtifactSafe(plan);
  if (status === "managed") return;
  if (plan.artifact.type === "windows-shortcut") {
    writeWindowsShortcutArtifact(plan.path, plan.artifact);
  } else {
    writeTextFileArtifact(plan.path, plan.artifact);
  }
  ensureRegistrationArtifactSafe(plan);
}

const SHORTCUT_FAILURE_PREFIX = "portable registration shortcut command failed";

function readWindowsShortcut(path: string): WindowsShortcutRegistrationArtifact | undefined {
  const definition = readWindowsShortcutDefinition(path, process.env, SHORTCUT_FAILURE_PREFIX);
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

function legacyWindowsRegistrationPlan(
  layout: PortableLayout,
  env: EnvSource,
  home: string,
): RegistrationPlan {
  return {
    kind: "windows-start-menu",
    path: windowsLegacyStartMenuRegistrationPath(env, home),
    artifact: {
      type: "text-file",
      expectedContent: windowsLauncher.generateContent({
        exe: layout.primaryLauncherPath,
        port: undefined,
      }),
      fileMode: windowsLauncher.fileMode,
    },
  };
}

function removeLegacyWindowsRegistration(
  layout: PortableLayout,
  env: EnvSource,
  home: string,
  dryRun: boolean,
  io: CliIo,
): boolean {
  const legacyPlan = legacyWindowsRegistrationPlan(layout, env, home);
  try {
    return removeVerifiedFileArtifact(legacyPlan, dryRun, io);
  } catch {
    return false;
  }
}

export function installNativeRegistration(
  layout: PortableLayout,
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
): void {
  for (const plan of registrationPlans(layout, target, managedRoot, env, home)) {
    writeRegistrationArtifact(plan);
    if (plan.artifact.type === "windows-shortcut") {
      // Migration from the pre-.lnk release: once the shortcut registration is verified, a
      // legacy `Keiko.bat` whose content exactly matches the managed launcher contract is
      // retired so users do not keep two Start Menu entries. Foreign or edited files are left
      // untouched (the removal path is content-verified and fails soft).
      removeLegacyWindowsRegistration(layout, env, home, false, silentCliIo());
    }
  }
}

function silentCliIo(): CliIo {
  return { out: () => undefined, err: () => undefined };
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
): {
  readonly ok: number;
  readonly missing: number;
  readonly actionRequired: number;
} {
  let ok = 0;
  let missing = 0;
  let actionRequired = 0;
  for (const plan of registrationPlans(layout, target, managedRoot, env, home)) {
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
): number {
  let repaired = 0;
  for (const plan of registrationPlans(layout, target, managedRoot, env, home)) {
    if (fileRegistrationStatus(plan) === "missing") {
      writeRegistrationArtifact(plan);
      repaired += 1;
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

export function removePortableRegistrationArtifacts(
  layout: PortableLayout,
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
  dryRun: boolean,
  io: CliIo,
): number {
  let removed = 0;
  for (const plan of registrationPlans(layout, target, managedRoot, env, home)) {
    removed += removeVerifiedFileArtifact(plan, dryRun, io) ? 1 : 0;
  }
  if (target === "windows-x64") {
    removed += removeLegacyWindowsRegistration(layout, env, home, dryRun, io) ? 1 : 0;
  }
  return removed;
}
