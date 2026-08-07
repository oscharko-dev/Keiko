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
    timeout: options.timeoutMs ?? KEYCHAIN_SPAWN_TIMEOUT_MS,
    // SIGKILL rather than SIGTERM: a process blocked in a system modal is exactly the case that may
    // not act on a catchable signal, and this tier has no cleanup to run.
    killSignal: "SIGKILL",
  };
}

// `ETIMEDOUT` is Node's own marker for a spawn its timeout terminated. Measured rather than assumed:
// on a timed-out execFileSync the thrown error carries `code: "ETIMEDOUT"` while `killed` is
// undefined and `status` is null, so neither of those is usable here. A refused call (a keychain
// answering "no such item") carries an exit status and no such code, which is the distinction the
// caller depends on.
function killedByTimeout(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "ETIMEDOUT"
  );
}

/** Reads the generic password for `service`/`account`. Never throws. */
export function readMacosKeychainSecret(
  service: string,
  account: string,
  options: MacosKeychainOptions = {},
): MacosKeychainRead {
  const spawn = resolveSpawn(options);
  if (!spawn.darwin) return { kind: "unavailable" };
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
    return killedByTimeout(error) ? { kind: "unavailable" } : { kind: "absent" };
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
    execFileSync(
      spawn.executable,
      ["add-generic-password", "-s", service, "-a", account, "-w", secret],
      {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: spawn.timeout,
        killSignal: spawn.killSignal,
      },
    );
    return true;
  } catch {
    return false;
  }
}
