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
  emitSecurityLogEvent,
  securityErrorKind,
  startSecurityLogTimer,
  type SecurityLogSink,
} from "./log-port.js";

const MACOS_SECURITY_EXECUTABLE = "/usr/bin/security";

/**
 * Generous next to a healthy `security` call, which answers in tens of milliseconds, and short next
 * to a person deciding whether to unlock a keychain. The tier is an optimisation over the keyfile
 * tier, never a requirement, so waiting longer buys nothing.
 */
export const KEYCHAIN_SPAWN_TIMEOUT_MS = 2_000;

export interface MacosKeychainOptions {
  /** Test seam. Production always uses the fixed system path. */
  readonly executable?: string | undefined;
  /** Test seam. Production always uses {@link KEYCHAIN_SPAWN_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Test seam, so the tier's behaviour is assertable on a non-darwin host. */
  readonly platform?: NodeJS.Platform | undefined;
  /**
   * Optional activity-log seam (ADR-0019; see `log-port.ts`). When wired, a spawn failure that
   * collapses to `{ kind: "unavailable" }` emits one `security.keychain.fallback` event instead of
   * discarding the OS error silently — the gap the 0.3.0 boot-hang incident (see file header)
   * exposed: the tier now returns in time, but still logged nothing about WHY it fell back.
   * Omitted or `undefined` keeps this tier exactly as silent as before.
   */
  readonly sink?: SecurityLogSink | undefined;
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
  readonly executable: string;
  readonly timeout: number;
  readonly killSignal: "SIGKILL";
}

// One place resolves every default, so the read and the write cannot drift apart and a caller
// supplying no options is exercising exactly the production configuration.
function resolveSpawn(options: MacosKeychainOptions): ResolvedSpawn {
  return {
    darwin: (options.platform ?? process.platform) === "darwin",
    executable: options.executable ?? MACOS_SECURITY_EXECUTABLE,
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
function classifyBoundedExit(error: unknown): string {
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
  emitSecurityLogEvent(sink, {
    level: "warn",
    category: "security",
    op: "security.keychain.fallback",
    durationMs: elapsedMs(),
    extra: {
      reasonKind: securityErrorKind(error),
      boundedExitKind: classifyBoundedExit(error),
    },
  });
}

/** Reads the generic password for `service`/`account`. Never throws. */
export function readMacosKeychainSecret(
  service: string,
  account: string,
  options: MacosKeychainOptions = {},
): MacosKeychainRead {
  const spawn = resolveSpawn(options);
  if (!spawn.darwin) return { kind: "unavailable" };
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
    return { kind: "found", secret };
  } catch (error) {
    const outcome = readOutcome(error);
    if (outcome.kind === "unavailable") emitKeychainFallback(options.sink, error, elapsedMs);
    return outcome;
  }
}

/**
 * Stores `secret` as the generic password for `service`/`account`. Never throws; `false` means the
 * caller must fall through to its next key tier.
 */
export function writeMacosKeychainSecret(
  service: string,
  account: string,
  secret: string,
  options: MacosKeychainOptions = {},
): boolean {
  const spawn = resolveSpawn(options);
  if (!spawn.darwin) return false;
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
        timeout: spawn.timeout,
        killSignal: spawn.killSignal,
      },
    );
    return true;
  } catch {
    return false;
  }
}
