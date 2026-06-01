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

// Branch/remote mutation flags. These are scoped to the `git branch` and `git remote` subcommands
// (a global denyFlags entry would also block harmless uses like `git -C dir status`).
const GIT_BRANCH_DENY_FLAGS: ReadonlySet<string> = new Set(["-D", "-d", "-m", "-M", "--delete"]);

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

// Resolves the git subcommand (first non-flag arg, skipping value-flag pairs). Returns undefined
// when the subcommand can't be determined — the caller treats that as not-a-mutation.
function gitSubcommand(args: readonly string[]): string | undefined {
  const valueFlags = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
  ]);
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
    if (!arg.includes("=") && valueFlags.has(arg)) {
      skipNext = true;
    }
  }
  return undefined;
}

function checkGit(args: readonly string[]): TerminalCommandDecision {
  const sub = gitSubcommand(args);
  if (sub !== "branch" && sub !== "remote") {
    return { allowed: true };
  }
  for (const arg of args) {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (GIT_BRANCH_DENY_FLAGS.has(flag)) {
      return denied(`git ${sub}: denied mutation flag ${flag}`);
    }
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
