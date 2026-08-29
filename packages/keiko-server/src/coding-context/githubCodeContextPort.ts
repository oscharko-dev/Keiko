// Production GitHub port for the coding-context connector (Epic #1982, follow-up to #1989).
//
// Executes read-only `gh api` calls through the SINGLE governed spawn boundary,
// keiko-tools `runCommand`, exactly like the governed git delivery layer
// (git-pr-node.ts) — and, like it, on the governed REMOTE env lane. No provider SDK,
// no raw token handling: the lane forwards the credential NAMES and the real HOME so
// `gh` resolves its own credentials, and the boundary keeps their VALUES in its output
// scrub set. The rule set and the pre-validation below make the port structurally
// read-only — mutating `gh api` invocations (method overrides or field payloads) are
// rejected before spawn.

import {
  GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
  runCommand,
  type RunCommandDeps,
  type ExecutableResolver,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { CommandResult, CommandRule, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { logCommandTermination, processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS } from "./githubCodeContextConnector.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";

const GH_API_TIMEOUT_MS = 30_000;
// DERIVED, never restated. The spawn boundary this port runs under caps stdout+stderr at
// `policy.maxOutputBytes` (see runDepsFor below) and REPLACES the buffer with a marker once the cap
// trips, so a second, larger number here could never bound anything — it only made an over-cap read
// look like a syntax problem when the marker reached `JSON.parse`.
const GH_API_MAX_STDOUT_BYTES = GOVERNED_GIT_REMOTE_SANDBOX_POLICY.maxOutputBytes;

// Flags that turn `gh api` into a mutation or redirect it to another host. Presence
// anywhere in the argument vector rejects the invocation (deny-by-default posture).
// Exported so tests exercise the ACTUAL rules the port enforces at the spawn boundary rather
// than a parallel copy — KEIKO-0223 removed a weaker duplicate that lived in the connector
// module and drifted independently.
export const GH_API_DENY_FLAGS: readonly string[] = Object.freeze([
  "--method",
  "-X",
  "--field",
  "-F",
  "--raw-field",
  "-f",
  "--input",
  "--hostname",
  "--verbose",
]);

export const GH_CODE_CONTEXT_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "gh",
    allowedSubcommands: GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS,
    denyFlags: GH_API_DENY_FLAGS,
  },
]);

/**
 * Content-free outcome vocabulary for one governed `gh api` read. `gh-output-truncated` reuses the
 * `output-truncated` term the git remote-failure classifier already owns: Keiko's own byte cap cut
 * the response and killed the child. It is deliberately a distinct member from `gh-failed` (the
 * command itself did not succeed) and `gh-invalid-json` (the command succeeded and returned a
 * complete body that is not JSON) — a truncated read is neither, and reporting it as either one
 * sends the operator after a defect that does not exist.
 */
export type GitHubCodeContextPortErrorCode =
  "gh-denied" | "gh-failed" | "gh-output-truncated" | "gh-invalid-json";

export class GitHubCodeContextPortError extends Error {
  readonly code: GitHubCodeContextPortErrorCode;

  constructor(code: GitHubCodeContextPortErrorCode) {
    super(`github code context port: ${code}`);
    this.code = code;
  }
}

export interface GitHubCodeContextPortOptions {
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly spawn?: SpawnFn | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly now?: (() => number) | undefined;
  readonly timeoutMs?: number | undefined;
  // Activity-log port for the runCommand termination-evidence seam (AGENTS.md §8 Rule 1).
  // Defaults to processServerLogSink() — the same process-wide sink every other server
  // composition site uses — so production logging works with no wiring required; tests inject a
  // buffered sink to assert on the emitted line. This port carries no per-request correlation id
  // of its own (readJson takes only an argv), so every line is stamped UNKNOWN_CORRELATION_ID.
  readonly activityLog?: ServerLogSink | undefined;
}

function assertReadOnlyGhApiArgv(argv: readonly string[]): void {
  const subcommand = argv[0];
  if (subcommand !== "api") throw new GitHubCodeContextPortError("gh-denied");
  for (const arg of argv) {
    if (GH_API_DENY_FLAGS.includes(arg)) throw new GitHubCodeContextPortError("gh-denied");
  }
  const endpoint = argv[1];
  if (endpoint === undefined || !/^\/?repos\//u.test(endpoint)) {
    throw new GitHubCodeContextPortError("gh-denied");
  }
}

function runDepsFor(options: GitHubCodeContextPortOptions): RunCommandDeps {
  return {
    workspace: options.workspace,
    policy: GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
    commandRules: GH_CODE_CONTEXT_COMMAND_RULES,
    spawn: options.spawn ?? nodeSpawnFn,
    resolveExecutable: options.resolveExecutable,
    processEnv: options.processEnv,
    now: options.now ?? ((): number => Date.now()),
  };
}

// Defence in depth only: the spawn boundary already refuses to hand back more than
// GH_API_MAX_STDOUT_BYTES. Over-cap bytes here still mean the read was cut short, not malformed.
function parseBoundedJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout, "utf8") > GH_API_MAX_STDOUT_BYTES) {
    throw new GitHubCodeContextPortError("gh-output-truncated");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GitHubCodeContextPortError("gh-invalid-json");
  }
}

async function runGhApi(
  argv: readonly string[],
  runDeps: RunCommandDeps,
  timeoutMs: number,
  activityLog: ServerLogSink,
): Promise<CommandResult> {
  try {
    return await runCommand(
      {
        command: "gh",
        args: argv,
        cwd: undefined,
        timeoutMs,
        signal: new AbortController().signal,
        onTerminated: (evidence): void => {
          logCommandTermination(activityLog, UNKNOWN_CORRELATION_ID, evidence);
        },
      },
      runDeps,
    );
  } catch {
    // Timeout, cancellation, or spawn failure: surface a content-free code only. Every one of these
    // REJECTS in the spawn boundary, so a resolved result can never be a disguised timeout — which
    // is what lets the truncation check below mean the byte cap and nothing else.
    throw new GitHubCodeContextPortError("gh-failed");
  }
}

export function createGitHubCodeContextApiPort(
  options: GitHubCodeContextPortOptions,
): GitHubCodeContextApiPort {
  const runDeps = runDepsFor(options);
  const timeoutMs = options.timeoutMs ?? GH_API_TIMEOUT_MS;
  const activityLog = options.activityLog ?? processServerLogSink();
  return {
    readJson: async (argv: readonly string[]): Promise<unknown> => {
      assertReadOnlyGhApiArgv(argv);
      const result = await runGhApi(argv, runDeps, timeoutMs, activityLog);
      // Truncation is classified FIRST, and it outranks both later branches for the same reason:
      // hitting the cap kills the child and replaces stdout with a marker, so the very same run
      // also presents as a non-zero exit (the kill) or as unparsable output (the marker). Reading
      // either of those first turns "the response did not fit" into "gh failed" or "GitHub sent
      // invalid JSON" — two defects that are not there.
      if (result.truncated) throw new GitHubCodeContextPortError("gh-output-truncated");
      if (result.exitCode !== 0) throw new GitHubCodeContextPortError("gh-failed");
      return parseBoundedJson(result.stdout);
    },
  };
}
