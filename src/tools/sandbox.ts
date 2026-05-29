// PURE sandbox logic: the trust boundary's decision functions. No filesystem, no spawn, no
// node:child_process imports — every effect lives in exec.ts/writer.ts. These functions are
// individually unit-testable so the security invariants (env isolation, deny-by-default) are
// pinned down. Only node:path (a pure string utility) is imported here.

import { basename } from "node:path";
import type { CommandRule } from "./types.js";

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
    if (value !== undefined && value.length >= 6) {
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

// The first non-flag token in args is the subcommand under inspection (e.g. `git diff`).
function firstSubcommand(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

function checkSubcommand(rule: CommandRule, args: readonly string[]): CommandDecision {
  const sub = firstSubcommand(args);
  if (rule.allowedSubcommands !== undefined) {
    if (sub === undefined || !rule.allowedSubcommands.includes(sub)) {
      return { allowed: false, reason: `subcommand not allowed: ${rule.executable} ${sub ?? ""}` };
    }
    return { allowed: true };
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
