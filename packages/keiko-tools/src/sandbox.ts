// PURE sandbox logic: the trust boundary's decision functions. No filesystem, no spawn, no
// node:child_process imports — every effect lives in exec.ts/writer.ts. These functions are
// individually unit-testable so the security invariants (env isolation, deny-by-default) are
// pinned down. Only node:path (a pure string utility) is imported here.

import { basename } from "node:path";
import type { CommandRule, SandboxPolicy } from "./types.js";

// A value shorter than this is too generic to scrub safely — redacting it would over-redact
// ordinary output. Shared by both collectors so the credential lane uses the same floor.
const MIN_SCRUBBABLE_VALUE_LENGTH = 6;

// True when a value is present and long enough that scrubbing it from captured output is both
// possible and safe. The credential lane FORWARDS on exactly this predicate too: a secret the
// boundary could not scrub on the way out is never handed to the child on the way in.
function isScrubbableValue(value: string | undefined): value is string {
  return value !== undefined && value.length >= MIN_SCRUBBABLE_VALUE_LENGTH;
}

// Builds the child env by copying ONLY allowlisted names that are present in the parent.
// NEVER spreads `...processEnv`, so no credential-bearing variable can leak into the child.
export function buildSandboxEnv(
  processEnv: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = processEnv[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

// The full child env for a policy, in three ordered layers:
//   1. the name-copy above — never a spread of the parent;
//   2. the policy's declared CREDENTIAL names, if any. These are absent from `envAllowlist` on
//      purpose, so `collectSensitiveEnvValues` keeps their values in the output scrub set: a lane
//      may hand a token to `gh`, but the token can never come back out in captured output. A value
//      too short to scrub safely is not forwarded at all — fail closed rather than unscrubbable;
//   3. the policy's pinned values, which OVERRIDE anything inherited under the same name (a
//      localized LC_ALL must not defeat an English-phrase outcome classifier).
// HOME/USERPROFILE are NOT decided here: the caller applies the home-isolation decision last, so
// no pinned or inherited value can redirect the child's home.
export function buildChildEnv(
  processEnv: NodeJS.ProcessEnv,
  policy: SandboxPolicy,
): Record<string, string> {
  const env = buildSandboxEnv(processEnv, policy.envAllowlist);
  for (const name of policy.credentialEnvAllowlist ?? []) {
    const value = processEnv[name];
    if (isScrubbableValue(value)) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(policy.pinnedEnv ?? {})) {
    env[name] = value;
  }
  return env;
}

// Collects the values of every parent env var that is NOT on the allowlist, so the command's
// captured stdout/stderr can be scrubbed of any secret a child still managed to print (e.g. a
// tool that reads a token from its own config and echoes it). Empty/short values are skipped to
// avoid over-redaction. The allowlisted, non-secret values (PATH, HOME, …) are deliberately kept.
export function collectSensitiveEnvValues(
  processEnv: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): readonly string[] {
  const allowed = new Set(allowlist);
  const values: string[] = [];
  for (const [name, value] of Object.entries(processEnv)) {
    if (allowed.has(name)) {
      continue;
    }
    if (isScrubbableValue(value)) {
      values.push(value);
    }
  }
  return values;
}

// Collects the values of the policy's declared CREDENTIAL names so they are scrubbed from captured
// output even though the child received them. Redundant today (a credential name is never on
// `envAllowlist`, so the collector above already returns it) and deliberately so: the scrub set must
// stay fail-closed if a future edit ever moves one of these names onto the allowlist.
// The credential names the governed git lanes may forward (keiko-contracts tools.ts), restated
// here by NAME only so the credentials-only scrub cannot depend on which lane forwarded them.
const KNOWN_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

// A parent var whose NAME says it carries a credential. Deliberately a contains-match on the
// secret-bearing words and nothing wider: `AUTH` is absent because GIT_AUTHOR_NAME carries a
// person's name, and a name is exactly the kind of value this mode exists to let through.
const CREDENTIAL_ENV_NAME_PATTERN =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY/iu;

export function isCredentialEnvName(name: string): boolean {
  return KNOWN_CREDENTIAL_ENV_NAMES.includes(name) || CREDENTIAL_ENV_NAME_PATTERN.test(name);
}

/**
 * The scrub set for `outputScrub: "credentials-only"`: every credential value the parent carries —
 * by governed name, by credential-shaped name, and by the policy's own credential list — and
 * NOTHING else. The default collector above treats every non-allowlisted value as a secret, which
 * is right for diagnostic output and wrong for the one read whose stdout is a value the caller
 * needs: a configured remote URL carries an owner/repository name that a CI runner also exports as
 * GITHUB_REPOSITORY, so under the default mode the URL came back as `[REDACTED]` and every consumer
 * addressed a repository that does not exist. The shape-based redaction still applies on top.
 */
export function collectCredentialLikeEnvValues(
  processEnv: NodeJS.ProcessEnv,
  credentialNames: readonly string[],
): readonly string[] {
  const names = new Set<string>(credentialNames);
  for (const name of Object.keys(processEnv)) {
    if (isCredentialEnvName(name)) names.add(name);
  }
  return collectCredentialEnvValues(processEnv, [...names]);
}

export function collectCredentialEnvValues(
  processEnv: NodeJS.ProcessEnv,
  credentialNames: readonly string[],
): readonly string[] {
  const values: string[] = [];
  for (const name of credentialNames) {
    const value = processEnv[name];
    if (isScrubbableValue(value)) {
      values.push(value);
    }
  }
  return values;
}

export interface CommandDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

function argumentName(argument: string): string {
  const equalsIndex = argument.indexOf("=");
  return equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
}

// Resolves the subcommand: the first non-flag token, skipping leading flags AND the value of any
// value-taking flag (`--prefix DIR`, `-C DIR`). This is the S-H2 fix — a value can no longer
// masquerade as the subcommand. `--flag=value` carries its value inline, so only the flag token is
// consumed. Returns undefined when no subcommand token is present.
function resolveSubcommand(rule: CommandRule, args: readonly string[]): string | undefined {
  const valueFlags = new Set(rule.valueFlags ?? []);
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false; // this token is the value of the preceding value-flag; skip it
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
    // A `-f=value` / `--flag=value` token carries its own value; consume just this token.
    if (!arg.includes("=") && valueFlags.has(arg)) {
      skipNext = true; // the following token is this flag's value
    }
  }
  return undefined;
}

// Denies the whole invocation if any denied flag (e.g. npm/npx `-c`/`--call`) appears anywhere in
// args, in either `--call x` or `--call=x` form. These execute a transitive shell (S-H2).
function hasDeniedFlag(rule: CommandRule, args: readonly string[]): boolean {
  const denied = rule.denyFlags;
  if (denied === undefined) {
    return false;
  }
  return args.some((argument) => denied.includes(argumentName(argument)));
}

function hasDeniedSubcommandArgument(
  rule: CommandRule,
  subcommand: string | undefined,
  args: readonly string[],
): boolean {
  if (subcommand === undefined) return false;
  const bySubcommand = rule.deniedArgumentsBySubcommand;
  if (bySubcommand === undefined || !Object.hasOwn(bySubcommand, subcommand)) return false;
  const denied = bySubcommand[subcommand];
  return denied !== undefined && args.some((argument) => denied.includes(argumentName(argument)));
}

function hasRequiredLeadingFlags(rule: CommandRule, args: readonly string[]): boolean {
  const required = rule.requiredLeadingFlags;
  if (required === undefined || required.length === 0) {
    return true;
  }
  return required.every((flag, index) => args[index] === flag);
}

function checkAllowlistMode(
  rule: CommandRule,
  allowed: readonly string[],
  sub: string | undefined,
): CommandDecision {
  if (sub === undefined || !allowed.includes(sub)) {
    return { allowed: false, reason: `subcommand not allowed: ${rule.executable} ${sub ?? ""}` };
  }
  return { allowed: true };
}

function checkDenylistMode(rule: CommandRule, sub: string | undefined): CommandDecision {
  // Deny-by-default on the subcommand: when a known-subcommand set is declared, an unrecognized
  // first non-flag token (e.g. a stray path from a value-flag bypass) is denied.
  if (
    rule.knownSubcommands !== undefined &&
    (sub === undefined || !rule.knownSubcommands.includes(sub))
  ) {
    return { allowed: false, reason: `unrecognized subcommand: ${rule.executable} ${sub ?? ""}` };
  }
  if (
    rule.deniedSubcommands !== undefined &&
    sub !== undefined &&
    rule.deniedSubcommands.includes(sub)
  ) {
    return { allowed: false, reason: `subcommand denied: ${rule.executable} ${sub}` };
  }
  return { allowed: true };
}

function checkSubcommand(rule: CommandRule, args: readonly string[]): CommandDecision {
  if (hasDeniedFlag(rule, args)) {
    return { allowed: false, reason: `denied flag for ${rule.executable}` };
  }
  if (rule.forbidLeadingFlags === true && args[0]?.startsWith("-")) {
    return { allowed: false, reason: `leading flags denied for ${rule.executable}` };
  }
  if (!hasRequiredLeadingFlags(rule, args)) {
    return { allowed: false, reason: `missing required leading flag for ${rule.executable}` };
  }
  const sub = resolveSubcommand(rule, args);
  if (hasDeniedSubcommandArgument(rule, sub, args)) {
    return { allowed: false, reason: `denied argument for ${rule.executable} ${sub ?? ""}` };
  }
  if (rule.allowedSubcommands !== undefined) {
    return checkAllowlistMode(rule, rule.allowedSubcommands, sub);
  }
  return checkDenylistMode(rule, sub);
}

// PURE deny-by-default decision. The executable must be a BARE name (no path separators, no
// NUL): we match by basename against the rules and reject anything unlisted. This is evaluated
// BEFORE any spawn, so a denied command never reaches child_process.
export function isCommandAllowed(
  rules: readonly CommandRule[],
  executable: string,
  args: readonly string[],
): CommandDecision {
  if (executable.length === 0 || hasNul(executable)) {
    return { allowed: false, reason: "empty or NUL-containing executable" };
  }
  if (hasPathSeparator(executable)) {
    return { allowed: false, reason: "executable must be a bare PATH-resolved name" };
  }
  const name = basename(executable);
  const rule = rules.find((candidate) => candidate.executable === name);
  if (rule === undefined) {
    return { allowed: false, reason: `executable not allowlisted: ${name}` };
  }
  return checkSubcommand(rule, args);
}
