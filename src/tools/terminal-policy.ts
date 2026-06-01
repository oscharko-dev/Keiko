// ADR-0018 D3 — permitted-command policy for the UI terminal tool. A separate, narrower allowlist
// than the harness DEFAULT_COMMAND_RULES so the human-facing terminal cannot widen the agent surface.
// The CommandRule schema (allowedSubcommands / denyFlags / valueFlags) handles the structural
// shape; `isTerminalCommandAllowed` adds a thin Layer-2 pass for flag policies that `CommandRule`
// cannot express (find's exec/delete flags, node's positional-arg ban, git branch/remote mutation).
// Pure module: no IO, no spawn, no fs.

import { isCommandAllowed } from "./sandbox.js";
import type { CommandRule } from "./types.js";

const FROZEN_NONE: readonly string[] = Object.freeze([]);

// Read-only inspection commands. Each rule is conservative: omitted subcommands are denied by the
// allowlist mode; the only flag policy expressed here is what CommandRule already supports.
export const TERMINAL_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "ls" },
  { executable: "cat" },
  { executable: "head" },
  { executable: "tail" },
  { executable: "wc" },
  { executable: "grep" },
  { executable: "tree" },
  { executable: "pwd" },
  { executable: "echo" },
  // find has no subcommand structure; the per-flag deny lives in `isTerminalCommandAllowed` (Layer 2)
  // because CommandRule.denyFlags compares full tokens (`-exec`), which is exactly what we need —
  // but keeping the policy co-located with the other find rules below avoids spreading the rationale
  // across two files.
  { executable: "find" },
  // node: only --version/-v allowed. Enforced positionally in Layer 2 (a per-arg policy is not
  // expressible in CommandRule).
  { executable: "node" },
  {
    executable: "npm",
    // `--version` / `-v` are LEADING flags (not subcommands) — the version-only invocation is
    // accepted by Layer 2 (`checkNpm`) because CommandRule's allowedSubcommands resolver skips
    // leading flags. Subcommand allowlist below still gates `npm <verb>` invocations.
    allowedSubcommands: Object.freeze(["ls", "list", "outdated", "view", "info", "help", "ping"]),
    denyFlags: Object.freeze(["-c", "--call"]),
  },
  {
    executable: "git",
    allowedSubcommands: Object.freeze([
      "status",
      "diff",
      "log",
      "show",
      "rev-parse",
      "ls-files",
      "describe",
      "blame",
      "cat-file",
      "branch",
      "remote",
    ]),
    valueFlags: Object.freeze([
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
    ]),
  },
]);

// Flags that delete, write, or execute via find. Any of these anywhere in args denies.
const FIND_DENY_FLAGS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprintf",
]);

// Only --version and -v are accepted for node. Every other positional or flag is denied.
const NODE_ALLOWED_ARGS: ReadonlySet<string> = new Set(["--version", "-v"]);

// Branch mutation flags (A2). Scoped to `git branch` only — these deny branch creation, deletion,
// copy, rename, and force operations. `-c`/`-C` are included here because for `branch` they mean
// copy, not the git-global config flag (which is caught by A5 before we reach here).
const GIT_BRANCH_DENY_FLAGS: ReadonlySet<string> = new Set([
  "-D",
  "-d",
  "-m",
  "-M",
  "--delete",
  "-c",
  "-C",
  "-f",
  "--copy",
  "--force",
]);

// Global git flags that modify git's own config, working-tree, or execution path (A5 / ADR-0018
// S-H2). `-C` (chdir) is intentionally omitted — `git -C subdir status` is a legitimate read-only
// use. These are checked BEFORE subcommand resolution so they cannot be smuggled via a value-flag
// value that happens to look like a subcommand.
const GIT_GLOBAL_DENY_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

export interface TerminalCommandDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
}

function denied(reason: string): TerminalCommandDecision {
  return { allowed: false, reason };
}

function checkFind(args: readonly string[]): TerminalCommandDecision {
  for (const arg of args) {
    if (FIND_DENY_FLAGS.has(arg)) {
      return denied(`find: denied flag ${arg}`);
    }
  }
  return { allowed: true };
}

function checkNode(args: readonly string[]): TerminalCommandDecision {
  for (const arg of args) {
    if (!NODE_ALLOWED_ARGS.has(arg)) {
      return denied("node: only --version/-v is permitted");
    }
  }
  return { allowed: true };
}

// Shared value-flags used by gitSubcommand and argsAfterSubcommand. Kept as a module-level
// constant (not re-created per call) so the hot-path doesn't allocate on every invocation.
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

// Resolves the git subcommand (first non-flag arg, skipping value-flag pairs). Returns undefined
// when the subcommand can't be determined — the caller treats that as not-a-mutation.
function gitSubcommand(args: readonly string[]): string | undefined {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
    if (!arg.includes("=") && GIT_VALUE_FLAGS.has(arg)) {
      skipNext = true;
    }
  }
  return undefined;
}

// Returns the slice of args that appears AFTER the first token equal to `subcommand`, skipping
// value-flag pairs using the same walk as gitSubcommand. Returns undefined when not found.
function argsAfterSubcommand(
  args: readonly string[],
  subcommand: string,
): readonly string[] | undefined {
  // Convert to a mutable array for indexed access so we can use a for...of without a C-style loop
  // (avoids noUncheckedIndexedAccess while remaining tsc-clean under no-non-null-assertion).
  const arr = Array.from(args);
  let skipNext = false;
  for (const [i, arg] of arr.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === subcommand) {
      return args.slice(i + 1);
    }
    if (arg.startsWith("-") && !arg.includes("=") && GIT_VALUE_FLAGS.has(arg)) {
      skipNext = true;
    }
  }
  return undefined;
}

// A2 — After resolving the `branch` subcommand, walk the remaining args. Any non-flag positional
// (a branch name operand) denies creation/switching. Deny all known mutation flags.
function checkGitBranch(argsAfterBranch: readonly string[]): TerminalCommandDecision {
  for (const arg of argsAfterBranch) {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (GIT_BRANCH_DENY_FLAGS.has(flag)) {
      return denied(`git branch: denied mutation flag ${flag}`);
    }
    if (!arg.startsWith("-")) {
      // A bare positional after `branch` is a branch name operand — implies creation or mutation.
      return denied("git branch: positional operand denied (read-only listing only)");
    }
  }
  return { allowed: true };
}

// A1 — After resolving the `remote` subcommand, walk the remaining args. The only allowed
// non-flag positional is `show` (optionally followed by a remote name for `git remote show <name>`).
// All other positionals (add, rm, rename, set-url, set-head, set-branches, prune, update…) are
// mutation subcommands and are denied.
function checkGitRemote(argsAfterRemote: readonly string[]): TerminalCommandDecision {
  for (const arg of argsAfterRemote) {
    if (arg.startsWith("-")) {
      // Pure flag (e.g. -v / --verbose) — already covered by the CommandRule valueFlags/denyFlags
      // at Layer 1, but we allow flags through here to avoid double-denying them.
      continue;
    }
    // First non-flag positional: must be "show" or it is a mutation subcommand.
    if (arg !== "show") {
      return denied(
        `git remote: subcommand "${arg}" is denied (read-only: use flags or "show" only)`,
      );
    }
    // "show" is safe; subsequent positionals are remote names — safe to accept.
    return { allowed: true };
  }
  return { allowed: true };
}

function checkGit(args: readonly string[]): TerminalCommandDecision {
  // A5 — Deny global config/env-injection flags before resolving the subcommand. `-C` (chdir)
  // is intentionally omitted so `git -C subdir status` keeps working for project-internal nav.
  for (const arg of args) {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (GIT_GLOBAL_DENY_FLAGS.has(flag)) {
      return denied(`git: denied global flag ${flag}`);
    }
  }
  const sub = gitSubcommand(args);
  if (sub === "branch") {
    const rest = argsAfterSubcommand(args, "branch") ?? [];
    return checkGitBranch(rest);
  }
  if (sub === "remote") {
    const rest = argsAfterSubcommand(args, "remote") ?? [];
    return checkGitRemote(rest);
  }
  return { allowed: true };
}

// `npm --version` / `npm -v` is a leading-flag-only invocation; Layer-1's allowedSubcommands
// resolver skips leading flags and reports no subcommand. Accept it explicitly here so the
// version-only invocation does not fall through to Layer-1's "subcommand not allowed" path.
function isNpmVersionOnly(args: readonly string[]): boolean {
  if (args.length === 0) {
    return false;
  }
  return args.every((arg) => arg === "--version" || arg === "-v");
}

// Pure deny-by-default decision for a terminal command. Layer 1 is the shared `isCommandAllowed`
// (validates the executable and applies CommandRule's subcommand allowlist/denyFlags/valueFlags).
// Layer 2 here adds the per-command flag policies that CommandRule cannot express (find / node /
// git branch and remote mutation flags) and the leading-flag-only npm version invocation.
export function isTerminalCommandAllowed(
  command: string,
  args: readonly string[],
): TerminalCommandDecision {
  // npm --version / npm -v is the only invocation Layer 1's allowedSubcommands cannot accept,
  // because the resolver skips leading flags. Short-circuit before Layer 1 to keep the rest of
  // npm's surface (`install`, `run`, `exec`, …) deny-by-default.
  if (command === "npm" && isNpmVersionOnly(args)) {
    return { allowed: true };
  }
  const layer1 = isCommandAllowed(TERMINAL_COMMAND_RULES, command, args);
  if (!layer1.allowed) {
    return { allowed: false, reason: layer1.reason };
  }
  if (command === "find") {
    return checkFind(args);
  }
  if (command === "node") {
    return checkNode(args);
  }
  if (command === "git") {
    return checkGit(args);
  }
  return { allowed: true };
}

// Re-export so callers don't have to import from sandbox.ts directly.
export { FROZEN_NONE as TERMINAL_NO_FLAGS };
