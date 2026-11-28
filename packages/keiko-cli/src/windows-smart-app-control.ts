import { spawnSync } from "node:child_process";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { resolveWindowsSystemBinary, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import { emitCliWindowsSystemFailure } from "./security-log.js";

/**
 * The state of Windows 11 Smart App Control, read when a portable start fails (#4569). Smart App
 * Control enforces signing and cloud reputation with no per-file override, so a start it blocks
 * cannot be fixed by "Run anyway" the way a SmartScreen prompt can. Keiko's own native helpers are
 * not signed yet, so with Smart App Control on the start can fail on a file Windows refuses to run
 * or load. Naming that cause is the only remedy Keiko can offer on its own.
 *
 * `on` is enforcement, `evaluation` the learning mode in which nothing is blocked yet, `off` the
 * state Windows does not let a person leave again without a reset, `unknown` a state that could not
 * be read, and `not-windows` every other platform.
 */
export const SMART_APP_CONTROL_STATES = [
  "on",
  "evaluation",
  "off",
  "unknown",
  "not-windows",
] as const;

export type SmartAppControlState = (typeof SMART_APP_CONTROL_STATES)[number];

const POLICY_KEY = String.raw`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`;
const POLICY_VALUE = "VerifiedAndReputablePolicyState";
const REG_QUERY_TIMEOUT_MS = 5000;
const DWORD_VALUE = /^0x[0-9a-f]{1,8}$/iu;

// The value line is exactly three whitespace-separated tokens: the name, its type and the hex value.
// Read by tokens, not by one pattern over the whole output, so the cost stays linear in its length.
function policyDwordText(output: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length !== 3 || tokens[0] !== POLICY_VALUE || tokens[1] !== "REG_DWORD") continue;
    const hex = tokens[2];
    if (hex !== undefined && DWORD_VALUE.test(hex)) return hex;
  }
  return undefined;
}

/**
 * Reads the policy state from the output of `reg query <key> /v VerifiedAndReputablePolicyState`.
 * Only the exact value line counts; any other output, including a value this version does not
 * know, is `unknown`.
 */
export function smartAppControlStateFromRegQuery(output: string): SmartAppControlState {
  const hex = policyDwordText(output);
  if (hex === undefined) return "unknown";
  const value = Number.parseInt(hex.slice(2), 16);
  if (value === 0) return "off";
  if (value === 1) return "on";
  if (value === 2) return "evaluation";
  return "unknown";
}

export type RegQueryFn = (executable: string, args: readonly string[]) => string | undefined;

function defaultRegQuery(executable: string, args: readonly string[]): string | undefined {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: REG_QUERY_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : undefined;
}

export type RegExecutableFn = (env: EnvSource) => string;

// The system's own reg.exe through the one trusted System32 decision (#4408), never a `reg` found on
// PATH or in the start folder. A refused system root or a missing reg.exe throws the resolver's own
// typed error, which the caller records on its log port.
function trustedRegExecutable(env: EnvSource): string {
  return resolveWindowsSystemBinary("reg.exe", env);
}

/** Reads the Smart App Control state; a failed query is `unknown`. */
export function readSmartAppControlState(
  platform: NodeJS.Platform,
  env: EnvSource,
  regQuery: RegQueryFn = defaultRegQuery,
  regExecutable: RegExecutableFn = trustedRegExecutable,
): SmartAppControlState {
  if (platform !== "win32") return "not-windows";
  const executable = regExecutable(env);
  // spawnSync reports a refused, crashed or timed-out reg.exe in its result, never by throwing:
  // that read is the closed `unknown`, and the failure line records it.
  const output = regQuery(executable, ["query", POLICY_KEY, "/v", POLICY_VALUE]);
  return output === undefined ? "unknown" : smartAppControlStateFromRegQuery(output);
}

/**
 * The state for a failed start's line. A refused system root or a missing reg.exe leaves its own
 * closed line on the portable failure surface and reads as `unknown`, so the failed start is still
 * reported with its own reason; any other error is not this contract's and propagates.
 */
export function probeSmartAppControlState(
  platform: NodeJS.Platform,
  env: EnvSource,
  sink: SecurityLogSink | undefined,
  regQuery: RegQueryFn = defaultRegQuery,
  regExecutable: RegExecutableFn = trustedRegExecutable,
): SmartAppControlState {
  try {
    return readSmartAppControlState(platform, env, regQuery, regExecutable);
  } catch (error) {
    if (!emitCliWindowsSystemFailure(error, sink, "portable-failure-alert")) throw error;
    return "unknown";
  }
}

/** The text a failed start adds when Smart App Control is enforcing. */
export const SMART_APP_CONTROL_BLOCK_MESSAGE =
  "keiko portable launch: Windows Smart App Control is on. It blocks program files that are not " +
  "signed, and Keiko's own helper programs are not signed yet. Windows offers no per-file " +
  '"Run anyway" for Smart App Control. Read "Smart App Control" in ' +
  "docs/troubleshooting/portable-launch-setup.md for the supported options.\n";
