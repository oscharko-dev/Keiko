// Shared macOS Keychain key tier [GEN-MAINT-COUPLING-006]. Two vault surfaces — the MemoriaViva
// memory vault (keiko-memory-vault/src/cipher.ts) and the Figma PAT vault
// (keiko-server .../figmaTokenStore.ts) — each carried a byte-identical private copy of the
// find→use / generate→store `security` CLI pair, down to the same unbounded spawn. They now share
// this single owner so the bound below cannot drift between them, and so a third copy inherits it.
//
// Why the spawn is bounded. Both copies documented the same intent — "any failure (no `security`
// binary, locked keychain, non-darwin) falls through to the keyfile tier rather than bricking the
// vault" — and their try/catch delivered exactly that for a FAILURE. It does not deliver it for a
// PROMPT. When the login keychain is locked, absent, or withheld by policy, the macOS Security
// framework raises a modal dialog instead of returning an error, and an unbounded spawn waits for
// a human indefinitely. Vault key resolution sits on Keiko's boot path, so that is a start that
// hangs forever with no log line and no visible error — observed during the 0.3.0 release
// rehearsal against the shipped portable app. A documented fallback only helps if the call returns.
//
// keiko-security depends only on keiko-contracts and is depended upon by both surfaces, so hoisting
// this module here introduces no dependency cycle.

import { execFileSync } from "node:child_process";

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  emitSecurityLogEvent,
  securityErrorKind,
  startSecurityLogTimer,
  type SecurityLogSink,
} from "./log-port.js";

export const MACOS_SECURITY_EXECUTABLE = "/usr/bin/security";

const SECURITY_KEYCHAIN_FALLBACK_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.keychain.fallback",
  category: "security",
  owner: "keiko-security",
  emitter: "macos-keychain.emitKeychainFallback",
  fields: {
    boundedExitKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["timeout", "signal", "exit-status", "spawn-error", "unknown"],
    },
    reasonKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["security-keychain-access"],
  proofIds: ["security.keychain.fallback.bounded-exit"],
  releaseImpact: "patch",
});

const SECURITY_KEYCHAIN_WITHHELD_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.keychain.withheld",
  category: "security",
  owner: "keiko-security",
  emitter: "macos-keychain.emitKeychainWithheld",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["test-process", "operator-off"],
    },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["security-keychain-access"],
  proofIds: ["security.keychain.withheld.line"],
  releaseImpact: "patch",
});

/**
 * Generous next to a healthy `security` call, which answers in tens of milliseconds, and short next
 * to a person deciding whether to unlock a keychain. The tier is an optimisation over the keyfile
 * tier, never a requirement, so waiting longer buys nothing.
 */
export const KEYCHAIN_SPAWN_TIMEOUT_MS = 2_000;

/**
 * The login keychain is machine-wide state shared with every real Keiko on the machine. A test that
 * opens a vault without an injected key would read that installation's key or store another, and a
 * home without a keychain makes macOS raise a modal on the person's desktop. No test needs it, so a
 * process under vitest never gets it, whatever its configuration. A lane that starts a whole product
 * process says so with `KEIKO_OS_KEYCHAIN=off`, in the process environment or in the environment it
 * hands a vault. The tier then answers like a platform without one and the keyfile tier takes over,
 * which is weaker custody and cannot open data sealed under a keychain key, so the choice is logged.
 * A fake `executable` is unaffected.
 */
export type KeychainWithheldReason = "test-process" | "operator-off";

type EnvironmentView = Readonly<Record<string, string | undefined>>;

function withheldBy(env: EnvironmentView): KeychainWithheldReason | undefined {
  if (env.VITEST !== undefined) return "test-process";
  return env.KEIKO_OS_KEYCHAIN === "off" ? "operator-off" : undefined;
}

export function keychainWithheldReason(
  env: EnvironmentView = process.env,
): KeychainWithheldReason | undefined {
  return withheldBy(process.env) ?? withheldBy(env);
}

export function realKeychainWithheld(env: EnvironmentView = process.env): boolean {
  return keychainWithheldReason(env) !== undefined;
}

export function emitKeychainWithheld(
  sink: SecurityLogSink | undefined,
  reason: KeychainWithheldReason,
): void {
  emitSecurityLogEvent(
    sink,
    activityLogEvent(SECURITY_KEYCHAIN_WITHHELD_OPERATION, {}, { reason }),
  );
}

export interface MacosKeychainOptions {
  /** Test seam. Production always uses the fixed system path. */
  readonly executable?: string | undefined;
  /** Test seam. Production always uses {@link KEYCHAIN_SPAWN_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Test seam, so the tier's behaviour is assertable on a non-darwin host. */
  readonly platform?: NodeJS.Platform | undefined;
  /** The environment the vault was handed, which can withhold the real keychain. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * Activity-log seam (ADR-0019; see `log-port.ts`). A spawn failure that
   * collapses to `{ kind: "unavailable" }` emits one `security.keychain.fallback` event instead of
   * discarding the OS error silently — the gap the 0.3.0 boot-hang incident (see file header)
   * exposed: the tier now returns in time, but still logged nothing about WHY it fell back.
   * Required: a caller names where the line goes (a seam passes the null sink), so a locked,
   * unavailable or withheld keychain can never be lost as an unwired port.
   */
  readonly sink: SecurityLogSink;
  /**
   * Test seam. Production reads of the real `security` binary use the process memo below; a fake
   * `executable` gets no memo unless a test hands one in.
   */
  readonly memo?: KeychainSecretMemo | undefined;
}

/**
 * Secrets this process has already read from the keychain, by service and account.
 *
 * A key item in the login keychain does not change while Keiko runs: Keiko writes one only when
 * none exists or the stored value cannot be decoded, and a person does not rotate it underneath a
 * running process. Yet every vault open resolved its key again, so one Chat window or one setup
 * step spawned `security` for the same item several times, each a fresh keychain access request.
 * The memo answers repeats from memory. It holds only values a read actually returned: a write
 * forgets the item instead of remembering what it wrote, so two processes racing to create the
 * first key both read the stored winner on their next open, and a replaced undecodable value is
 * never served again. Failures are never remembered, and the withheld check runs before the memo,
 * so `KEIKO_OS_KEYCHAIN=off` still takes effect.
 */
export interface KeychainSecretMemo {
  readonly get: (service: string, account: string) => string | undefined;
  readonly remember: (service: string, account: string, secret: string) => void;
  readonly forget: (service: string, account: string) => void;
}

export function createKeychainSecretMemo(): KeychainSecretMemo {
  const secrets = new Map<string, string>();
  const keyOf = (service: string, account: string): string => `${service}\u0000${account}`;
  return {
    get: (service, account) => secrets.get(keyOf(service, account)),
    remember: (service, account, secret): void => {
      secrets.set(keyOf(service, account), secret);
    },
    forget: (service, account): void => {
      secrets.delete(keyOf(service, account));
    },
  };
}

/** The memo every read of the real login keychain in this process shares. */
export const processKeychainSecretMemo: KeychainSecretMemo = createKeychainSecretMemo();

function memoFor(
  spawn: ResolvedSpawn,
  options: MacosKeychainOptions,
): KeychainSecretMemo | undefined {
  if (options.memo !== undefined) return options.memo;
  return spawn.executable === MACOS_SECURITY_EXECUTABLE ? processKeychainSecretMemo : undefined;
}

/**
 * `absent` and `unavailable` are deliberately distinct. `absent` is the ordinary first-run case —
 * no such item yet — and the caller should try to store one. `unavailable` means the keychain
 * itself did not answer, so a write would meet the same wall and must not spend a second timeout.
 */
export type MacosKeychainRead =
  | { readonly kind: "found"; readonly secret: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" };

function positiveTimeout(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface ResolvedSpawn {
  readonly darwin: boolean;
  readonly withheld: KeychainWithheldReason | undefined;
  readonly executable: string;
  readonly timeout: number;
  readonly killSignal: "SIGKILL";
}

// One place resolves every default, so the read and the write cannot drift apart and a caller
// supplying no options is exercising exactly the production configuration.
function resolveSpawn(options: MacosKeychainOptions): ResolvedSpawn {
  const executable = options.executable ?? MACOS_SECURITY_EXECUTABLE;
  return {
    darwin: (options.platform ?? process.platform) === "darwin",
    withheld:
      executable === MACOS_SECURITY_EXECUTABLE ? keychainWithheldReason(options.env) : undefined,
    executable,
    // Only a positive finite override is honoured. `execFileSync` reads `timeout: 0` as "no
    // timeout", so accepting a caller's 0 would silently restore the unbounded spawn this module
    // exists to prevent — a bound that any caller can switch off is not a bound.
    timeout: positiveTimeout(options.timeoutMs) ?? KEYCHAIN_SPAWN_TIMEOUT_MS,
    // SIGKILL rather than SIGTERM: a process blocked in a system modal is exactly the case that may
    // not act on a catchable signal, and this tier has no cleanup to run.
    killSignal: "SIGKILL",
  };
}

// `security` exits 44 (errSecItemNotFound) when the item simply is not there. Measured against the
// shipped binary, alongside 2 for a malformed invocation and 1 for an unknown subcommand.
const ITEM_NOT_FOUND_STATUS = 44;

/**
 * True only for `security`'s "the item could not be found" status. Exported because the third
 * keychain surface in this package (`secret-vault.ts`) keeps its own injectable command runner and
 * must apply the same rule at its own catch site — a shared predicate rather than a second copy of
 * the number.
 */
export function keychainItemNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === ITEM_NOT_FOUND_STATUS
  );
}

// Only "the item is not there" invites a write. Everything else — a locked or denied keychain, a
// policy refusal, a missing binary, a timeout — means the keychain did not answer, and a write
// would meet the same wall and spend a second bounded wait on the boot path for nothing.
//
// This deliberately keys on the one status that means "absent" rather than trying to enumerate the
// failures that mean "unavailable": a keychain can refuse immediately, without a timeout, and an
// enumeration would have to grow to keep catching that. A timed-out spawn carries a null status and
// lands here as unavailable for the same reason every other non-44 outcome does.
function readOutcome(error: unknown): MacosKeychainRead {
  return keychainItemNotFound(error) ? { kind: "absent" } : { kind: "unavailable" };
}

// Structural classification of HOW the bounded spawn ended, read from the same properties Node's
// `execFileSync` sets on a `spawnSync`-family failure — never from `message`, which can carry the
// resolved executable path. `"timeout"` is the one value an operator should treat as a recurrence
// of the 0.3.0 boot-hang incident (file header): the keychain did not answer inside the bound and
// had to be killed, exactly the shape a blocking OS modal produces. Closed vocabulary, verified
// against the shipped `execFileSync` error shape for a killed timeout, a plain non-zero exit, and a
// missing executable (ENOENT).
type BoundedExitKind = "timeout" | "signal" | "exit-status" | "spawn-error" | "unknown";

function classifyBoundedExit(error: unknown): BoundedExitKind {
  if (typeof error !== "object" || error === null) return "unknown";
  const e = error as { code?: unknown; signal?: unknown; status?: unknown };
  if (e.code === "ETIMEDOUT") return "timeout";
  if (typeof e.signal === "string") return "signal";
  if (typeof e.status === "number") return "exit-status";
  if (typeof e.code === "string") return "spawn-error";
  return "unknown";
}

// Exported so the sibling keychain surface in `secret-vault.ts` — which spawns `security` through
// its own injectable `KeychainCommandRunner` rather than calling `readMacosKeychainSecret` — can
// report the identical `security.keychain.fallback` shape instead of growing a second copy of the
// classification logic [GEN-MAINT-COUPLING-006].
export function emitKeychainFallback(
  sink: SecurityLogSink | undefined,
  error: unknown,
  elapsedMs: () => number,
): void {
  const boundedExitKind = classifyBoundedExit(error);
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      SECURITY_KEYCHAIN_FALLBACK_OPERATION,
      {
        level: "warn",
        errorKind: boundedExitKind === "timeout" ? "timeout" : "unavailable",
        durationMs: elapsedMs(),
      },
      {
        reasonKind: securityErrorKind(error),
        boundedExitKind,
      },
    ),
  );
}

/** Reads the generic password for `service`/`account`. Never throws. */
export function readMacosKeychainSecret(
  service: string,
  account: string,
  options: MacosKeychainOptions,
): MacosKeychainRead {
  const spawn = resolveSpawn(options);
  if (!spawn.darwin) return { kind: "unavailable" };
  if (spawn.withheld !== undefined) {
    emitKeychainWithheld(options.sink, spawn.withheld);
    return { kind: "unavailable" };
  }
  const memo = memoFor(spawn, options);
  const remembered = memo?.get(service, account);
  if (remembered !== undefined) return { kind: "found", secret: remembered };
  const elapsedMs = startSecurityLogTimer();
  try {
    const secret = execFileSync(
      spawn.executable,
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: spawn.timeout,
        killSignal: spawn.killSignal,
      },
    ).trim();
    memo?.remember(service, account, secret);
    return { kind: "found", secret };
  } catch (error) {
    const outcome = readOutcome(error);
    if (outcome.kind === "unavailable") emitKeychainFallback(options.sink, error, elapsedMs);
    return outcome;
  }
}

/**
 * Spawn options that start `security` in a session of its own, without a controlling terminal.
 *
 * `security` asks for a password with `getpass`, which reads the controlling terminal before
 * stdin. Launched from a terminal in the foreground, a write would wait there for a person instead
 * of reading the piped key, time out, and leave the caller on its weaker key tier; a later detached
 * launch could then create a different keychain key and prefer it. On POSIX, `detached` makes the
 * child a session leader (`setsid`), so it has no terminal to read. Node's synchronous spawns honour
 * the option (measured on Node 24 and 26: the child leads its own process group), though their type
 * declarations omit it, hence a spread rather than a literal property.
 */
export const KEYCHAIN_SPAWN_WITHOUT_TERMINAL: { readonly detached: true } = Object.freeze({
  detached: true,
});

/**
 * Stores `secret` as the generic password for `service`/`account`. Never throws; `false` means the
 * caller must fall through to its next key tier.
 */
export function writeMacosKeychainSecret(
  service: string,
  account: string,
  secret: string,
  options: MacosKeychainOptions,
): boolean {
  const spawn = resolveSpawn(options);
  if (!spawn.darwin || spawn.withheld !== undefined) return false;
  // Forgotten before the write, not after: whatever the write's outcome, the next read must ask
  // the keychain what it now holds rather than serve the value this write meant to replace.
  memoFor(spawn, options)?.forget(service, account);
  try {
    // The secret goes over stdin, never in the argument vector: `ps` exposes a process's arguments
    // to every process of the same user, which is precisely the audience this tier exists to keep
    // the key away from. Bare `-w` makes `security` read the value, and it asks for it twice —
    // measured against the shipped binary, which prompts "password data" then "retype password"
    // and refuses on a mismatch. A piped stdin satisfies both reads without a terminal, so this
    // does not reintroduce the interactive wait the timeout above exists to bound.
    // `-U` updates an existing item. Without it `security` rejects a duplicate with status 45, so
    // the documented "replace a stored value that does not decode" path would report failure and
    // fall through to the weaker keyfile tier instead of ever replacing anything. Measured against
    // the shipped binary: a second add without `-U` exits 45; with `-U` it exits 0 and the stored
    // value really changes.
    execFileSync(
      spawn.executable,
      ["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
      {
        input: `${secret}\n${secret}\n`,
        stdio: ["pipe", "ignore", "ignore"],
        ...KEYCHAIN_SPAWN_WITHOUT_TERMINAL,
        timeout: spawn.timeout,
        killSignal: spawn.killSignal,
      },
    );
    return true;
  } catch {
    return false;
  }
}
