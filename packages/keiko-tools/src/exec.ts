// Command execution — the spawn boundary. Deny-by-default allowlist is checked BEFORE any
// spawn; the child runs with a clean name-allowlisted env, no shell, and a resolved-in-workspace
// cwd. Timeout and abort both kill the process group (SIGTERM→SIGKILL after the grace period).
// stdout/stderr are byte-capped and redacted before they leave this layer (ADR-0006 D3/D5).
//
// node:child_process is imported ONLY for the default SpawnFn adapter; all decision logic lives
// in sandbox.ts (pure). Tests inject a fake SpawnFn for the allowlist/timeout/cancel paths and a
// real `node`-spawn for the env-isolation / no-shell / real-cancellation integration cases.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";
import {
  redact,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "@oscharko-dev/keiko-security";
import type {
  CommandTerminationEvidence,
  CommandTerminationReason,
  WindowsTreeKillDisposition,
  WindowsTreeKillResult,
} from "@oscharko-dev/keiko-contracts";
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
  collectCredentialLikeEnvValues,
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

// DEFINED in keiko-contracts (see command-termination.ts for what each member means and why
// "blocked-untrusted-system-root" is kept apart from "failed"). Re-exported here so the existing
// importers of these names keep working unchanged.
export type {
  WindowsTreeKillDisposition,
  WindowsTreeKillResult,
} from "@oscharko-dev/keiko-contracts";

// Bounds the WHOLE Windows process tree rooted at `pid` (see killGroup below for why the immediate
// child alone is not enough) and reports the VERIFIED outcome. Implementations must complete the
// kill (or give up) before returning — killGroup signals the immediate child only afterwards, so
// taskkill must inspect the process table while cmd.exe is still alive. Injectable so tests can
// assert the tree-kill decision deterministically on a non-Windows host; defaults to
// nodeWindowsTreeKill. Implementations should return rather than throw; a throw is treated as
// "failed".
export type WindowsTreeKill = (pid: number, processEnv: NodeJS.ProcessEnv) => WindowsTreeKillResult;

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
  // Production Windows runs reserve enough synchronous tree-kill capacity BEFORE spawn, so a
  // command is never admitted when its eventual `.cmd` grandchild could not be bounded. Tests may
  // inject deterministic capacity; a custom killWindowsTree already owns its own containment.
  readonly windowsTerminationCapacity?: WindowsTerminationCapacity | undefined;
  // Deps-level default for the per-input `onTerminated` seam (RunCommandInput below). Production
  // composition boundaries that build ONE RunCommandDeps for a whole lane (the tool-host registry,
  // the governed git adapters, the verification orchestrator) wire the evidence port here once, so
  // no runCommand call on that lane can silently omit it; a per-input callback still wins when a
  // call site carries its own run-scoped correlation (review 5058544058 P1 3887021650).
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
}

// Body-free evidence of a termination decision, handed to the optional `onTerminated` seam below.
// keiko-tools has no injected log port of its own — and must not grow one; ADR-0019 keeps the
// dependency direction one-way, keiko-server -> keiko-tools, never the reverse — so this callback
// seam, not a new logging mechanism, is how a platform-dependent decision branch (in particular
// whether the win32 taskkill.exe tree-kill path below was engaged, and whether it completed
// without throwing) becomes observable to a caller that DOES own a log port. Mirrors the existing
// `onSpawn` seam immediately below: optional, never the command text/args/cwd/env/output.
// DEFINED in keiko-contracts, not here: keiko-server logs this shape and keiko-verification
// forwards it, so it is a cross-package contract and ADR-0019 puts those in the leaf. Re-exported
// so every existing importer keeps working unchanged (PR #3355 review).
export type {
  CommandTerminationEvidence,
  CommandTerminationReason,
} from "@oscharko-dev/keiko-contracts";

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

// Bound on how long ONE taskkill invocation may hold the event loop. taskkill normally completes in
// tens of milliseconds; the bound only caps a pathological hang, and expiring it reports "unknown"
// rather than guessing.
//
// Read the scope precisely — it is per invocation, NOT per process, and the difference is the whole
// cost model. `spawnSync` blocks the entire Node event loop, not just the run being terminated, and
// `terminate()` executes on that loop. Terminations therefore SERIALISE: cancelling N Windows
// commands in one tick can stall the host for up to N x TASKKILL_WAIT_MS, and the SIGKILL escalation
// can spend the bound a second time for the same run. During that stall `keiko-server` serves no
// other request. `WINDOWS_TASKKILL_BUDGET_MS` below caps the AGGREGATE across concurrent
// terminations; this constant only ever bounds one call.
//
// It is synchronous on purpose: taskkill must finish enumerating the live tree while cmd.exe still
// anchors it, and an async spawn would let `child.kill()` race it so a grandchild survives. An
// awaited async spawn could give the same ordering without blocking, but that requires making
// `terminate()`/`killGroup` async and rippling through every caller — a design decision, not a
// drive-by change.
const TASKKILL_WAIT_MS = 5000;

// Bounds the AGGREGATE event-loop stall every concurrent Windows termination in the current window
// can impose — TASKKILL_WAIT_MS above only ever bounds ONE invocation (see the comment there for
// why cancelling N commands in one tick can otherwise serialise to N x TASKKILL_WAIT_MS). Node is
// single-threaded and this counter is reserved/refunded synchronously around the blocking
// `spawnSync` call it guards, so no two updates can interleave — no mutex needed. Six full-timeout
// waits (30s) per 60s window: enough concurrent terminations in one tick to matter, while
// guaranteeing at least half of any window stays free for `keiko-server` to serve other requests.
// Fast calls refund their unused reservation, so ordinary cancellation bursts retain containment.
// The WHOLE budget refills when the window elapses — never per call — so a burst early in a
// long-running server does not permanently disable tree-kill enumeration.
const WINDOWS_TASKKILL_BUDGET_WINDOW_MS = 60_000;
const WINDOWS_TASKKILL_BUDGET_MS = 6 * TASKKILL_WAIT_MS;

export interface WindowsTaskkillBudget {
  // Attempts to spend one TASKKILL_WAIT_MS unit of the current window's budget. Returns false, and
  // spends nothing, once the window's budget is exhausted; the caller must not spawn taskkill in
  // that case (see nodeWindowsTreeKillWith below, which reports "budget-exhausted" instead).
  readonly tryConsume: () => boolean;
  // Returns the unused part of the full timeout reservation after the guarded synchronous call.
  // The input is clamped so a faulty clock or injected test seam cannot mint more than one window.
  readonly refund: (unusedMs: number) => void;
}

interface WindowsTaskkillBudgetReservation extends WindowsTaskkillBudget {
  readonly release: () => void;
}

interface WindowsTaskkillBudgetPool extends WindowsTaskkillBudget {
  readonly reserve: (slots: number) => WindowsTaskkillBudgetReservation | undefined;
}

interface WindowsTaskkillBudgetState {
  remainingMs: number;
  heldMs: number;
  directOutstanding: number;
  windowResetAt: number;
}

function refreshTaskkillBudgetWindow(state: WindowsTaskkillBudgetState, currentTime: number): void {
  if (currentTime < state.windowResetAt) return;
  const heldAndRunningMs = state.heldMs + state.directOutstanding * TASKKILL_WAIT_MS;
  state.remainingMs = Math.max(0, WINDOWS_TASKKILL_BUDGET_MS - heldAndRunningMs);
  state.windowResetAt = currentTime + WINDOWS_TASKKILL_BUDGET_WINDOW_MS;
}

function refundTaskkillBudgetToWindow(
  state: WindowsTaskkillBudgetState,
  currentTime: number,
  unusedMs: number,
): void {
  refreshTaskkillBudgetWindow(state, currentTime);
  const boundedRefund = Number.isFinite(unusedMs)
    ? Math.min(TASKKILL_WAIT_MS, Math.max(0, unusedMs))
    : 0;
  state.remainingMs = Math.min(
    WINDOWS_TASKKILL_BUDGET_MS - state.heldMs,
    state.remainingMs + boundedRefund,
  );
}

function reserveTaskkillBudget(
  state: WindowsTaskkillBudgetState,
  now: () => number,
  slots: number,
): WindowsTaskkillBudgetReservation | undefined {
  refreshTaskkillBudgetWindow(state, now());
  const reservedMs = slots * TASKKILL_WAIT_MS;
  if (!Number.isSafeInteger(slots) || slots <= 0 || state.remainingMs < reservedMs)
    return undefined;
  state.remainingMs -= reservedMs;
  state.heldMs += reservedMs;
  let availableSlots = slots;
  let inFlightSlots = 0;
  let released = false;
  return {
    tryConsume: (): boolean => {
      if (released || availableSlots <= 0) return false;
      availableSlots -= 1;
      inFlightSlots += 1;
      return true;
    },
    refund: (unusedMs): void => {
      if (inFlightSlots <= 0) return;
      refreshTaskkillBudgetWindow(state, now());
      inFlightSlots -= 1;
      state.heldMs -= TASKKILL_WAIT_MS;
      refundTaskkillBudgetToWindow(state, now(), unusedMs);
    },
    release: (): void => {
      if (released) return;
      released = true;
      while (availableSlots > 0) {
        refreshTaskkillBudgetWindow(state, now());
        availableSlots -= 1;
        state.heldMs -= TASKKILL_WAIT_MS;
        refundTaskkillBudgetToWindow(state, now(), TASKKILL_WAIT_MS);
      }
    },
  };
}

// `now` is injected — production uses the monotonic performance clock, tests move time without a
// real 60s wait — and
// each call to this factory returns a budget with its OWN private counter, never a shared module
// singleton. `nodeWindowsTreeKillWith` relies on exactly that: its own `budget` parameter defaults to
// a FRESH `createWindowsTaskkillBudget()` per factory call, so every test that calls
// `nodeWindowsTreeKillWith(...)` directly gets an isolated budget of its own — no shared mutable
// state bleeding between unrelated test cases (AGENTS.md §7). Production explicitly passes one
// process-lifetime instance to BOTH direct LSP kills and reserved runCommand kills below.
export function createWindowsTaskkillBudget(
  now: () => number = () => performance.now(),
): WindowsTaskkillBudgetPool {
  const state: WindowsTaskkillBudgetState = {
    remainingMs: WINDOWS_TASKKILL_BUDGET_MS,
    heldMs: 0,
    directOutstanding: 0,
    windowResetAt: now() + WINDOWS_TASKKILL_BUDGET_WINDOW_MS,
  };
  return {
    tryConsume: (): boolean => {
      refreshTaskkillBudgetWindow(state, now());
      if (state.remainingMs < TASKKILL_WAIT_MS) return false;
      state.remainingMs -= TASKKILL_WAIT_MS;
      state.directOutstanding += 1;
      return true;
    },
    refund: (unusedMs): void => {
      if (state.directOutstanding <= 0) return;
      refreshTaskkillBudgetWindow(state, now());
      state.directOutstanding -= 1;
      refundTaskkillBudgetToWindow(state, now(), unusedMs);
    },
    reserve: (slots) => reserveTaskkillBudget(state, now, slots),
  };
}

// Bounds the WHOLE Windows process tree rooted at `pid`, not just the immediate child. Before
// issue #3350's cmd.exe hardening, a `.cmd` target never spawned on win32 (Node CVE-2024-27980
// raised EINVAL), so the immediate child WAS the resolved target. Now the immediate child is
// always `cmd.exe` and the real work — e.g. `node.exe` running npm — is a grandchild that
// `child.kill()` cannot reach (ADR-0006 D5). `taskkill.exe` is an OS binary, resolved the same
// validated, never-PATH way cmd.exe is, so no new dependency is needed.
//
// SYNCHRONOUS on purpose (`spawnSync`), for two reasons the async form cannot deliver:
//  1. COMPLETION ORDER. killGroup signals the immediate child only after this returns, so taskkill
//     must have finished enumerating the live tree while cmd.exe still anchors it. An async spawn
//     merely schedules taskkill — child.kill() would race it and the grandchild could survive.
//  2. A VERIFIED RESULT. The exit status is observed, so "succeeded" means taskkill reported
//     success, "failed" means it could not run or reported failure (taskkill.exe absent on a
//     stripped-down image included), and "unknown" is only the bounded wait expiring. Nothing is
//     reported as success merely because dispatch did not throw.
// The event-loop cost of ONE call is bounded by TASKKILL_WAIT_MS; the AGGREGATE cost across
// concurrent terminations in the same window is separately bounded by WINDOWS_TASKKILL_BUDGET_MS
// above, and it is paid only on the termination path either way.
// Never throws: a hostile SystemRoot (resolveSystemBinaryPath fails closed) or a spawn failure
// reports "failed", keeping termination idempotent.
// The one seam this function needs to be testable off Windows. `nodeSpawnSync` is imported
// directly rather than injected through RunCommandDeps (unlike `killWindowsTree`, which test
// doubles already replace wholesale), so the 0 / 128 / other status branching below — the part that
// decides what a customer's log SAYS about a termination — had no way to be exercised at all. A
// default parameter keeps every production call site unchanged.
type TaskkillRunner = (
  command: string,
  args: readonly string[],
) => { readonly status: number | null; readonly error?: Error | undefined };

type TaskkillCompletion = ReturnType<TaskkillRunner>;
export type WindowsTaskkillInvocationResolver = typeof windowsTaskkillInvocation;
type WindowsTaskkillInvocation = ReturnType<WindowsTaskkillInvocationResolver>;

const defaultTaskkillRunner: TaskkillRunner = (command, args) => {
  const completed = nodeSpawnSync(command, [...args], {
    stdio: "ignore",
    windowsHide: true,
    timeout: TASKKILL_WAIT_MS,
  });
  return {
    status: completed.status,
    ...(completed.error === undefined ? {} : { error: completed.error }),
  };
};

function taskkillCompletionDisposition(completed: TaskkillCompletion): WindowsTreeKillResult {
  if (completed.error !== undefined) {
    const code = (completed.error as NodeJS.ErrnoException).code;
    return code === "ETIMEDOUT" ? "unknown" : "failed";
  }
  if (completed.status === 0) return "succeeded";
  // Exit 128 proves only that the requested ROOT pid was absent. A descendant may already have
  // outlived it, so the evidence stays factual and deliberately makes no tree-wide claim.
  return completed.status === 128 ? "root-not-found" : "failed";
}

function taskkillThrownDisposition(error: unknown): WindowsTreeKillResult {
  // Missing taskkill.exe is an operational host-image failure. A malformed/hostile SystemRoot is
  // a separate security disposition. Typed discrimination avoids coupling this boundary to
  // human-facing message text; unrelated errors remain ordinary failures.
  if (error instanceof WindowsSystemBinaryMissingError) return "failed";
  return error instanceof WindowsSystemDirectoryError ? "blocked-untrusted-system-root" : "failed";
}

function refundTaskkillReservation(
  budget: WindowsTaskkillBudget,
  startedAt: number,
  elapsedNow: () => number,
): void {
  const elapsedMs = elapsedNow() - startedAt;
  const boundedElapsedMs = Number.isFinite(elapsedMs)
    ? Math.min(TASKKILL_WAIT_MS, Math.max(0, elapsedMs))
    : TASKKILL_WAIT_MS;
  budget.refund(TASKKILL_WAIT_MS - boundedElapsedMs);
}

function runWindowsTreeKillUnbudgeted(
  pid: number,
  processEnv: NodeJS.ProcessEnv,
  runTaskkill: TaskkillRunner,
  resolveInvocation: WindowsTaskkillInvocationResolver,
): WindowsTreeKillResult {
  try {
    const { command, args } = resolveInvocation(pid, processEnv);
    return taskkillCompletionDisposition(runTaskkill(command, args));
  } catch (error) {
    return taskkillThrownDisposition(error);
  }
}

function runWithinTaskkillBudget(
  pid: number,
  budget: WindowsTaskkillBudget,
  elapsedNow: () => number,
  kill: () => WindowsTreeKillResult,
): WindowsTreeKillResult {
  if (isSelfOrParentPid(pid)) return "refused-self-pid";
  if (!budget.tryConsume()) return "budget-exhausted";
  const startedAt = elapsedNow();
  try {
    return kill();
  } finally {
    refundTaskkillReservation(budget, startedAt, elapsedNow);
  }
}

export const nodeWindowsTreeKillWith =
  (
    runTaskkill: TaskkillRunner,
    budget: WindowsTaskkillBudget = createWindowsTaskkillBudget(),
    elapsedNow: () => number = () => performance.now(),
    resolveInvocation: WindowsTaskkillInvocationResolver = windowsTaskkillInvocation,
  ): WindowsTreeKill =>
  (pid, processEnv) =>
    // The AGGREGATE bound: once this window's budget is spent, report "budget-exhausted" — the
    // accurate evidence for "we chose not to pay another blocking wait", never a guessed
    // "succeeded"/"failed" or a false claim that a launched taskkill timed out
    // — WITHOUT spawning taskkill at all, so a burst of concurrent terminations cannot serialise the
    // event loop past the budgeted ceiling.
    runWithinTaskkillBudget(pid, budget, elapsedNow, () =>
      runWindowsTreeKillUnbudgeted(pid, processEnv, runTaskkill, resolveInvocation),
    );

const productionWindowsTaskkillBudget = createWindowsTaskkillBudget();
export const nodeWindowsTreeKill: WindowsTreeKill = nodeWindowsTreeKillWith(
  defaultTaskkillRunner,
  productionWindowsTaskkillBudget,
);

export interface WindowsTerminationReservation {
  readonly kill: WindowsTreeKill;
  readonly release: () => void;
}

export interface WindowsTerminationCapacity {
  readonly reserve: (processEnv: NodeJS.ProcessEnv) => WindowsTerminationReservation | undefined;
}

const MAX_CONCURRENT_WINDOWS_COMMANDS = 3;
const TREE_KILLS_PER_RUN = 2;

function createBoundReservationKill(
  validatedInvocation: WindowsTaskkillInvocation | undefined,
  killWindowsTree: WindowsTreeKill | undefined,
  boundSystemEnv: NodeJS.ProcessEnv,
  runTaskkill: TaskkillRunner,
  budget: WindowsTaskkillBudget,
  elapsedNow: () => number,
): WindowsTreeKill {
  return (pid) =>
    runWithinTaskkillBudget(pid, budget, elapsedNow, () => {
      if (killWindowsTree !== undefined) {
        try {
          return killWindowsTree(pid, { ...boundSystemEnv });
        } catch {
          return "failed";
        }
      }
      if (validatedInvocation === undefined) return "failed";
      return taskkillCompletionDisposition(
        runTaskkill(validatedInvocation.command, ["/PID", String(pid), "/T", "/F"]),
      );
    });
}

function createTerminationReservation(
  killWindowsTree: WindowsTreeKill,
  releaseSlot: () => void,
): WindowsTerminationReservation {
  let released = false;
  return {
    kill: (pid, processEnv): WindowsTreeKillResult => {
      if (released) return "budget-exhausted";
      return killWindowsTree(pid, processEnv);
    },
    release: (): void => {
      if (released) return;
      released = true;
      releaseSlot();
    },
  };
}

// One Windows command can need taskkill twice (SIGTERM, then SIGKILL). Holding one of three slots
// for the full child lifetime makes capacity a PRE-spawn decision. The separate process-wide
// rolling budget below is shared with LSP termination and bounds the actual synchronous stall.
export function createWindowsTerminationCapacity(
  maxConcurrent: number = MAX_CONCURRENT_WINDOWS_COMMANDS,
  killWindowsTree?: WindowsTreeKill,
  resolveInvocation?: WindowsTaskkillInvocationResolver,
  runTaskkill: TaskkillRunner = defaultTaskkillRunner,
  budget: WindowsTaskkillBudgetPool = createWindowsTaskkillBudget(),
  elapsedNow: () => number = () => performance.now(),
): WindowsTerminationCapacity {
  let available = maxConcurrent;
  return {
    reserve: (processEnv): WindowsTerminationReservation | undefined => {
      if (available <= 0) return undefined;
      const boundSystemEnv: NodeJS.ProcessEnv = {
        ...(processEnv.SystemRoot === undefined ? {} : { SystemRoot: processEnv.SystemRoot }),
        ...(processEnv.WINDIR === undefined ? {} : { WINDIR: processEnv.WINDIR }),
      };
      // Authenticate the root against GLOBALROOT and prove taskkill is a regular OS binary before
      // admitting a child. The resulting conventional CreateProcess-compatible path is bound to
      // this reservation. Only the resolver inputs are copied: later mutation of deps.env cannot
      // turn an admitted child's kill path into a hostile-root refusal. PID-specific args are
      // rebuilt only when the reservation is consumed.
      const validatedInvocation =
        resolveInvocation?.(1, boundSystemEnv) ??
        (killWindowsTree === undefined ? windowsTaskkillInvocation(1, boundSystemEnv) : undefined);
      const killBudget = budget.reserve(TREE_KILLS_PER_RUN);
      if (killBudget === undefined) return undefined;
      const boundKill = createBoundReservationKill(
        validatedInvocation,
        killWindowsTree,
        boundSystemEnv,
        runTaskkill,
        killBudget,
        elapsedNow,
      );
      available -= 1;
      return createTerminationReservation(boundKill, () => {
        killBudget.release();
        available += 1;
      });
    },
  };
}

const productionWindowsTerminationCapacity = createWindowsTerminationCapacity(
  MAX_CONCURRENT_WINDOWS_COMMANDS,
  undefined,
  undefined,
  defaultTaskkillRunner,
  productionWindowsTaskkillBudget,
);

interface KillGroupDeps {
  readonly platform: NodeJS.Platform;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly killWindowsTree: WindowsTreeKill;
}

// Kills the whole process group on POSIX (negative pid) so orphaned grandchildren die too. On
// Windows, `child.kill()` still reaches only the immediate child (cmd.exe for a wrapped `.cmd`
// target — issue #3350), so `killWindowsTree` additionally bounds the whole tree via taskkill.
// Both branches are best-effort and swallow their own failures: termination must stay idempotent
// and must never throw, including when an injected `killWindowsTree` misbehaves. Returns the
// verified tree-kill disposition for the evidence line.
// A pid this process must NEVER signal, whatever a caller believes it holds.
//
// Reported from a customer's Windows machine: the UI starts, prints "listening on 127.0.0.1:1983",
// dies with NO error in the log, and a fresh pid repeats the cycle. A silent death with the process
// guards installed is not an exception — it is an external kill, and this is the one place the
// product issues one. Windows recycles pids aggressively, so a `taskkill /PID <pid> /T /F` aimed at
// a child that has already exited can land on whatever now holds that number — and `/T` takes the
// whole TREE, which on a recycled pid can include this server or its launcher. The crash loop then
// looks exactly like the report: no stack, no errorKind, just a new pid listening again.
//
// The `childExited` guards above make that window much narrower; this makes the worst outcome
// impossible rather than unlikely. Cheap, and it can only ever reject a signal that would have been
// suicide: a legitimate child is never this process, and never its parent.
export function isSelfOrParentPid(pid: number): boolean {
  if (pid === process.pid) return true;
  // `process.ppid` exists on every supported platform; guarded anyway so a stripped runtime cannot
  // turn a missing field into `undefined === pid`.
  return typeof process.ppid === "number" && pid === process.ppid;
}

function killGroup(
  child: ChildProcess,
  sig: NodeJS.Signals,
  deps: KillGroupDeps,
): WindowsTreeKillDisposition {
  const pid = child.pid;
  if (pid === undefined) {
    return "not-attempted";
  }
  if (isSelfOrParentPid(pid)) {
    return "refused-self-pid";
  }
  const posix = deps.platform !== "win32";
  if (posix) {
    try {
      process.kill(-pid, sig);
    } catch {
      // The group already exited; nothing to signal. Swallowing keeps termination idempotent.
    }
    return "not-attempted";
  }
  // ORDER IS LOAD-BEARING on Windows: the tree kill runs — to COMPLETION, nodeWindowsTreeKill is
  // synchronous — BEFORE the immediate child is signalled. `child.kill()` is TerminateProcess and
  // takes effect at once, while `taskkill /PID <pid> /T` resolves the descendant set from the LIVE
  // process table when it runs. Signal cmd.exe first and taskkill finds no such pid, terminates
  // nothing, and — because Windows does not reparent orphans — the `node.exe` grandchild survives
  // exactly the timeout/abort path this exists to bound. `nodeGroupKill` in keiko-server's
  // lspNodeAdapter holds the same ordering for the same reason.
  const disposition = ((): WindowsTreeKillResult => {
    try {
      return deps.killWindowsTree(pid, deps.processEnv);
    } catch {
      // Implementations should return, not throw (see the WindowsTreeKill contract); an injected
      // one that throws anyway is a tree-kill that did not run.
      return "failed";
    }
  })();
  try {
    // Fallback for the descendants taskkill could not reach (and the no-op when it reached all of
    // them): the immediate child is signalled either way.
    child.kill(sig);
  } catch {
    // The child already exited; nothing to signal. Swallowing keeps termination idempotent.
  }
  return disposition;
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
  // Node emits "spawn" only after the child process was created successfully. An "error" before
  // that event is a spawn failure and owns no live process; an "error" after it may leave the
  // child running, so ownership, HOME and termination timers must remain until "close".
  spawnConfirmed: boolean;
  timedOut: boolean;
  // The FIRST terminal trigger, set exactly once by terminate(). Later triggers are no-ops: they
  // must not re-signal an already-terminated tree, arm a second grace timer (whose orphaned
  // callback would taskkill a raw pid after settle), or rewrite the evidence/error class the first
  // trigger established.
  terminalReason: CommandTerminationReason | undefined;
  spawnCallbackError: Error | undefined;
  childProcessError: Error | undefined;
  timer: NodeJS.Timeout | undefined;
  graceTimer: NodeJS.Timeout | undefined;
  // The grace timer hands the raw-pid escalation to the check phase. This gives libuv one poll
  // phase to publish an exit observed while synchronous taskkill blocked the event loop, before we
  // decide whether that pid still belongs to this child.
  graceImmediate: NodeJS.Immediate | undefined;
  onAbort: (() => void) | undefined;
  // The ephemeral HOME dir to remove once after the command settles, and the provider that owns
  // its removal. `homeCleaned` makes the cleanup idempotent (close AND error both call cleanup()).
  home: HomeProvider | undefined;
  homeDir: string | undefined;
  homeCleaned: boolean;
  windowsTerminationReservation: WindowsTerminationReservation | undefined;
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
  // `credentials-only` narrows the set to credential values (by governed name, credential-shaped
  // name and the policy's own list) for the one read whose stdout is the value the caller needs;
  // every other policy keeps the fail-closed default of scrubbing every non-allowlisted value.
  const secrets =
    deps.policy.outputScrub === "credentials-only"
      ? collectCredentialLikeEnvValues(deps.processEnv, deps.policy.credentialEnvAllowlist ?? [])
      : [
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
  if (state.graceImmediate !== undefined) {
    clearImmediate(state.graceImmediate);
  }
  if (state.onAbort !== undefined) {
    signal.removeEventListener("abort", state.onAbort);
  }
  state.windowsTerminationReservation?.release();
  // Remove the ephemeral HOME exactly once, on whichever settle path fires first (C5).
  if (!state.homeCleaned && state.home !== undefined && state.homeDir !== undefined) {
    state.homeCleaned = true;
    state.home.cleanup(state.homeDir);
  }
}

// Reports THE termination decision to the optional onTerminated seam — exactly once per
// terminated run (terminate() is single-flight), never on a clean exit. Fires from the initial
// BOTH termination steps — the initial SIGTERM and, since the escalation gained its own evidence
// line, the later SIGKILL. (This comment said "SIGTERM step only" until that second call site was
// added and it was not updated with it.) The win32 tree-kill disposition is already
// verified there (nodeWindowsTreeKill completes synchronously). A callback failure must never
// break termination — the same swallow-and-continue contract killGroup itself already holds for a
// misbehaving killWindowsTree.
function reportTermination(
  input: RunCommandInput,
  deps: RunCommandDeps,
  reason: CommandTerminationReason,
  childPid: number | undefined,
  windowsTreeKill: WindowsTreeKillDisposition,
  escalation?: WindowsTreeKillDisposition,
): void {
  const onTerminated = input.onTerminated ?? deps.onTerminated;
  if (childPid === undefined || onTerminated === undefined) {
    return;
  }
  try {
    // Conditional spread, not `escalation: undefined`: exactOptionalPropertyTypes distinguishes an
    // absent key from an explicit undefined, and the SIGTERM line must carry no key at all.
    onTerminated({
      reason,
      childPid,
      windowsTreeKill,
      ...(escalation === undefined ? {} : { escalation }),
    });
  } catch {
    // See the contract above: an evidence callback failure must never break termination.
  }
}

// The child has verifiably left the process table (or this run has settled). Guards the SIGKILL
// escalation: signalling a RAW pid after the handle is released is exactly the reused-pid hazard
// ADR-0006 D5 rules out, so an escalation that can no longer act on the original process must not
// act at all. `!= null` (not `!== null`) so a test double without exitCode/signalCode fields
// counts as still-running rather than as exited.
function childExited(child: ChildProcess, state: RunState): boolean {
  return state.settled || child.exitCode != null || child.signalCode != null;
}

// Makes the SIGKILL escalation eligible terminationGraceMs after the trigger. The timer is armed
// before the synchronous Windows tree-kill so that blocking work cannot silently shift the grace
// deadline later; its callback necessarily runs once the event loop is available again.
// SINGLE-FLIGHT: only the first
// trigger acts. Competing triggers (abort vs timeout vs output-cap vs a spawn-callback failure)
// previously each re-signalled the tree and re-armed the grace timer, overwriting the tracked
// handle — cleanup() then cleared only the LAST timer and the orphaned earlier one fired
// `taskkill /T /F` against a raw pid AFTER the run had settled and Node had released the handle
// keeping that pid reserved. Returns true when this call became the terminal trigger.
function terminate(
  child: ChildProcess,
  deps: RunCommandDeps,
  state: RunState,
  input: RunCommandInput,
  reason: CommandTerminationReason,
): boolean {
  if (state.settled || state.terminalReason !== undefined) {
    return false;
  }
  state.terminalReason = reason;
  // Disarm the competing triggers now that the terminal cause is fixed: the timeout timer must not
  // later rewrite an abort into CommandTimeoutError, and the abort listener must not re-enter.
  if (state.timer !== undefined) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  if (state.onAbort !== undefined) {
    input.signal.removeEventListener("abort", state.onAbort);
    state.onAbort = undefined;
  }
  const killDeps: KillGroupDeps = {
    platform: deps.platform ?? process.platform,
    processEnv: deps.processEnv,
    killWindowsTree:
      deps.killWindowsTree ?? state.windowsTerminationReservation?.kill ?? nodeWindowsTreeKill,
  };
  state.graceTimer = setTimeout(() => {
    // taskkill is synchronous. If it occupied the event loop past this deadline, Windows may have
    // completed the child and queued libuv's exit notification while the timer was also overdue.
    // A direct timer callback would run before the poll phase can update exitCode/signalCode, then
    // taskkill the now-unowned raw pid a second time. Handoff to the check phase so that queued
    // process-exit work is observed first; the identity guard is re-evaluated only there.
    state.graceImmediate = setImmediate(() => {
      state.graceImmediate = undefined;
      if (childExited(child, state)) {
        return;
      }
      // Report the escalation's OWN verified disposition. Dropping it left the one step that only
      // runs when the child ignored SIGTERM with no evidence at all.
      const escalated = killGroup(child, "SIGKILL", killDeps);
      reportTermination(input, deps, reason, child.pid, escalated, escalated);
    });
    state.graceImmediate.unref();
  }, deps.policy.terminationGraceMs);
  state.graceTimer.unref();
  // The SAME guard the SIGKILL escalation below carries, and for the same reason — it was missing
  // here. `state.settled` is set at 'close', but Node releases the child handle at 'exit', and
  // 'data' events keep arriving in the window between the two. An output-cap trigger firing in that
  // window reached this line with a pid Node no longer holds reserved, so a `taskkill /PID <pid> /T
  // /F` could land on a REUSED pid — some unrelated process on the customer's machine. ADR-0006 D5
  // called that hazard unreachable on the strength of the held handle; the escalation path needed
  // this check to make that true, and this path needs it just as much.
  // The evidence line is still emitted: "not-attempted" records that termination ran and
  // deliberately did not signal, which is a different fact from a tree-kill that failed.
  const disposition = childExited(child, state)
    ? "not-attempted"
    : killGroup(child, "SIGTERM", killDeps);
  reportTermination(input, deps, reason, child.pid, disposition);
  return true;
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

function settleClosedChild(
  ctx: ExecContext,
  code: number | null,
  signalName: NodeJS.Signals | null,
  resolve: (r: CommandResult) => void,
  reject: (e: unknown) => void,
): void {
  if (ctx.state.settled) return;
  ctx.state.settled = true;
  cleanup(ctx.state, ctx.input.signal);
  if (ctx.state.spawnCallbackError !== undefined) {
    reject(ctx.state.spawnCallbackError);
    return;
  }
  if (ctx.state.childProcessError !== undefined) {
    reject(ctx.state.childProcessError);
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
}

function settleChildProcessError(
  ctx: ExecContext,
  error: Error,
  reject: (e: unknown) => void,
): void {
  if (ctx.state.settled) return;
  if (!ctx.state.spawnConfirmed) {
    ctx.state.settled = true;
    cleanup(ctx.state, ctx.input.signal);
    reject(ctx.state.spawnCallbackError ?? error);
    return;
  }
  // A ChildProcess can emit "error" after a successful "spawn". That is not proof of exit: keep
  // the handle and ephemeral HOME, request bounded termination once, and settle only on "close".
  if (ctx.state.terminalReason === undefined) {
    ctx.state.childProcessError = error;
    terminate(ctx.child, ctx.deps, ctx.state, ctx.input, "child-process-error");
  }
}

function settleOnClose(
  ctx: ExecContext,
  resolve: (r: CommandResult) => void,
  reject: (e: unknown) => void,
): void {
  ctx.child.on("close", (code, signalName) => {
    settleClosedChild(ctx, code, signalName, resolve, reject);
  });
  ctx.child.once("spawn", () => {
    ctx.state.spawnConfirmed = true;
  });
  ctx.child.on("error", (error) => {
    settleChildProcessError(ctx, error, reject);
  });
}

function timeoutOf(ctx: ExecContext): number {
  return ctx.input.timeoutMs ?? ctx.deps.policy.defaultTimeoutMs;
}

function armTimersAndAbort(ctx: ExecContext): void {
  const ms = timeoutOf(ctx);
  ctx.state.timer = setTimeout(() => {
    // timedOut is set only when timeout actually became the terminal trigger — a timer that lost
    // the single-flight race must not turn an abort's rejection into CommandTimeoutError.
    if (terminate(ctx.child, ctx.deps, ctx.state, ctx.input, "timeout")) {
      ctx.state.timedOut = true;
    }
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

function createRunState(
  home: HomeProvider | undefined,
  homeDir: string | undefined,
  windowsTerminationReservation: WindowsTerminationReservation | undefined,
): RunState {
  return {
    settled: false,
    spawnConfirmed: false,
    timedOut: false,
    terminalReason: undefined,
    spawnCallbackError: undefined,
    childProcessError: undefined,
    timer: undefined,
    graceTimer: undefined,
    graceImmediate: undefined,
    onAbort: undefined,
    home,
    homeDir,
    homeCleaned: false,
    windowsTerminationReservation,
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
function applyHomeIsolation(
  env: Record<string, string>,
  deps: RunCommandDeps,
  reservation: WindowsTerminationReservation | undefined,
): RunState {
  if (deps.policy.homeIsolation === "inherit") {
    const inherited = inheritedHome(env);
    if (inherited !== undefined) {
      env.HOME = inherited;
      env.USERPROFILE = inherited;
      return createRunState(undefined, undefined, reservation);
    }
  }
  const home = deps.home ?? nodeHomeProvider;
  const homeDir = home.make();
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  return createRunState(home, homeDir, reservation);
}

function reserveWindowsTermination(
  input: RunCommandInput,
  deps: RunCommandDeps,
): WindowsTerminationReservation | undefined {
  if ((deps.platform ?? process.platform) !== "win32" || deps.killWindowsTree !== undefined) {
    return undefined;
  }
  const reservation = (
    deps.windowsTerminationCapacity ?? productionWindowsTerminationCapacity
  ).reserve(deps.processEnv);
  if (reservation === undefined) {
    throw new CommandDeniedError("Windows termination capacity exhausted", input.command);
  }
  return reservation;
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
    const reservation = reserveWindowsTermination(input, deps);
    let state: RunState;
    try {
      state = applyHomeIsolation(env, deps, reservation);
    } catch (error) {
      reservation?.release();
      throw error;
    }
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
