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
import { basename, dirname, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { windowsLauncher } from "./launcher-platforms.js";
import type { CliIo } from "./runner.js";
import { defaultManagedRoot, type PortableLayout, type PortableTarget } from "./portable-shared.js";

export type ManagedRootMode = "default" | "custom";
export type NativeRegistrationKind = "windows-start-menu" | "macos-user-applications";

interface RegistrationPlan {
  readonly kind: NativeRegistrationKind;
  readonly path: string;
  readonly expectedContent: string | undefined;
  readonly fileMode: number | undefined;
}

interface ManagedInstallScan {
  readonly files: readonly string[];
  readonly directories: readonly string[];
  readonly issues: readonly string[];
}

type ScopeMode = "whole" | "portable-manifest" | "windows-root" | "macos-root" | "macos-contents";

interface Scope {
  readonly mode: ScopeMode;
  readonly rootPath: string;
}

const WINDOWS_REGISTRATION_RE =
  /^@start "" ([A-Za-z0-9_@\-./\\:]+) start --open(?: --port \d+)?\r?\n$/;
const WHOLE_SUBTREE_ALLOWLIST: Readonly<
  Record<Exclude<ScopeMode, "whole" | "portable-manifest">, readonly string[]>
> = {
  "windows-root": ["app", "runtime", "support"],
  "macos-root": [],
  "macos-contents": [
    "MacOS",
    "Resources",
    "_CodeSignature",
    "Frameworks",
    "Helpers",
    "Library",
    "PlugIns",
    "SharedSupport",
  ],
};

function appDataDir(env: EnvSource, home: string): string {
  return env.APPDATA ?? join(home, "AppData", "Roaming");
}

export function windowsStartMenuRegistrationPath(env: EnvSource, home: string): string {
  return join(appDataDir(env, home), "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat");
}

export function parseWindowsStartMenuRegistration(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const match = WINDOWS_REGISTRATION_RE.exec(readFileSync(path, "utf8"));
  return match?.[1];
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
    ? ["macos-user-applications"]
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
          expectedContent: windowsLauncher.generateContent({
            exe: layout.primaryLauncherPath,
            port: undefined,
          }),
          fileMode: windowsLauncher.fileMode,
        }
      : {
          kind,
          path: resolvedDefaultManagedRoot(target, env, home),
          expectedContent: undefined,
          fileMode: undefined,
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

function ensureFileArtifactSafe(plan: RegistrationPlan): "missing" | "managed" {
  if (!existsSync(plan.path)) return "missing";
  const stat = lstatSync(plan.path);
  if (stat.isSymbolicLink()) {
    throw new Error(`portable registration refused symlink at ${plan.path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`portable registration refused unknown artifact at ${plan.path}`);
  }
  if (stat.nlink > 1) {
    throw new Error(`portable registration refused hardlink at ${plan.path}`);
  }
  if (readFileSync(plan.path, "utf8") !== plan.expectedContent) {
    throw new Error(`portable registration refused unknown artifact at ${plan.path}`);
  }
  return "managed";
}

function writeFileArtifact(plan: RegistrationPlan): void {
  if (plan.expectedContent === undefined || plan.fileMode === undefined) return;
  const status = ensureFileArtifactSafe(plan);
  if (status === "managed") return;
  mkdirSync(dirname(plan.path), { recursive: true, mode: 0o755 });
  writeFileSync(plan.path, plan.expectedContent, { encoding: "utf8", mode: plan.fileMode });
  try {
    chmodSync(plan.path, plan.fileMode);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

export function installUserLocalRegistration(
  layout: PortableLayout,
  target: PortableTarget,
  managedRoot: string,
  env: EnvSource,
  home: string,
): void {
  for (const plan of registrationPlans(layout, target, managedRoot, env, home)) {
    writeFileArtifact(plan);
  }
}

function fileRegistrationStatus(plan: RegistrationPlan): "ok" | "missing" | "action-required" {
  try {
    return ensureFileArtifactSafe(plan) === "managed" ? "ok" : "missing";
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
    const status = plan.expectedContent === undefined ? "ok" : fileRegistrationStatus(plan);
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
    if (plan.expectedContent === undefined) continue;
    if (fileRegistrationStatus(plan) === "missing") {
      writeFileArtifact(plan);
      repaired += 1;
    }
  }
  return repaired;
}

function removeVerifiedFileArtifact(plan: RegistrationPlan, dryRun: boolean, io: CliIo): boolean {
  if (!existsSync(plan.path)) return false;
  ensureFileArtifactSafe(plan);
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

function allowedWholeSubtree(scope: Scope, name: string): boolean {
  return (
    scope.mode !== "whole" &&
    scope.mode !== "portable-manifest" &&
    WHOLE_SUBTREE_ALLOWLIST[scope.mode].includes(name)
  );
}

function nextStructuredScope(scope: Scope, name: string, absPath: string): Scope | undefined {
  if (scope.mode === "windows-root" && name === ".portable") {
    return { mode: "portable-manifest", rootPath: absPath };
  }
  if (scope.mode === "macos-root" && name === "Contents") {
    return { mode: "macos-contents", rootPath: absPath };
  }
  return undefined;
}

function allowedFile(scope: Scope, name: string): boolean {
  if (scope.mode === "windows-root") return name === "Keiko.exe";
  if (scope.mode === "portable-manifest") return name === "setup-manifest.json";
  if (scope.mode === "macos-contents") return name === "Info.plist" || name === "PkgInfo";
  return false;
}

function scanWholeTree(
  absPath: string,
  files: string[],
  directories: string[],
  issues: string[],
  root: string,
): void {
  directories.push(absPath);
  for (const name of readdirSync(absPath)) {
    scanNode(join(absPath, name), files, directories, issues, {
      mode: "whole",
      rootPath: root,
    });
  }
}

function scanStructuredTree(
  absPath: string,
  files: string[],
  directories: string[],
  issues: string[],
  scope: Scope,
): void {
  directories.push(absPath);
  for (const name of readdirSync(absPath)) {
    scanNode(join(absPath, name), files, directories, issues, scope);
  }
}

function scanFileNode(
  absPath: string,
  files: string[],
  issues: string[],
  scope: Scope,
  name: string,
): void {
  if (isUnsafeHardlink(absPath)) {
    issues.push(`portable managed install refused hardlink at ${absPath}`);
    return;
  }
  if (scope.mode !== "whole" && !allowedFile(scope, name)) {
    issues.push(topLevelUnknown(absPath.slice(scope.rootPath.length + 1)));
    return;
  }
  files.push(absPath);
}

function scanDirectoryNode(
  absPath: string,
  files: string[],
  directories: string[],
  issues: string[],
  scope: Scope,
  name: string,
): void {
  if (scope.mode === "whole" || allowedWholeSubtree(scope, name)) {
    scanWholeTree(absPath, files, directories, issues, scope.rootPath);
    return;
  }
  const next = nextStructuredScope(scope, name, absPath);
  if (next === undefined) {
    issues.push(topLevelUnknown(absPath.slice(scope.rootPath.length + 1)));
    return;
  }
  scanStructuredTree(absPath, files, directories, issues, next);
}

function scanNode(
  absPath: string,
  files: string[],
  directories: string[],
  issues: string[],
  scope: Scope,
): void {
  const stat = lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    issues.push(`portable managed install refused symlink at ${absPath}`);
    return;
  }
  const name = basename(absPath);
  if (stat.isDirectory()) {
    scanDirectoryNode(absPath, files, directories, issues, scope, name);
    return;
  }
  if (!stat.isFile()) {
    issues.push(`portable managed install refused unsupported filesystem entry at ${absPath}`);
    return;
  }
  scanFileNode(absPath, files, issues, scope, name);
}

export function inspectPortableManagedInstall(layout: PortableLayout): ManagedInstallScan {
  const files: string[] = [];
  const directories: string[] = [];
  const issues: string[] = [];
  const rootScope: Scope =
    layout.rootKind === "windows-root"
      ? { mode: "windows-root", rootPath: layout.installRoot }
      : { mode: "macos-root", rootPath: layout.installRoot };
  scanStructuredTree(layout.installRoot, files, directories, issues, rootScope);
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
    if (plan.expectedContent === undefined) continue;
    removed += removeVerifiedFileArtifact(plan, dryRun, io) ? 1 : 0;
  }
  return removed;
}
