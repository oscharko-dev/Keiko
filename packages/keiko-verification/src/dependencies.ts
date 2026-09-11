// Dependency bootstrap (ADR-0043 D17). A plan's package scripts run against the workspace's
// installed dependencies, and a managed task worktree is a clean checkout without them (Coding
// Workbench run 15, 2026-09-10: every `build` step failed within 200 ms on a missing binary, and
// the model had no governed way to install anything). Before the first script step the
// orchestrator installs the manifest's declared dependencies when the installed tree is not
// current. This is the ONE verification command that keeps host network: `npm install
// --ignore-scripts` executes no package or project code — it only resolves and unpacks what the
// manifest declares — and the code it fetches runs solely inside the sandboxed, egress-denied steps
// that follow. Only npm's own configuration applies: the child gets the ephemeral HOME every
// governed command gets, and a project `.npmrc` refuses the bootstrap outright, so a manifest cannot
// redirect the install to a registry nobody configured.
//
// Host network makes every source npm would contact part of that boundary (CodeRabbit review, PR
// #3452: CWE-918, CWE-494). Before npm runs, each specifier the manifest declares must resolve
// through the registry (a version, a range, a dist-tag, or an `npm:` alias of one), and each entry
// of a lockfile, or of the tree npm already installed, must be fetched over HTTPS from the approved
// registry against an integrity hash, or be a folder or link inside the workspace. A URL, a Git
// remote, a path or a tarball names a destination nobody approved and refuses the bootstrap. A
// registry package may itself name such a source, where no pre-install check can see it, so the
// install's egress is confined as well (registryEgress.ts): npm reaches the network only through a
// loopback proxy that tunnels to the approved registry and refuses every other destination, and it
// refuses Git dependencies outright. After npm exits, the tree it installed is still held to the
// same rule.

import { join } from "node:path";
import { redact } from "@oscharko-dev/keiko-security";
import {
  CommandCancelledError,
  CommandTimeoutError,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandResult,
  type CommandRule,
  type RunCommandDeps,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import type { WorkspaceFs, WorkspaceInfo, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { isRootRelativeFileIdentifier } from "@oscharko-dev/keiko-contracts/runtime/editor-workspace-path";
import {
  DEPENDENCY_INSTALL_LIMITS,
  type VerificationDependencyState,
  type VerificationDependencySummary,
  type VerificationLockfileState,
} from "@oscharko-dev/keiko-contracts/runtime/verification";
import { outputExcerpt } from "./excerpt.js";
import {
  registryEgressEnv,
  startRegistryEgressProxy,
  type RegistryEgressCounts,
  type RegistryEgressProxy,
} from "./registryEgress.js";

// Only `npm install` with lifecycle scripts disabled; the argument vector is fixed by this module
// and never model-supplied, so the rule is a second, independent statement of the same invariant.
export const DEPENDENCY_INSTALL_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "npm",
    allowedSubcommands: Object.freeze(["install"]),
    forbidLeadingFlags: true,
    denyFlags: Object.freeze(["-c", "--call"]),
  },
]);

export const DEPENDENCY_INSTALL_ARGS: readonly string[] = Object.freeze([
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--no-progress",
  "--loglevel=error",
]);

/**
 * npm's default registry: the one origin a lockfile entry may be fetched from. The child's HOME is
 * ephemeral and a project `.npmrc` refuses the bootstrap, so no repository-controlled configuration
 * can name another.
 */
export const DEPENDENCY_APPROVED_REGISTRY = "https://registry.npmjs.org/";
const APPROVED_REGISTRY_HOST = new URL(DEPENDENCY_APPROVED_REGISTRY).host;

// package.json is small; the cap only stops a pathological file from being parsed.
const MANIFEST_MAX_BYTES = 1_048_576;
// A lockfile lists every installed package; the cap only stops a pathological one from being parsed.
const LOCKFILE_MAX_BYTES = 64 * 1_048_576;
const MANIFEST = "package.json";
const LOCKFILES: readonly string[] = ["package-lock.json", "npm-shrinkwrap.json"];
const INSTALLED_TREE_MARKER = join("node_modules", ".package-lock.json");
// Every lockfile npm reads a source from: the root lockfiles and the tree it already installed.
const SOURCE_LOCKFILES: readonly string[] = [...LOCKFILES, INSTALLED_TREE_MARKER];
const LOCKFILE_VERSIONS: ReadonlySet<unknown> = new Set<unknown>([2, 3]);
const PROJECT_NPM_CONFIG = ".npmrc";
const DECLARATION_SECTIONS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];
// Every section npm installs from: the declarations, plus the peers npm 7+ installs with them.
const SOURCE_SECTIONS: readonly string[] = [...DECLARATION_SECTIONS, "peerDependencies"];

// npm-package-arg reads a specifier as a location (a URL, a Git remote or hosted shorthand, a path, a
// tarball) when it carries a scheme or host separator, a path separator, starts like a path, or
// names a tarball file. Everything else is a version, a range or a dist-tag: only the registry
// resolves it.
const LOCATION_SPECIFIER = /[:/\\]|^\.|\.(?:tgz|tar|tar\.gz)$/iu;
const NPM_ALIAS = "npm:";
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u;
// A lockfile location npm installs into, as opposed to a folder of the workspace itself.
const INSTALL_LOCATION = /(?:^|\/)node_modules\//u;
// One Subresource Integrity hash in an algorithm npm verifies; an entry may list several.
const INTEGRITY_HASH = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/u;

export type DependencyBootstrapRefusal =
  "project-npm-config" | "manifest-unreadable" | "lockfile-unreadable" | "unapproved-source";

export type DependencyBootstrapPlan =
  | { readonly kind: "none" }
  | { readonly kind: "current"; readonly lockfile: VerificationLockfileState }
  | { readonly kind: "install"; readonly lockfile: VerificationLockfileState }
  | {
      readonly kind: "refused";
      readonly reason: DependencyBootstrapRefusal;
      readonly lockfile: VerificationLockfileState;
    };

export interface DependencyBootstrapDeps {
  readonly workspace: WorkspaceInfo;
  readonly fs: WorkspaceFs;
  readonly spawn: SpawnFn;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly resolveExecutable?: RunCommandDeps["resolveExecutable"] | undefined;
  readonly onTerminated?: RunCommandDeps["onTerminated"] | undefined;
  readonly sandboxAvailability?: RunCommandDeps["sandboxAvailability"] | undefined;
  readonly platform?: RunCommandDeps["platform"] | undefined;
  // Starts the registry egress proxy the install runs behind; tests inject their own.
  readonly startEgressProxy?: (() => Promise<RegistryEgressProxy>) | undefined;
}

export interface DependencyBootstrapOutcome {
  readonly summary: VerificationDependencySummary;
  // Redacted tail of the install output when it did not succeed — for the caller's repair loop,
  // never for the report (see excerpt.ts).
  readonly excerpt?: string | undefined;
}

function statOrUndefined(fs: WorkspaceFs, path: string): WorkspaceStat | undefined {
  try {
    return fs.exists(path) ? fs.stat(path) : undefined;
  } catch {
    return undefined;
  }
}

type ManifestRead = Readonly<Record<string, unknown>> | "absent" | "unreadable";
type LockfileVerdict = "approved" | "unapproved-source" | "lockfile-unreadable";

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A JSON object read from a file within its size cap; undefined when the file is not one.
function parsedJsonObject(
  path: string,
  fs: WorkspaceFs,
  maxBytes: number,
): Readonly<Record<string, unknown>> | undefined {
  const stat = statOrUndefined(fs, path);
  if (stat === undefined || !stat.isFile || stat.size > maxBytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileUtf8(path));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function declaredDependencyCount(manifest: Readonly<Record<string, unknown>>): number {
  return DECLARATION_SECTIONS.reduce((count, section) => {
    const entries = manifest[section];
    return isPlainObject(entries) ? count + Object.keys(entries).length : count;
  }, 0);
}

function readManifest(root: string, fs: WorkspaceFs): ManifestRead {
  const path = join(root, MANIFEST);
  if (statOrUndefined(fs, path) === undefined) return "absent";
  return parsedJsonObject(path, fs, MANIFEST_MAX_BYTES) ?? "unreadable";
}

function isRegistrySpecifier(specifier: string): boolean {
  if (!specifier.startsWith(NPM_ALIAS)) return !LOCATION_SPECIFIER.test(specifier);
  const aliased = specifier.slice(NPM_ALIAS.length);
  const versionAt = aliased.indexOf("@", 1);
  const name = versionAt === -1 ? aliased : aliased.slice(0, versionAt);
  const range = versionAt === -1 ? "" : aliased.slice(versionAt + 1);
  return PACKAGE_NAME.test(name) && !LOCATION_SPECIFIER.test(range);
}

function specifiersApproved(section: unknown): boolean {
  if (section === undefined || section === null) return true;
  return (
    isPlainObject(section) &&
    Object.values(section).every(
      (specifier) => typeof specifier === "string" && isRegistrySpecifier(specifier),
    )
  );
}

// An override replaces a specifier anywhere in the tree, so its values are specifiers too; "$name"
// refers to a direct dependency's own specifier, which is checked where it is declared.
function isOverrideSpecifier(value: string): boolean {
  return value.startsWith("$") ? PACKAGE_NAME.test(value.slice(1)) : isRegistrySpecifier(value);
}

function overridesApproved(overrides: unknown): boolean {
  const pending: unknown[] = [overrides];
  while (pending.length > 0) {
    const value = pending.pop();
    if (isPlainObject(value)) {
      for (const nested of Object.values(value)) pending.push(nested);
    } else if (typeof value !== "string" || !isOverrideSpecifier(value)) {
      return false;
    }
  }
  return true;
}

// npm links every folder a workspace pattern matches; a pattern must stay inside the workspace.
function workspacesContained(workspaces: unknown): boolean {
  return (
    Array.isArray(workspaces) && workspaces.every((pattern: unknown) => isContainedPath(pattern))
  );
}

function manifestSourcesApproved(manifest: Readonly<Record<string, unknown>>): boolean {
  return (
    SOURCE_SECTIONS.every((section) => specifiersApproved(manifest[section])) &&
    (manifest.overrides === undefined || overridesApproved(manifest.overrides)) &&
    (manifest.workspaces === undefined || workspacesContained(manifest.workspaces))
  );
}

function isContainedPath(value: unknown): boolean {
  return typeof value === "string" && isRootRelativeFileIdentifier(value);
}

function isApprovedRegistryUrl(value: unknown): boolean {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.host === APPROVED_REGISTRY_HOST &&
    url.username === "" &&
    url.password === ""
  );
}

function isIntegrity(value: unknown): boolean {
  return typeof value === "string" && value.split(" ").every((hash) => INTEGRITY_HASH.test(hash));
}

// An installed package is a link into the workspace, bundled inside its parent's verified tarball,
// or fetched from the approved registry against its integrity hash.
function installedEntryApproved(entry: Readonly<Record<string, unknown>>): boolean {
  if (entry.link === true) return isContainedPath(entry.resolved);
  if (entry.inBundle === true) return true;
  return (
    isIntegrity(entry.integrity) &&
    (entry.resolved === undefined || isApprovedRegistryUrl(entry.resolved))
  );
}

// A location is the workspace root (""), a folder inside it (a workspace member, which has no source
// of its own), or an install location under node_modules; none may leave the workspace.
function lockfileEntryApproved(location: string, entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (location !== "" && !isContainedPath(location)) return false;
  return INSTALL_LOCATION.test(location)
    ? installedEntryApproved(entry)
    : entry.resolved === undefined;
}

// Undefined when the file is absent. Versions 2 and 3 carry the `packages` map npm 7+ installs
// from; version 1 would make npm re-resolve every package, so it is refused as unreadable.
function lockfileVerdict(path: string, fs: WorkspaceFs): LockfileVerdict | undefined {
  if (statOrUndefined(fs, path) === undefined) return undefined;
  const lockfile = parsedJsonObject(path, fs, LOCKFILE_MAX_BYTES);
  if (lockfile === undefined || !LOCKFILE_VERSIONS.has(lockfile.lockfileVersion)) {
    return "lockfile-unreadable";
  }
  const packages = lockfile.packages;
  if (!isPlainObject(packages)) return "lockfile-unreadable";
  return Object.entries(packages).every(([location, entry]) =>
    lockfileEntryApproved(location, entry),
  )
    ? "approved"
    : "unapproved-source";
}

function sourceRefusal(
  root: string,
  manifest: Readonly<Record<string, unknown>>,
  fs: WorkspaceFs,
): DependencyBootstrapRefusal | undefined {
  if (!manifestSourcesApproved(manifest)) return "unapproved-source";
  for (const name of SOURCE_LOCKFILES) {
    const verdict = lockfileVerdict(join(root, name), fs);
    if (verdict !== undefined && verdict !== "approved") return verdict;
  }
  return undefined;
}

// npm's hidden lockfile describes exactly the tree an install left; an install that left none cannot
// be shown to have used approved sources.
function installedTreeRefusal(
  root: string,
  fs: WorkspaceFs,
): Exclude<LockfileVerdict, "approved"> | undefined {
  const verdict = lockfileVerdict(join(root, INSTALLED_TREE_MARKER), fs) ?? "lockfile-unreadable";
  return verdict === "approved" ? undefined : verdict;
}

function lockfileState(root: string, fs: WorkspaceFs): VerificationLockfileState {
  return LOCKFILES.some((name) => statOrUndefined(fs, join(root, name))?.isFile === true)
    ? "present"
    : "absent";
}

// npm's own currency heuristic, read rather than re-derived: the hidden lockfile it writes into
// node_modules describes the installed tree, and it is current while nothing it was derived from
// (the manifest, a lockfile) has been written since.
function installedTreeCurrent(root: string, fs: WorkspaceFs): boolean {
  const installed = statOrUndefined(fs, join(root, INSTALLED_TREE_MARKER))?.mtimeMs;
  if (installed === undefined) return false;
  const inputs = [MANIFEST, ...LOCKFILES]
    .map((name) => statOrUndefined(fs, join(root, name))?.mtimeMs)
    .filter((mtime): mtime is number => mtime !== undefined);
  return inputs.every((mtime) => mtime <= installed);
}

export function planDependencyBootstrap(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): DependencyBootstrapPlan {
  const root = workspace.root;
  const manifest = readManifest(root, fs);
  if (manifest === "absent") return { kind: "none" };
  const lockfile = lockfileState(root, fs);
  if (manifest === "unreadable") {
    return { kind: "refused", reason: "manifest-unreadable", lockfile };
  }
  if (declaredDependencyCount(manifest) === 0) return { kind: "none" };
  if (statOrUndefined(fs, join(root, PROJECT_NPM_CONFIG)) !== undefined) {
    return { kind: "refused", reason: "project-npm-config", lockfile };
  }
  const refusal = sourceRefusal(root, manifest, fs);
  if (refusal !== undefined) return { kind: "refused", reason: refusal, lockfile };
  return installedTreeCurrent(root, fs)
    ? { kind: "current", lockfile }
    : { kind: "install", lockfile };
}

const REFUSAL_DETAIL: Readonly<Record<DependencyBootstrapRefusal, string>> = {
  "project-npm-config": "project npm config present; dependency installation refused",
  "manifest-unreadable": "package.json unreadable; dependency installation refused",
  "lockfile-unreadable":
    "lockfile unreadable or older than version 2; dependency installation refused",
  "unapproved-source":
    "a dependency source is not the approved HTTPS registry; dependency installation refused",
};
// The egress proxy refused a destination during the install: a package in the tree reached for a
// source other than the approved registry, which is a refusal, not a failure.
const EGRESS_REFUSAL_DETAIL =
  "the install reached for a source other than the approved HTTPS registry; dependency installation refused";
const EGRESS_UNAVAILABLE_DETAIL =
  "the registry egress proxy could not start; dependency installation refused";
const EGRESS_FAULT_DETAIL =
  "the registry egress proxy failed during the install; dependency installation refused";

// After an install, the refusal names the tree npm left, not an installation that never ran.
const INSTALLED_TREE_REFUSAL_DETAIL: Readonly<
  Record<Exclude<LockfileVerdict, "approved">, string>
> = {
  "lockfile-unreadable": "the install left no readable lockfile of its tree; verification refused",
  "unapproved-source":
    "the installed tree names a source other than the approved HTTPS registry; verification refused",
};

function checkedInstall(
  outcome: DependencyBootstrapOutcome,
  deps: DependencyBootstrapDeps,
): DependencyBootstrapOutcome {
  if (outcome.summary.state !== "installed") return outcome;
  const refusal = installedTreeRefusal(deps.workspace.root, deps.fs);
  if (refusal === undefined) return outcome;
  return {
    summary: {
      ...outcome.summary,
      state: "refused",
      detail: INSTALLED_TREE_REFUSAL_DETAIL[refusal],
    },
  };
}

function settled(
  state: VerificationDependencyState,
  lockfile: VerificationLockfileState,
  detail?: string,
): DependencyBootstrapOutcome {
  return {
    summary: {
      state,
      lockfile,
      exitCode: null,
      durationMs: 0,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

function installDeps(deps: DependencyBootstrapDeps, egressProxyUrl: string): RunCommandDeps {
  return {
    workspace: deps.workspace,
    policy: {
      ...DEFAULT_SANDBOX_POLICY,
      maxOutputBytes: DEPENDENCY_INSTALL_LIMITS.maxOutputBytes,
      defaultTimeoutMs: DEPENDENCY_INSTALL_LIMITS.wallTimeMs,
      network: DEPENDENCY_INSTALL_LIMITS.network,
      // Host network, reached only through the registry egress proxy (registryEgress.ts).
      pinnedEnv: {
        ...DEFAULT_SANDBOX_POLICY.pinnedEnv,
        ...registryEgressEnv(egressProxyUrl, DEPENDENCY_APPROVED_REGISTRY),
      },
    },
    commandRules: DEPENDENCY_INSTALL_COMMAND_RULES,
    spawn: deps.spawn,
    processEnv: deps.processEnv,
    now: deps.now,
    fs: deps.fs,
    ...(deps.resolveExecutable === undefined ? {} : { resolveExecutable: deps.resolveExecutable }),
    ...(deps.sandboxAvailability === undefined
      ? {}
      : { sandboxAvailability: deps.sandboxAvailability }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  };
}

function installState(result: CommandResult, aborted: boolean): VerificationDependencyState {
  if (result.timedOut) return "timed-out";
  if (aborted) return "cancelled";
  return result.exitCode === 0 ? "installed" : "failed";
}

// The command boundary REJECTS on its own wall-time ceiling and on an abort; it does not resolve
// with a timed-out result. Both are named for what they are, never collapsed into a generic failure.
function rejectedInstallState(error: unknown): VerificationDependencyState {
  if (error instanceof CommandTimeoutError) return "timed-out";
  return error instanceof CommandCancelledError ? "cancelled" : "failed";
}

function installOutcome(
  result: CommandResult,
  lockfileBefore: VerificationLockfileState,
  lockfileAfter: VerificationLockfileState,
  aborted: boolean,
): DependencyBootstrapOutcome {
  const state = installState(result, aborted);
  const lockfile: VerificationLockfileState =
    lockfileBefore === "absent" && lockfileAfter === "present" ? "created" : lockfileBefore;
  const summary: VerificationDependencySummary = {
    state,
    lockfile,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(state === "installed"
      ? {}
      : { detail: `npm install ${state} (exit ${String(result.exitCode ?? "none")})` }),
  };
  return state === "installed" ? { summary } : { summary, excerpt: outputExcerpt(result) };
}

export async function runDependencyBootstrap(
  plan: DependencyBootstrapPlan,
  deps: DependencyBootstrapDeps,
): Promise<DependencyBootstrapOutcome> {
  if (plan.kind === "none") return settled("none", "absent");
  if (plan.kind === "current") return settled("current", plan.lockfile);
  if (plan.kind === "refused")
    return settled("refused", plan.lockfile, REFUSAL_DETAIL[plan.reason]);
  const startedAt = deps.now();
  let proxy: RegistryEgressProxy;
  try {
    proxy = await (deps.startEgressProxy ?? startApprovedRegistryProxy)();
  } catch {
    // No proxy, no install: npm never runs with an unconfined network.
    return {
      summary: {
        state: "failed",
        lockfile: plan.lockfile,
        exitCode: null,
        durationMs: deps.now() - startedAt,
        detail: EGRESS_UNAVAILABLE_DETAIL,
      },
    };
  }
  try {
    const outcome = await installBehindProxy(plan.lockfile, deps, proxy.url, startedAt);
    return withEgress(outcome, proxy.counts(), proxy.fault());
  } finally {
    await proxy.close();
  }
}

function startApprovedRegistryProxy(): Promise<RegistryEgressProxy> {
  return startRegistryEgressProxy({ registry: DEPENDENCY_APPROVED_REGISTRY });
}

// The install's egress on its record. Any refused destination refuses the bootstrap, whether npm
// then failed or carried on: npm tolerates an optional dependency it could not fetch and prunes it,
// so exit 0 does not mean nothing reached out (PR #3452 review). A proxy that faulted mid-install
// fails it: its egress was cut, not confined.
function withEgress(
  outcome: DependencyBootstrapOutcome,
  egress: RegistryEgressCounts,
  fault: string | undefined,
): DependencyBootstrapOutcome {
  const summary = { ...outcome.summary, egress };
  if (fault !== undefined) {
    return { ...outcome, summary: { ...summary, state: "failed", detail: EGRESS_FAULT_DETAIL } };
  }
  const state = outcome.summary.state;
  const reachedOut = egress.refused > 0 && (state === "installed" || state === "failed");
  return {
    ...outcome,
    summary: reachedOut ? { ...summary, state: "refused", detail: EGRESS_REFUSAL_DETAIL } : summary,
  };
}

async function installBehindProxy(
  lockfile: VerificationLockfileState,
  deps: DependencyBootstrapDeps,
  egressProxyUrl: string,
  startedAt: number,
): Promise<DependencyBootstrapOutcome> {
  try {
    const result = await runCommand(
      {
        command: "npm",
        args: DEPENDENCY_INSTALL_ARGS,
        cwd: undefined,
        timeoutMs: DEPENDENCY_INSTALL_LIMITS.wallTimeMs,
        signal: deps.signal ?? new AbortController().signal,
      },
      {
        ...installDeps(deps, egressProxyUrl),
        // Named at the call site, so this file alone proves the termination-evidence wiring
        // (scripts/__tests__/run-command-evidence-wiring.test.mjs): an install the boundary kills
        // leaves the same evidence as every governed step.
        ...(deps.onTerminated === undefined ? {} : { onTerminated: deps.onTerminated }),
      },
    );
    return checkedInstall(
      installOutcome(
        result,
        lockfile,
        lockfileState(deps.workspace.root, deps.fs),
        deps.signal?.aborted === true,
      ),
      deps,
    );
  } catch (error) {
    // A refusal by the command boundary (rule, containment, host) is a failed bootstrap with its
    // already-redacted reason; the report never carries the raw error.
    const detail =
      error instanceof Error ? redact(error.message) : "dependency installation failed";
    return {
      summary: {
        state: rejectedInstallState(error),
        lockfile,
        exitCode: null,
        durationMs: deps.now() - startedAt,
        detail,
      },
    };
  }
}
