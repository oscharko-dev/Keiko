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
import {
  DEPENDENCY_INSTALL_LIMITS,
  type VerificationDependencyState,
  type VerificationDependencySummary,
  type VerificationLockfileState,
} from "@oscharko-dev/keiko-contracts/runtime/verification";
import { outputExcerpt } from "./excerpt.js";

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

// package.json is small; the cap only stops a pathological file from being parsed.
const MANIFEST_MAX_BYTES = 1_048_576;
const MANIFEST = "package.json";
const LOCKFILES: readonly string[] = ["package-lock.json", "npm-shrinkwrap.json"];
const INSTALLED_TREE_MARKER = join("node_modules", ".package-lock.json");
const PROJECT_NPM_CONFIG = ".npmrc";
const DECLARATION_SECTIONS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

export type DependencyBootstrapRefusal = "project-npm-config" | "manifest-unreadable";

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

type ManifestDeclarations = { readonly declared: number } | "absent" | "unreadable";

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedManifest(
  path: string,
  fs: WorkspaceFs,
): Readonly<Record<string, unknown>> | undefined {
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

function manifestDeclarations(root: string, fs: WorkspaceFs): ManifestDeclarations {
  const path = join(root, MANIFEST);
  const stat = statOrUndefined(fs, path);
  if (stat === undefined) return "absent";
  if (!stat.isFile || stat.size > MANIFEST_MAX_BYTES) return "unreadable";
  const manifest = parsedManifest(path, fs);
  return manifest === undefined ? "unreadable" : { declared: declaredDependencyCount(manifest) };
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
  const declarations = manifestDeclarations(root, fs);
  if (declarations === "absent") return { kind: "none" };
  const lockfile = lockfileState(root, fs);
  if (declarations === "unreadable") {
    return { kind: "refused", reason: "manifest-unreadable", lockfile };
  }
  if (declarations.declared === 0) return { kind: "none" };
  if (statOrUndefined(fs, join(root, PROJECT_NPM_CONFIG)) !== undefined) {
    return { kind: "refused", reason: "project-npm-config", lockfile };
  }
  return installedTreeCurrent(root, fs)
    ? { kind: "current", lockfile }
    : { kind: "install", lockfile };
}

const REFUSAL_DETAIL: Readonly<Record<DependencyBootstrapRefusal, string>> = {
  "project-npm-config": "project npm config present; dependency installation refused",
  "manifest-unreadable": "package.json unreadable; dependency installation refused",
};

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

function installDeps(deps: DependencyBootstrapDeps): RunCommandDeps {
  return {
    workspace: deps.workspace,
    policy: {
      ...DEFAULT_SANDBOX_POLICY,
      maxOutputBytes: DEPENDENCY_INSTALL_LIMITS.maxOutputBytes,
      defaultTimeoutMs: DEPENDENCY_INSTALL_LIMITS.wallTimeMs,
      network: DEPENDENCY_INSTALL_LIMITS.network,
    },
    commandRules: DEPENDENCY_INSTALL_COMMAND_RULES,
    spawn: deps.spawn,
    processEnv: deps.processEnv,
    now: deps.now,
    fs: deps.fs,
    ...(deps.resolveExecutable === undefined ? {} : { resolveExecutable: deps.resolveExecutable }),
    ...(deps.onTerminated === undefined ? {} : { onTerminated: deps.onTerminated }),
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
  try {
    const result = await runCommand(
      {
        command: "npm",
        args: DEPENDENCY_INSTALL_ARGS,
        cwd: undefined,
        timeoutMs: DEPENDENCY_INSTALL_LIMITS.wallTimeMs,
        signal: deps.signal ?? new AbortController().signal,
      },
      installDeps(deps),
    );
    return installOutcome(
      result,
      plan.lockfile,
      lockfileState(deps.workspace.root, deps.fs),
      deps.signal?.aborted === true,
    );
  } catch (error) {
    // A refusal by the command boundary (rule, containment, host) is a failed bootstrap with its
    // already-redacted reason; the report never carries the raw error.
    const detail =
      error instanceof Error ? redact(error.message) : "dependency installation failed";
    return {
      summary: {
        state: rejectedInstallState(error),
        lockfile: plan.lockfile,
        exitCode: null,
        durationMs: deps.now() - startedAt,
        detail,
      },
    };
  }
}
