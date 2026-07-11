// Local runtime capability detector (Issue #1385, Epic #1491). This module is metadata-only:
// production detection never spawns host executables, never reads Git config, never calls package
// managers, and never talks to container daemons. It reports coarse, content-free capability states
// so editor/runtime epics can degrade gracefully without duplicating tool discovery.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, parse, relative, resolve } from "node:path";
import {
  RUNTIME_CAPABILITY_SCHEMA_VERSION,
  type RuntimeCapabilitiesResponse,
  type RuntimeCapability,
  type RuntimeCapabilityKind,
  type RuntimeCapabilityState,
  type RuntimeCapabilityUnavailableReason,
  type RuntimeCommandKind,
  type RuntimeCommandSource,
} from "@oscharko-dev/keiko-contracts";
import { readWorkspaceFile, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { isWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

export const DEFAULT_RUNTIME_CAPABILITY_DEADLINE_MS = 250 as const;
const PACKAGE_READ_BYTES = 262_144;
const HOST_EXECUTABLE_PROBE_CACHE_TTL_MS = 60_000;

type CapabilityWithoutState = Omit<RuntimeCapability, "state" | "unavailableReason">;

export interface HostExecutableSpec {
  readonly id: string;
  readonly kind: Exclude<RuntimeCapabilityKind, "command-source">;
  readonly executable: string;
  readonly label: string;
  readonly remediationHint: string;
}

export interface HostExecutableProbeResult {
  readonly state: RuntimeCapabilityState;
  readonly unavailableReason?: RuntimeCapabilityUnavailableReason | undefined;
  readonly version?: string | undefined;
}

export interface HostExecutableProbe {
  probe(executable: string, workspaceRoot: string | undefined): HostExecutableProbeResult;
}

export interface RuntimeCapabilityDetectorOptions {
  readonly workspace?: WorkspaceInfo | undefined;
  readonly fs?: WorkspaceFs | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => number) | undefined;
  readonly deadlineMs?: number | undefined;
  readonly probe?: HostExecutableProbe | undefined;
  readonly specs?: readonly HostExecutableSpec[] | undefined;
}

export const RUNTIME_HOST_EXECUTABLE_SPECS: readonly HostExecutableSpec[] = Object.freeze([
  {
    id: "git",
    kind: "git",
    executable: "git",
    label: "Git",
    remediationHint: "Install Git or make it available on PATH.",
  },
  {
    id: "node",
    kind: "node",
    executable: "node",
    label: "Node.js",
    remediationHint: "Install Node.js or make it available on PATH.",
  },
  {
    id: "npm",
    kind: "package-manager",
    executable: "npm",
    label: "npm",
    remediationHint: "Install npm with Node.js or make it available on PATH.",
  },
  {
    id: "pnpm",
    kind: "package-manager",
    executable: "pnpm",
    label: "pnpm",
    remediationHint: "Install pnpm or make it available on PATH.",
  },
  {
    id: "yarn",
    kind: "package-manager",
    executable: "yarn",
    label: "Yarn",
    remediationHint: "Install Yarn or make it available on PATH.",
  },
  {
    id: "python",
    kind: "language-toolchain",
    executable: "python3",
    label: "Python",
    remediationHint: "Install Python or make python3 available on PATH.",
  },
  {
    id: "java",
    kind: "language-toolchain",
    executable: "java",
    label: "Java",
    remediationHint: "Install a JDK/JRE or make java available on PATH.",
  },
  {
    id: "go",
    kind: "language-toolchain",
    executable: "go",
    label: "Go",
    remediationHint: "Install Go or make go available on PATH.",
  },
  {
    id: "rust",
    kind: "language-toolchain",
    executable: "rustc",
    label: "Rust",
    remediationHint: "Install Rust or make rustc available on PATH.",
  },
  {
    id: "cargo",
    kind: "language-toolchain",
    executable: "cargo",
    label: "Cargo",
    remediationHint: "Install Cargo or make cargo available on PATH.",
  },
  {
    id: "shellcheck",
    kind: "language-toolchain",
    executable: "shellcheck",
    label: "ShellCheck",
    remediationHint: "Install ShellCheck or make shellcheck available on PATH.",
  },
  {
    id: "docker",
    kind: "container-engine",
    executable: "docker",
    label: "Docker",
    remediationHint: "Install Docker or make docker available on PATH.",
  },
  {
    id: "podman",
    kind: "container-engine",
    executable: "podman",
    label: "Podman",
    remediationHint: "Install Podman or make podman available on PATH.",
  },
]);

function hasUnsafeExecutableName(name: string): boolean {
  return (
    name.length === 0 ||
    name.includes("\u0000") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes(" ")
  );
}

function executableExtensions(
  platform: NodeJS.Platform,
  pathext: string | undefined,
): readonly string[] {
  if (platform !== "win32") {
    return [""];
  }
  return (pathext ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((value) => value.length > 0);
}

function writableByGroupOrOther(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

function trustedPath(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return true;
  }
  const file = statSync(candidate);
  if (!file.isFile() || writableByGroupOrOther(file.mode)) {
    return false;
  }
  const root = parse(candidate).root;
  let current = dirname(candidate);
  for (;;) {
    const info = statSync(current);
    if (!info.isDirectory() || writableByGroupOrOther(info.mode)) {
      return false;
    }
    if (current === root) {
      return true;
    }
    current = dirname(current);
  }
}

function insideWorkspace(
  candidate: string,
  workspaceRoot: string | undefined,
  realCandidate: string,
): boolean {
  if (workspaceRoot === undefined) {
    return false;
  }
  let realRoot = workspaceRoot;
  try {
    realRoot = nodeWorkspaceFs.realPath(workspaceRoot);
  } catch {
    // Fall back to lexical root; missing roots are handled by the route before detector entry.
  }
  return isWithinWorkspace(workspaceRoot, candidate) || isWithinWorkspace(realRoot, realCandidate);
}

interface CandidateProbeOutcome {
  readonly found: boolean;
  readonly unsafePath: boolean;
  readonly permissionDenied: boolean;
}

function candidateProbeOutcome(
  candidate: string,
  workspaceRoot: string | undefined,
  platform: NodeJS.Platform,
): CandidateProbeOutcome {
  try {
    accessSync(candidate, constants.X_OK);
    const realCandidate = nodeWorkspaceFs.realPath(candidate);
    if (
      insideWorkspace(candidate, workspaceRoot, realCandidate) ||
      !trustedPath(candidate, platform)
    ) {
      return { found: false, unsafePath: true, permissionDenied: false };
    }
    return { found: true, unsafePath: false, permissionDenied: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      found: false,
      unsafePath: false,
      permissionDenied: code === "EACCES" || code === "EPERM",
    };
  }
}

function unavailableProbeResult(
  sawUnsafePath: boolean,
  sawPermissionDenied: boolean,
): HostExecutableProbeResult {
  if (sawUnsafePath) {
    return { state: "policy-blocked", unavailableReason: "unsafe-path" };
  }
  if (sawPermissionDenied) {
    return { state: "permission-denied", unavailableReason: "executable-not-runnable" };
  }
  return { state: "missing", unavailableReason: "executable-not-found" };
}

export class PathHostExecutableProbe implements HostExecutableProbe {
  private static readonly resultCache = new Map<
    string,
    { readonly expiresAt: number; readonly result: HostExecutableProbeResult }
  >();

  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  public constructor(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.env = env;
    this.platform = platform;
  }

  // eslint-disable-next-line complexity
  public probe(executable: string, workspaceRoot: string | undefined): HostExecutableProbeResult {
    if (hasUnsafeExecutableName(executable)) {
      return { state: "policy-blocked", unavailableReason: "policy-blocked" };
    }
    const cacheKey = [
      this.platform,
      this.env.PATH ?? "",
      this.env.PATHEXT ?? "",
      workspaceRoot ?? "",
      executable,
    ].join("\0");
    const now = Date.now();
    const cached = PathHostExecutableProbe.resultCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }
    const pathValue = this.env.PATH ?? "";
    const extensions = executableExtensions(this.platform, this.env.PATHEXT);
    let sawPermissionDenied = false;
    let sawUnsafePath = false;
    let result: HostExecutableProbeResult | undefined;
    for (const dir of pathValue.split(delimiter).filter(Boolean)) {
      for (const ext of extensions) {
        const candidate = resolve(resolve(dir), executable + ext);
        const outcome = candidateProbeOutcome(candidate, workspaceRoot, this.platform);
        if (outcome.found) {
          result = { state: "available" };
          break;
        }
        sawUnsafePath ||= outcome.unsafePath;
        sawPermissionDenied ||= outcome.permissionDenied;
      }
      if (result !== undefined) break;
    }
    result ??= unavailableProbeResult(sawUnsafePath, sawPermissionDenied);
    PathHostExecutableProbe.resultCache.set(cacheKey, {
      expiresAt: now + HOST_EXECUTABLE_PROBE_CACHE_TTL_MS,
      result,
    });
    return result;
  }
}

function capabilityFromProbe(
  spec: HostExecutableSpec,
  result: HostExecutableProbeResult,
): RuntimeCapability {
  const base: CapabilityWithoutState = {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    ...(result.version === undefined ? {} : { version: result.version }),
    ...(result.state === "available" ? {} : { remediationHint: spec.remediationHint }),
  };
  return {
    ...base,
    state: result.state,
    ...(result.unavailableReason === undefined
      ? {}
      : { unavailableReason: result.unavailableReason }),
  };
}

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

function readPackageJson(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): Record<string, unknown> | undefined {
  try {
    return parseJsonObject(
      readWorkspaceFile(workspace, "package.json", { maxBytes: PACKAGE_READ_BYTES }, fs).text,
    );
  } catch {
    return undefined;
  }
}

function packageManagerFromPackageJson(
  record: Record<string, unknown> | undefined,
): string | undefined {
  const value = record?.packageManager;
  if (typeof value !== "string" || value.length === 0 || value.length > 80) {
    return undefined;
  }
  return value.split("@", 1)[0];
}

function scriptNames(record: Record<string, unknown> | undefined): readonly string[] {
  const scripts = record?.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return [];
  }
  return Object.entries(scripts)
    .filter(([, value]) => typeof value === "string")
    .map(([name]) => name)
    .filter((name) => name.length > 0 && name.length <= 120)
    .sort((a, b) => a.localeCompare(b));
}

function isLifecycleWrapper(lowerName: string, needle: string): boolean {
  return (
    lowerName === `pre${needle}` ||
    lowerName === `post${needle}` ||
    lowerName.startsWith(`pre${needle}:`) ||
    lowerName.startsWith(`post${needle}:`)
  );
}

function pickScript(
  names: readonly string[],
  exact: readonly string[],
  contains: readonly string[],
): string | undefined {
  for (const name of names) {
    if (exact.includes(name.toLowerCase())) {
      return name;
    }
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (
      contains.some((needle) => lower.includes(needle)) &&
      !contains.some((needle) => isLifecycleWrapper(lower, needle))
    ) {
      return name;
    }
  }
  return undefined;
}

function packageScriptSources(
  record: Record<string, unknown> | undefined,
): readonly RuntimeCommandSource[] {
  const names = scriptNames(record);
  const packageManager = packageManagerFromPackageJson(record);
  const mapping: Readonly<Record<RuntimeCommandKind, string | undefined>> = {
    test: pickScript(names, ["test"], ["test"]),
    build: pickScript(names, ["build"], ["build"]),
    lint: pickScript(names, ["lint"], ["lint", "eslint"]),
    typecheck: pickScript(names, ["typecheck", "type-check", "tsc"], ["typecheck", "type-check"]),
  };
  return Object.entries(mapping)
    .filter((entry): entry is [RuntimeCommandKind, string] => entry[1] !== undefined)
    .map(([commandKind, scriptName]) => ({
      type: "package-json-script",
      path: "package.json",
      commandKind,
      scriptName,
      ...(packageManager === undefined ? {} : { packageManager }),
    }));
}

function commandSourceCapability(source: RuntimeCommandSource): RuntimeCapability {
  const label =
    source.commandKind === undefined
      ? "Command source"
      : `${source.commandKind[0]?.toUpperCase() ?? ""}${source.commandKind.slice(1)} command source`;
  return {
    id: `command-source:${source.path}:${source.commandKind ?? source.scriptName ?? "manifest"}`,
    kind: "command-source",
    label,
    state: "available",
    source,
  };
}

function packageManifestCapability(record: Record<string, unknown> | undefined): RuntimeCapability {
  if (record === undefined) {
    return {
      id: "manifest:package-json",
      kind: "command-source",
      label: "package.json command source",
      state: "missing",
      unavailableReason: "manifest-not-found",
      remediationHint: "Add package.json when Node package scripts should be discoverable.",
      source: { type: "package-json-script", path: "package.json" },
    };
  }
  return {
    id: "manifest:package-json",
    kind: "command-source",
    label: "package.json command source",
    state: "available",
    source: { type: "package-json-script", path: "package.json" },
  };
}

function relativeWorkspacePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split("\\").join("/");
}

function addManifestCapability(
  capabilities: RuntimeCapability[],
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  path: string,
  label: string,
): void {
  const absolute = resolve(workspace.root, path);
  try {
    if (fs.exists(absolute) && fs.stat(absolute).isFile) {
      capabilities.push({
        id: `manifest:${path}`,
        kind: "command-source",
        label,
        state: "available",
        source: {
          type:
            path.endsWith(".lock") || path.endsWith("lockfile") ? "lockfile" : "ecosystem-manifest",
          path: relativeWorkspacePath(workspace.root, absolute),
        },
      });
    }
  } catch {
    // Manifest discovery is best-effort and never blocks the endpoint.
  }
}

function workspaceCapabilities(
  workspace: WorkspaceInfo | undefined,
  fs: WorkspaceFs,
): readonly RuntimeCapability[] {
  if (workspace === undefined) {
    return [];
  }
  const capabilities: RuntimeCapability[] = [];
  const packageJson = readPackageJson(workspace, fs);
  capabilities.push(packageManifestCapability(packageJson));
  for (const source of packageScriptSources(packageJson)) {
    capabilities.push(commandSourceCapability(source));
  }
  if (packageJson !== undefined && typeof packageJson.packageManager === "string") {
    capabilities.push({
      id: "manifest:package-manager",
      kind: "command-source",
      label: "package manager declaration",
      state: "available",
      source: { type: "ecosystem-manifest", path: "package.json" },
    });
  }
  addManifestCapability(capabilities, workspace, fs, "pnpm-lock.yaml", "pnpm lockfile");
  addManifestCapability(capabilities, workspace, fs, "yarn.lock", "Yarn lockfile");
  addManifestCapability(capabilities, workspace, fs, "package-lock.json", "npm lockfile");
  addManifestCapability(capabilities, workspace, fs, "Cargo.toml", "Rust manifest");
  addManifestCapability(capabilities, workspace, fs, "go.mod", "Go module manifest");
  addManifestCapability(capabilities, workspace, fs, "pyproject.toml", "Python project manifest");
  addManifestCapability(capabilities, workspace, fs, "pom.xml", "Maven manifest");
  addManifestCapability(capabilities, workspace, fs, "build.gradle", "Gradle manifest");
  addManifestCapability(capabilities, workspace, fs, "build.gradle.kts", "Gradle Kotlin manifest");
  addManifestCapability(capabilities, workspace, fs, "Dockerfile", "Dockerfile");
  return capabilities;
}

function deadlineExpired(startedAt: number, now: () => number, deadlineMs: number): boolean {
  return now() - startedAt >= deadlineMs;
}

function deadlineCapability(): RuntimeCapability {
  return {
    id: "runtime-detection:deadline",
    kind: "command-source",
    label: "Runtime detection deadline",
    state: "missing",
    unavailableReason: "probe-timed-out",
    remediationHint: "Retry runtime detection or reduce host PATH size.",
  };
}

function detectHostCapabilities(
  specs: readonly HostExecutableSpec[],
  probe: HostExecutableProbe,
  workspaceRoot: string | undefined,
  generatedAtMs: number,
  now: () => number,
  deadlineMs: number,
): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = [];
  for (const spec of specs) {
    if (deadlineExpired(generatedAtMs, now, deadlineMs)) {
      capabilities.push(deadlineCapability());
      break;
    }
    capabilities.push(capabilityFromProbe(spec, probe.probe(spec.executable, workspaceRoot)));
  }
  return capabilities;
}

function runtimeProbe(options: RuntimeCapabilityDetectorOptions): HostExecutableProbe {
  if (options.probe !== undefined) {
    return options.probe;
  }
  return new PathHostExecutableProbe(
    options.env ?? process.env,
    options.platform ?? process.platform,
  );
}

function appendWorkspaceCapabilities(
  capabilities: RuntimeCapability[],
  options: RuntimeCapabilityDetectorOptions,
  fs: WorkspaceFs,
  generatedAtMs: number,
  now: () => number,
  deadlineMs: number,
): void {
  if (deadlineExpired(generatedAtMs, now, deadlineMs)) {
    return;
  }
  capabilities.push(...workspaceCapabilities(options.workspace, fs));
}

export function detectRuntimeCapabilities(
  options: RuntimeCapabilityDetectorOptions = {},
): RuntimeCapabilitiesResponse {
  const now = options.now ?? Date.now;
  const generatedAtMs = now();
  const deadlineMs = options.deadlineMs ?? DEFAULT_RUNTIME_CAPABILITY_DEADLINE_MS;
  const fs = options.fs ?? nodeWorkspaceFs;
  const workspaceRoot = options.workspace?.root;
  const probe = runtimeProbe(options);
  const capabilities = detectHostCapabilities(
    options.specs ?? RUNTIME_HOST_EXECUTABLE_SPECS,
    probe,
    workspaceRoot,
    generatedAtMs,
    now,
    deadlineMs,
  );
  appendWorkspaceCapabilities(capabilities, options, fs, generatedAtMs, now, deadlineMs);
  return {
    schemaVersion: RUNTIME_CAPABILITY_SCHEMA_VERSION,
    generatedAtMs,
    deadlineMs,
    capabilities,
  };
}
