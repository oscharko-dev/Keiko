// Command execution — the spawn boundary. Deny-by-default allowlist is checked BEFORE any
// spawn; the child runs with a clean name-allowlisted env, no shell, and a resolved-in-workspace
// cwd. Timeout and abort both kill the process group (SIGTERM→SIGKILL after the grace period).
// stdout/stderr are byte-capped and redacted before they leave this layer (ADR-0006 D3/D5).
//
// node:child_process is imported ONLY for the default SpawnFn adapter; all decision logic lives
// in sandbox.ts (pure). Tests inject a fake SpawnFn for the allowlist/timeout/cancel paths and a
// real `node`-spawn for the env-isolation / no-shell / real-cancellation integration cases.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { redact } from "@oscharko-dev/keiko-security";
import {
  planIsolatedRun,
  probeBackends,
  type BackendAvailability,
} from "@oscharko-dev/keiko-sandbox";
import {
  containedRealPathInfo,
  isDenied,
  isWithinWorkspace,
  PathDeniedError,
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { CommandCancelledError, CommandDeniedError, CommandTimeoutError } from "./errors.js";
import {
  buildChildEnv,
  collectCredentialEnvValues,
  collectSensitiveEnvValues,
  isCommandAllowed,
} from "./sandbox.js";
import type { CommandResult, CommandRule, SandboxAttestation, SandboxPolicy } from "./types.js";
import { buildWindowsShellInvocation, resolveSystemBinaryPath } from "./windows-shell.js";

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly shell: false;
  readonly detached: boolean;
  // Set only for a Windows `.cmd`/`.bat` executable routed through the hardened cmd.exe wrapper
  // (issue #3350 / Node CVE-2024-27980, windows-shell.ts). Absent on every other spawn — including
  // every POSIX spawn and the network:"none" sandbox-wrapper branch — so it never widens what a
  // plain shell:false spawn already does.
  readonly windowsVerbatimArguments?: boolean | undefined;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ExecutableResolverDeps {
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly fs?: WorkspaceFs | undefined;
}

export type ExecutableResolver = (command: string, deps: ExecutableResolverDeps) => string;

// Bounds the WHOLE Windows process tree rooted at `pid` (see killGroup below for why the immediate
// child alone is not enough). Injectable so tests can assert the tree-kill decision deterministically
// without spawning a real process tree on a non-Windows host; defaults to nodeWindowsTreeKill.
export type WindowsTreeKill = (pid: number, processEnv: NodeJS.ProcessEnv) => void;

export const nodeSpawnFn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], options);

// Supplies the child's HOME/USERPROFILE as an EPHEMERAL, EMPTY per-run directory instead of the
// developer's real home (C5). `make` returns a fresh empty dir; `cleanup` removes it after the
// command settles (best-effort). Injectable so tests can use a recording/fake provider.
export interface HomeProvider {
  readonly make: () => string;
  readonly cleanup: (dir: string) => void;
}

export const nodeHomeProvider: HomeProvider = {
  make: (): string => mkdtempSync(join(tmpdir(), "keiko-home-")),
  cleanup: (dir): void => {
    // Best-effort: a leftover temp dir is not worth failing or rejecting the command over.
    rmSync(dir, { recursive: true, force: true });
  },
};

export interface RunCommandDeps {
  readonly workspace: WorkspaceInfo;
  readonly policy: SandboxPolicy;
  readonly commandRules: readonly CommandRule[];
  readonly spawn: SpawnFn;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now: () => number;
  // Read-only port used solely for the cwd symlink-containment check. Defaults to nodeWorkspaceFs.
  readonly fs?: WorkspaceFs | undefined;
  // Supplies the ephemeral empty HOME/USERPROFILE for the child (C5). Defaults to nodeHomeProvider.
  readonly home?: HomeProvider | undefined;
  // Egress enforcement (ADR-0043). When policy.network === "none", keiko-sandbox wraps the spawn in
  // an OS/container boundary so an outbound connection from the child fails; a host with no enforcing
  // backend fails the command closed (untrusted code is never run unprotected). These seams let tests
  // force a backend deterministically; they default to probing the real host.
  readonly sandboxAvailability?: BackendAvailability | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  // Bounds the Windows process tree on termination (taskkill /T /F) so a wrapped `.cmd` target's
  // grandchild — e.g. node.exe running npm under cmd.exe (issue #3350, ADR-0006 D5) — cannot
  // survive timeout/abort. Defaults to nodeWindowsTreeKill; never consulted on POSIX. Injectable
  // so tests can assert the tree-kill decision without a real Windows host.
  readonly killWindowsTree?: WindowsTreeKill | undefined;
}

// Body-free evidence of a termination decision, handed to the optional `onTerminated` seam below.
// keiko-tools has no injected log port of its own — and must not grow one; ADR-0019 keeps the
// dependency direction one-way, keiko-server -> keiko-tools, never the reverse — so this callback
// seam, not a new logging mechanism, is how a platform-dependent decision branch (in particular
// whether the win32 taskkill.exe tree-kill path below was engaged, and whether it completed
// without throwing) becomes observable to a caller that DOES own a log port. Mirrors the existing
// `onSpawn` seam immediately below: optional, never the command text/args/cwd/env/output.
export type CommandTerminationReason = "timeout" | "abort" | "output-cap" | "spawn-callback-error";

export interface CommandTerminationEvidence {
  readonly reason: CommandTerminationReason;
  readonly pid: number;
  // True only once killGroup reaches the win32 tree-kill step below — never on POSIX, where
  // signalling the process group alone is sufficient (see killGroup).
  readonly windowsTreeKillAttempted: boolean;
  // True when the (attempted) tree-kill invocation ran without the caller having to swallow a
  // synchronous throw from it; always true when windowsTreeKillAttempted is false. An asynchronous
  // spawn failure (e.g. a stripped-down image missing taskkill.exe) is already swallowed inside
  // nodeWindowsTreeKill itself (see its own doc comment) and is therefore not observable here.
  readonly windowsTreeKillSucceeded: boolean;
}

export interface RunCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly signal: AbortSignal;
  readonly onSpawn?: ((pid: number) => void) | undefined;
  // Fires once per termination trigger (never on a clean exit), with body-free evidence only.
  // Optional; a throwing callback must never break termination — see reportTermination below,
  // which holds the same swallow-and-continue contract killGroup already holds for a misbehaving
  // killWindowsTree.
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
}

const POSIX = process.platform !== "win32";

// The taskkill.exe command/args for bounding a Windows process tree rooted at `pid`. Pure (no
// spawn) so the validated path resolution is unit-testable without touching child_process.
// `resolveSystemBinaryPath` is the SAME validated, never-from-PATH resolution the cmd.exe wrapper
// uses (windows-shell.ts) — one implementation, so taskkill.exe cannot end up less trusted than the
// binary it is terminating. It THROWS on a hostile or malformed SystemRoot/WINDIR rather than
// silently substituting a default; `nodeWindowsTreeKill` below owns turning that into a best-effort
// no-op, because termination must stay idempotent.
export function windowsTaskkillInvocation(
  pid: number,
  processEnv: NodeJS.ProcessEnv,
): { readonly command: string; readonly args: readonly string[] } {
  return {
    command: resolveSystemBinaryPath("taskkill.exe", processEnv),
    args: ["/PID", String(pid), "/T", "/F"],
  };
}

// Bounds the WHOLE Windows process tree rooted at `pid`, not just the immediate child. Before
// issue #3350's cmd.exe hardening, a `.cmd` target never spawned on win32 (Node CVE-2024-27980
// raised EINVAL), so the immediate child WAS the resolved target. Now the immediate child is
// always `cmd.exe` and the real work — e.g. `node.exe` running npm — is a grandchild that
// `child.kill()` cannot reach (ADR-0006 D5). `taskkill.exe` is an OS binary, resolved the same
// validated, never-PATH way cmd.exe is, so no new dependency is needed. Must never throw: a
// tree-kill failure (the pid already exited, or taskkill.exe is missing on a stripped-down image)
// must leave termination idempotent, matching killGroup's own contract below.
export const nodeWindowsTreeKill: WindowsTreeKill = (pid, processEnv) => {
  try {
    // Inside the try on purpose: resolveSystemBinaryPath fails CLOSED on an untrusted SystemRoot,
    // and a hostile environment must not be able to turn termination into a thrown exception.
    const { command, args } = windowsTaskkillInvocation(pid, processEnv);
    const child = nodeSpawn(command, args, { stdio: "ignore", windowsHide: true });
    // An unhandled 'error' event (e.g. ENOENT if taskkill.exe is missing) throws on the
    // EventEmitter itself; this listener keeps a spawn failure best-effort instead of crashing
    // the host process. The immediate child is still signalled via child.kill() in killGroup.
    child.on("error", () => undefined);
  } catch {
    // Synchronous spawn failure: swallow for the same reason killGroup swallows ESRCH below.
  }
};

interface KillGroupDeps {
  readonly platform: NodeJS.Platform;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly killWindowsTree: WindowsTreeKill;
}

// What killGroup actually did about the win32 tree-kill step, so terminate() can hand body-free
// evidence to the optional onTerminated seam without re-deriving the platform/pid decision a
// second time. Always { attempted: false, succeeded: true } on POSIX and when child.pid is
// already unknown (nothing to signal at all).
interface WindowsTreeKillOutcome {
  readonly attempted: boolean;
  readonly succeeded: boolean;
}

const TREE_KILL_NOT_ATTEMPTED: WindowsTreeKillOutcome = { attempted: false, succeeded: true };

// Kills the whole process group on POSIX (negative pid) so orphaned grandchildren die too. On
// Windows, `child.kill()` still reaches only the immediate child (cmd.exe for a wrapped `.cmd`
// target — issue #3350), so `killWindowsTree` additionally bounds the whole tree via taskkill.
// Both branches are best-effort and swallow their own failures: termination must stay idempotent
// and must never throw, including when an injected `killWindowsTree` misbehaves.
function killGroup(
  child: ChildProcess,
  sig: NodeJS.Signals,
  deps: KillGroupDeps,
): WindowsTreeKillOutcome {
  const pid = child.pid;
  if (pid === undefined) {
    return TREE_KILL_NOT_ATTEMPTED;
  }
  const posix = deps.platform !== "win32";
  if (posix) {
    try {
      process.kill(-pid, sig);
    } catch {
      // The group already exited; nothing to signal. Swallowing keeps termination idempotent.
    }
    return TREE_KILL_NOT_ATTEMPTED;
  }
  // ORDER IS LOAD-BEARING on Windows: the tree kill runs BEFORE the immediate child is signalled.
  // `child.kill()` is TerminateProcess and takes effect at once, while `taskkill /PID <pid> /T`
  // resolves the descendant set from the LIVE process table when it runs. Signal cmd.exe first and
  // taskkill finds no such pid, terminates nothing, and — because Windows does not reparent
  // orphans — the `node.exe` grandchild survives exactly the timeout/abort path this exists to
  // bound. Killing the tree first also narrows the pid-reuse window. `nodeGroupKill` in
  // keiko-server's lspNodeAdapter holds the same ordering for the same reason.
  const outcome = ((): WindowsTreeKillOutcome => {
    try {
      deps.killWindowsTree(pid, deps.processEnv);
      return { attempted: true, succeeded: true };
    } catch {
      // Never let a misbehaving tree-kill implementation propagate — see the WindowsTreeKill
      // contract above.
      return { attempted: true, succeeded: false };
    }
  })();
  try {
    // Fallback for the descendants taskkill could not reach (and the no-op when it reached all of
    // them): the immediate child is signalled either way.
    child.kill(sig);
  } catch {
    // The child already exited; nothing to signal. Swallowing keeps termination idempotent.
  }
  return outcome;
}

interface Buffers {
  out: Buffer[];
  err: Buffer[];
  total: number;
  truncated: boolean;
  // Total bytes that arrived across stdout+stderr, counted BEFORE the cap is applied, so it
  // includes bytes dropped past maxOutputBytes (ADR-0054 D5). Advisory only: it undercounts when
  // the child is killed before emitting all remaining over-cap output — no further data events
  // fire after terminate(). Any positive omittedByteCount derived from it is a sufficient
  // truncation signal; the exact byte total is not claimed.
  attempted: number;
}

const TRUNCATED_OUTPUT_MARKER = "[TRUNCATED OUTPUT REDACTED]";

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

function realRoot(fs: WorkspaceFs, root: string): string {
  try {
    return fs.realPath(root);
  } catch {
    return root;
  }
}

function assertBareExecutable(command: string): void {
  if (command.length === 0 || hasNul(command) || hasPathSeparator(command)) {
    throw new CommandDeniedError("executable must be a bare PATH-resolved name", command);
  }
}

function pathEntries(processEnv: NodeJS.ProcessEnv): readonly string[] {
  const pathValue = processEnv.PATH ?? "";
  return pathValue.length === 0 ? [] : pathValue.split(delimiter).filter(Boolean);
}

function executableExtensions(processEnv: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform !== "win32") {
    return [""];
  }
  return (processEnv.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter((value) => value.length > 0);
}

interface ExecutableCandidate {
  readonly path: string;
  readonly real: string;
}

function candidateExecutable(
  command: string,
  rawEntry: string,
  ext: string,
): ExecutableCandidate | undefined {
  const candidate = resolvePath(resolvePath(rawEntry), command + ext);
  try {
    accessSync(candidate, constants.X_OK);
    return { path: candidate, real: realpathSync(candidate) };
  } catch {
    return undefined;
  }
}

function assertExecutableOutsideWorkspace(
  command: string,
  lexicalWorkspaceRoot: string,
  realWorkspaceRoot: string,
  candidate: ExecutableCandidate,
): void {
  if (
    isWithinWorkspace(lexicalWorkspaceRoot, candidate.path) ||
    isWithinWorkspace(realWorkspaceRoot, candidate.real)
  ) {
    throw new CommandDeniedError(`executable resolves inside workspace: ${command}`, command);
  }
}

function defaultResolveExecutable(command: string, deps: ExecutableResolverDeps): string {
  assertBareExecutable(command);
  const fs = deps.fs ?? nodeWorkspaceFs;
  const lexicalWorkspaceRoot = deps.workspace.root;
  const realWorkspaceRoot = realRoot(fs, lexicalWorkspaceRoot);
  for (const rawEntry of pathEntries(deps.processEnv)) {
    for (const ext of executableExtensions(deps.processEnv)) {
      const candidate = candidateExecutable(command, rawEntry, ext);
      if (candidate === undefined) {
        continue;
      }
      assertExecutableOutsideWorkspace(command, lexicalWorkspaceRoot, realWorkspaceRoot, candidate);
      return candidate.real;
    }
  }
  throw new CommandDeniedError(`executable not found on PATH: ${command}`, command);
}

// The command/args/attestation actually handed to spawn. For an inherited-network run this is the
// resolved executable unchanged; for network:"none" it is the isolation wrapper (bwrap/sandbox-exec/
// unshare/container) with the resolved executable nested inside, and the attestation records how
// egress was enforced (ADR-0043).
interface SpawnTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly attestation: SandboxAttestation | undefined;
  // Set only when `command`/`args` were built by the hardened Windows cmd.exe wrapper (issue
  // #3350) and MUST reach spawn's options verbatim. Optional (never `false`) so the network:"none"
  // sandbox-wrapper branch below — POSIX-only, untouched by this issue — never has to mention it.
  readonly windowsVerbatimArguments?: boolean | undefined;
}

// Resolves what to spawn for an INHERITED-network run (deps.policy.network !== "none"): normally
// the resolved executable unchanged, but on Windows a resolved `.cmd`/`.bat` (PATHEXT resolution
// regularly produces one, e.g. `...\npm.CMD`) cannot be spawned with `shell:false` since Node's
// CVE-2024-27980 fix — it raises EINVAL. buildWindowsShellInvocation decides pass-through vs the
// hardened cmd.exe wrapper; every other platform/extension combination is returned unchanged.
function resolveInheritedSpawnTarget(
  executable: string,
  args: readonly string[],
  deps: RunCommandDeps,
): SpawnTarget {
  const platform = deps.platform ?? process.platform;
  const invocation = buildWindowsShellInvocation(executable, args, {
    platform,
    env: deps.processEnv,
  });
  if (!invocation.windowsVerbatimArguments) {
    return { command: invocation.command, args: invocation.args, attestation: undefined };
  }
  return {
    command: invocation.command,
    args: invocation.args,
    attestation: undefined,
    windowsVerbatimArguments: true,
  };
}

// Resolves the isolation wrapper binary (e.g. bwrap) to a real absolute path through the same
// resolver as the inner command, so the wrapper is PATH-resolved and proven to live outside the
// workspace before it is ever spawned.
function resolveWrapperExecutable(name: string, deps: RunCommandDeps): string {
  const resolver = deps.resolveExecutable ?? defaultResolveExecutable;
  return resolver(name, { workspace: deps.workspace, processEnv: deps.processEnv, fs: deps.fs });
}

// Decides what to spawn. Inherited network → run the executable directly. network:"none" → ask
// keiko-sandbox for an enforcing wrapper; a fail-closed decision throws (the command never spawns),
// so untrusted code is never executed without an enforced egress boundary.
function resolveSpawnTarget(
  input: RunCommandInput,
  deps: RunCommandDeps,
  executable: string,
  cwd: string,
): SpawnTarget {
  if (deps.policy.network !== "none") {
    return resolveInheritedSpawnTarget(executable, input.args, deps);
  }
  const platform = deps.platform ?? process.platform;
  const availability = deps.sandboxAvailability ?? probeBackends(deps.processEnv, platform);
  const decision = planIsolatedRun(
    {
      command: executable,
      args: input.args,
      cwd,
      network: "none",
      filesystem: deps.policy.filesystem ?? "inherit",
    },
    availability,
    platform,
  );
  if (decision.kind === "fail-closed") {
    throw new CommandDeniedError(decision.reason, input.command);
  }
  if (decision.kind === "passthrough") {
    return { command: executable, args: input.args, attestation: decision.attestation };
  }
  return {
    command: resolveWrapperExecutable(decision.command, deps),
    args: decision.args,
    attestation: decision.attestation,
  };
}

function appendCapped(buffers: Buffers, sink: Buffer[], chunk: Buffer, max: number): boolean {
  // Count every arriving byte BEFORE the cap so attempted reflects bytes dropped past max.
  buffers.attempted += chunk.length;
  if (buffers.truncated) {
    return false;
  }
  const remaining = max - buffers.total;
  if (chunk.length <= remaining) {
    sink.push(chunk);
    buffers.total += chunk.length;
    return false;
  }
  if (remaining > 0) {
    sink.push(chunk.subarray(0, remaining));
    buffers.total = max;
  }
  buffers.truncated = true;
  return true; // signals the caller to kill the child (flood protection)
}

interface RunState {
  settled: boolean;
  timedOut: boolean;
  spawnCallbackError: Error | undefined;
  timer: NodeJS.Timeout | undefined;
  graceTimer: NodeJS.Timeout | undefined;
  onAbort: (() => void) | undefined;
  // The ephemeral HOME dir to remove once after the command settles, and the provider that owns
  // its removal. `homeCleaned` makes the cleanup idempotent (close AND error both call cleanup()).
  home: HomeProvider | undefined;
  homeDir: string | undefined;
  homeCleaned: boolean;
}

// Resolves the validated cwd. Lexical containment first, then symlink containment via realpath
// (S-H1): a cwd that is a symlink escaping the root or resolving into an always-denied path must
// not become the spawn cwd. The returned path is the canonical real path that was checked, so the
// effectful spawn does not receive a weaker lexical path. Both denial cases surface as workspace path
// errors, which the host maps to a tool error — the command never spawns.
function resolveCwd(deps: RunCommandDeps, cwd: string | undefined): string {
  const lexical = resolveWithinWorkspace(deps.workspace.root, cwd ?? ".");
  const fs = deps.fs ?? nodeWorkspaceFs;
  const rel = lexical.slice(deps.workspace.root.length).replace(/^[/\\]/, "");
  if (isDenied(rel === "" ? (cwd ?? ".") : rel)) {
    throw new PathDeniedError("path matches an always-on deny pattern", cwd ?? ".");
  }
  const info = containedRealPathInfo(fs, deps.workspace.root, lexical);
  if (isDenied(info.realRelative)) {
    throw new PathDeniedError("path matches an always-on deny pattern", cwd ?? ".");
  }
  return info.path;
}

interface BuildResultOptions {
  readonly input: RunCommandInput;
  readonly buffers: Buffers;
  readonly state: RunState;
  readonly exitCode: number | null;
  readonly termSignal: NodeJS.Signals | null;
  readonly deps: RunCommandDeps;
  readonly startedAt: number;
  readonly attestation: SandboxAttestation | undefined;
}

function buildResult(options: BuildResultOptions): CommandResult {
  const { input, buffers, state, exitCode, termSignal, deps, startedAt, attestation } = options;
  // A credential the policy deliberately handed to the child is still scrubbed on the way out: a
  // forwarded token must never survive into stdout/stderr, and from there into a rejection
  // classifier, an error, an evidence record or a diagnostic.
  const secrets = [
    ...collectSensitiveEnvValues(deps.processEnv, deps.policy.envAllowlist),
    ...collectCredentialEnvValues(deps.processEnv, deps.policy.credentialEnvAllowlist ?? []),
  ];
  const attest = attestation === undefined ? {} : { attestation };
  if (buffers.truncated) {
    // Real over-cap byte count from the raw arrival counter (ADR-0054 D5). Clamped at 0 so a
    // straggler-free run never reports a negative value. Omitted entirely on the non-truncated
    // path (exactOptionalPropertyTypes: absent means "nothing omitted", never 0).
    const omitted = Math.max(0, buffers.attempted - deps.policy.maxOutputBytes);
    return {
      command: input.command,
      args: input.args,
      exitCode,
      signal: termSignal,
      stdout: TRUNCATED_OUTPUT_MARKER,
      stderr: TRUNCATED_OUTPUT_MARKER,
      durationMs: deps.now() - startedAt,
      timedOut: state.timedOut,
      truncated: true,
      omittedByteCount: omitted,
      ...attest,
    };
  }
  return {
    command: input.command,
    args: input.args,
    exitCode,
    signal: termSignal,
    stdout: redact(Buffer.concat(buffers.out).toString("utf8"), secrets),
    stderr: redact(Buffer.concat(buffers.err).toString("utf8"), secrets),
    durationMs: deps.now() - startedAt,
    timedOut: state.timedOut,
    truncated: buffers.truncated,
    ...attest,
  };
}

function cleanup(state: RunState, signal: AbortSignal): void {
  if (state.timer !== undefined) {
    clearTimeout(state.timer);
  }
  if (state.graceTimer !== undefined) {
    clearTimeout(state.graceTimer);
  }
  if (state.onAbort !== undefined) {
    signal.removeEventListener("abort", state.onAbort);
  }
  // Remove the ephemeral HOME exactly once, on whichever settle path fires first (C5).
  if (!state.homeCleaned && state.home !== undefined && state.homeDir !== undefined) {
    state.homeCleaned = true;
    state.home.cleanup(state.homeDir);
  }
}

// Reports ONE termination decision to the optional onTerminated seam — never on a clean exit,
// since every caller of terminate() is itself a termination trigger. Fires from the initial
// SIGTERM step only, not the later SIGKILL escalation in terminate() below: the win32 tree-kill
// decision (attempted/succeeded) is the same shape on both steps, so one line already answers
// "did the wrapper engage". A callback failure must never break termination — the same
// swallow-and-continue contract killGroup itself already holds for a misbehaving killWindowsTree.
function reportTermination(
  input: RunCommandInput,
  reason: CommandTerminationReason,
  pid: number | undefined,
  outcome: WindowsTreeKillOutcome,
): void {
  if (pid === undefined || input.onTerminated === undefined) {
    return;
  }
  try {
    input.onTerminated({
      reason,
      pid,
      windowsTreeKillAttempted: outcome.attempted,
      windowsTreeKillSucceeded: outcome.succeeded,
    });
  } catch {
    // See the contract above: an evidence callback failure must never break termination.
  }
}

// Escalates from SIGTERM to SIGKILL after the grace period so a child ignoring SIGTERM is still
// guaranteed to terminate within terminationGraceMs of the trigger. On win32 this also bounds the
// descendant process tree (killGroup → killWindowsTree) on every escalation step.
function terminate(
  child: ChildProcess,
  deps: RunCommandDeps,
  state: RunState,
  input: RunCommandInput,
  reason: CommandTerminationReason,
): void {
  const killDeps: KillGroupDeps = {
    platform: deps.platform ?? process.platform,
    processEnv: deps.processEnv,
    killWindowsTree: deps.killWindowsTree ?? nodeWindowsTreeKill,
  };
  const outcome = killGroup(child, "SIGTERM", killDeps);
  reportTermination(input, reason, child.pid, outcome);
  state.graceTimer = setTimeout(() => {
    killGroup(child, "SIGKILL", killDeps);
  }, deps.policy.terminationGraceMs);
  state.graceTimer.unref();
}

function wireStreams(
  child: ChildProcess,
  buffers: Buffers,
  deps: RunCommandDeps,
  state: RunState,
  input: RunCommandInput,
): void {
  const onData =
    (sink: Buffer[]) =>
    (chunk: Buffer): void => {
      if (appendCapped(buffers, sink, chunk, deps.policy.maxOutputBytes)) {
        terminate(child, deps, state, input, "output-cap"); // output flood → kill
      }
    };
  child.stdout?.on("data", onData(buffers.out));
  child.stderr?.on("data", onData(buffers.err));
}

interface ExecContext {
  readonly child: ChildProcess;
  readonly input: RunCommandInput;
  readonly deps: RunCommandDeps;
  readonly buffers: Buffers;
  readonly state: RunState;
  readonly startedAt: number;
  readonly attestation: SandboxAttestation | undefined;
}

function settleOnClose(
  ctx: ExecContext,
  resolve: (r: CommandResult) => void,
  reject: (e: unknown) => void,
): void {
  ctx.child.on("close", (code, signalName) => {
    if (ctx.state.settled) {
      return;
    }
    ctx.state.settled = true;
    cleanup(ctx.state, ctx.input.signal);
    if (ctx.state.spawnCallbackError !== undefined) {
      reject(ctx.state.spawnCallbackError);
      return;
    }
    if (ctx.state.timedOut) {
      reject(new CommandTimeoutError("command timed out", timeoutOf(ctx)));
      return;
    }
    if (ctx.input.signal.aborted) {
      reject(new CommandCancelledError("command cancelled"));
      return;
    }
    resolve(
      buildResult({
        input: ctx.input,
        buffers: ctx.buffers,
        state: ctx.state,
        exitCode: code,
        termSignal: signalName,
        deps: ctx.deps,
        startedAt: ctx.startedAt,
        attestation: ctx.attestation,
      }),
    );
  });
  ctx.child.on("error", (error) => {
    if (ctx.state.settled) {
      return;
    }
    ctx.state.settled = true;
    cleanup(ctx.state, ctx.input.signal);
    reject(ctx.state.spawnCallbackError ?? error);
  });
}

function timeoutOf(ctx: ExecContext): number {
  return ctx.input.timeoutMs ?? ctx.deps.policy.defaultTimeoutMs;
}

function armTimersAndAbort(ctx: ExecContext): void {
  const ms = timeoutOf(ctx);
  ctx.state.timer = setTimeout(() => {
    ctx.state.timedOut = true;
    terminate(ctx.child, ctx.deps, ctx.state, ctx.input, "timeout");
  }, ms);
  ctx.state.timer.unref();
  const onAbort = (): void => {
    terminate(ctx.child, ctx.deps, ctx.state, ctx.input, "abort");
  };
  ctx.state.onAbort = onAbort;
  if (ctx.input.signal.aborted) {
    onAbort();
  } else {
    ctx.input.signal.addEventListener("abort", onAbort, { once: true });
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function validateRunCommandInput(input: RunCommandInput, deps: RunCommandDeps): void {
  if (!Array.isArray(deps.policy.envAllowlist) || deps.policy.envAllowlist.length === 0) {
    throw new CommandDeniedError("sandbox envAllowlist must be a non-empty array", input.command);
  }
  const decision = isCommandAllowed(deps.commandRules, input.command, input.args);
  if (!decision.allowed) {
    throw new CommandDeniedError(decision.reason ?? "command denied", input.command);
  }
}

function resolveExecutable(input: RunCommandInput, deps: RunCommandDeps): string {
  const resolver = deps.resolveExecutable ?? defaultResolveExecutable;
  return resolver(input.command, {
    workspace: deps.workspace,
    processEnv: deps.processEnv,
    fs: deps.fs,
  });
}

function createRunState(home: HomeProvider | undefined, homeDir: string | undefined): RunState {
  return {
    settled: false,
    timedOut: false,
    spawnCallbackError: undefined,
    timer: undefined,
    graceTimer: undefined,
    onAbort: undefined,
    home,
    homeDir,
    homeCleaned: false,
  };
}

// The home the child would inherit from the (already name-copied) env, or undefined when the
// parent carries none. Only a NON-EMPTY value counts, and HOME losing to an empty string must not
// hide a usable USERPROFILE — an empty HOME is not a home directory, it is an absent one.
function inheritedHome(env: Record<string, string>): string | undefined {
  for (const candidate of [env.HOME, env.USERPROFILE]) {
    if (candidate !== undefined && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

// Applies the home-isolation decision LAST, so neither an inherited nor a pinned value can redirect
// it. Default ("ephemeral", ADR-0006 D2 Dimension 1 / C5): an empty per-run directory, so a
// home-dir credential lookup resolves to nothing. "inherit" is reserved for the governed git lanes
// that cannot function without the user's own git/SSH/gh configuration; a lane that asks to inherit
// while the parent carries no HOME falls back to the ephemeral home rather than running homeless.
function applyHomeIsolation(env: Record<string, string>, deps: RunCommandDeps): RunState {
  if (deps.policy.homeIsolation === "inherit") {
    const inherited = inheritedHome(env);
    if (inherited !== undefined) {
      env.HOME = inherited;
      env.USERPROFILE = inherited;
      return createRunState(undefined, undefined);
    }
  }
  const home = deps.home ?? nodeHomeProvider;
  const homeDir = home.make();
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  return createRunState(home, homeDir);
}

function spawnChild(
  input: RunCommandInput,
  deps: RunCommandDeps,
  target: SpawnTarget,
  cwd: string,
  env: Record<string, string>,
  state: RunState,
): ChildProcess {
  try {
    const child = deps.spawn(target.command, target.args, {
      cwd,
      env,
      shell: false,
      detached: POSIX,
      ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
    return child;
  } catch (error) {
    cleanup(state, input.signal);
    throw asError(error, "spawn failed");
  }
}

function runSpawnedChild(ctx: ExecContext): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    wireStreams(ctx.child, ctx.buffers, ctx.deps, ctx.state, ctx.input);
    settleOnClose(ctx, resolve, reject);
    try {
      if (ctx.child.pid !== undefined) ctx.input.onSpawn?.(ctx.child.pid);
    } catch (error) {
      ctx.state.spawnCallbackError = asError(error, "spawn callback failed");
      terminate(ctx.child, ctx.deps, ctx.state, ctx.input, "spawn-callback-error");
      return;
    }
    armTimersAndAbort(ctx);
  });
}

// Runs an allowlisted command. Rejects with CommandDeniedError (before spawn) for a denied
// command or a workspace-escaping cwd (PathEscapeError), CommandTimeoutError on timeout, and
// CommandCancelledError on abort; otherwise resolves a redacted, byte-capped CommandResult. All
// failure paths are Promise rejections — the function never throws synchronously.
export function runCommand(input: RunCommandInput, deps: RunCommandDeps): Promise<CommandResult> {
  try {
    validateRunCommandInput(input, deps);
    const executable = resolveExecutable(input, deps);
    const cwd = resolveCwd(deps, input.cwd);
    const target = resolveSpawnTarget(input, deps, executable, cwd);
    const env = buildChildEnv(deps.processEnv, deps.policy);
    const state = applyHomeIsolation(env, deps);
    const child = spawnChild(input, deps, target, cwd, env, state);
    const buffers: Buffers = { out: [], err: [], total: 0, truncated: false, attempted: 0 };
    const ctx: ExecContext = {
      child,
      input,
      deps,
      buffers,
      state,
      startedAt: deps.now(),
      attestation: target.attestation,
    };
    return runSpawnedChild(ctx);
  } catch (error) {
    return Promise.reject(asError(error, "command execution failed"));
  }
}
