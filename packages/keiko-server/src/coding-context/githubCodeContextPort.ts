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
  CommandTimeoutError,
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
import { errorKindOf } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS } from "./githubCodeContextConnector.js";
import type {
  GitHubCodeContextApiPort,
  GitHubCodeContextReadContext,
} from "./githubCodeContextConnector.js";

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
 *
 * `gh-transient-failure` (#3384 B5-13) is likewise its own member, not a shade of `gh-failed`: a
 * wall-time timeout, a GitHub-side rate limit, or a GitHub-side 5xx are conditions the operator
 * should retry, never the same diagnosis as an object that genuinely is not readable (closed,
 * transferred, a pull request, or truly denied). Collapsing them, as this port first did, sent the
 * operator a specific but false "the issue is closed/transferred/a PR" diagnosis for a failure that
 * had nothing to do with the issue at all.
 */
export type GitHubCodeContextPortErrorCode =
  | "gh-denied"
  | "gh-failed"
  | "gh-transient-failure"
  | "gh-output-truncated"
  | "gh-invalid-json";

export class GitHubCodeContextPortError extends Error {
  readonly code: GitHubCodeContextPortErrorCode;

  constructor(code: GitHubCodeContextPortErrorCode, cause?: unknown) {
    super(`github code context port: ${code}`, { cause });
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
  // buffered sink to assert on the emitted line. Reads accept the caller's correlation; legacy
  // callers without one use UNKNOWN_CORRELATION_ID.
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
    // This is transient source data, including the repository's provenance URL. Ordinary context
    // such as GITHUB_REPOSITORY must survive; credential values and secret shapes remain scrubbed.
    policy: { ...GOVERNED_GIT_REMOTE_SANDBOX_POLICY, outputScrub: "credentials-only" },
    commandRules: GH_CODE_CONTEXT_COMMAND_RULES,
    spawn: options.spawn ?? nodeSpawnFn,
    resolveExecutable: options.resolveExecutable,
    processEnv: options.processEnv,
    now: options.now ?? ((): number => Date.now()),
  };
}

// The gh CLI reports an API-shaped failure as `gh: <message> (HTTP <status>)` on stderr. This
// extracts ONLY the 3-digit status class needed to tell a transient GitHub-side condition (rate
// limit, 5xx) apart from an exit that means the object genuinely is not readable — the message
// text itself is discarded immediately and never logged (ADR-0173 body-free evidence).
function githubHttpStatusClassOf(stderr: string): "rate-limited" | "server-error" | undefined {
  const match = /\(HTTP (\d{3})\)/u.exec(stderr);
  const status = match === null ? undefined : Number(match[1]);
  if (status === 403 || status === 429) return "rate-limited";
  if (status !== undefined && status >= 500 && status <= 599) return "server-error";
  return undefined;
}

// A non-zero exit is transient — worth retrying, not a verdict about the object — when GitHub's own
// response signals a rate limit or a server error. Anything else (a plain 404-shaped denial, a
// missing scope) keeps its existing "gh-failed" classification.
function isTransientGhExit(result: CommandResult): boolean {
  return githubHttpStatusClassOf(result.stderr) !== undefined;
}

// Defence in depth only: the spawn boundary already refuses to hand back more than
// GH_API_MAX_STDOUT_BYTES. Over-cap bytes here still mean the read was cut short, not malformed.
function parseBoundedJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout, "utf8") > GH_API_MAX_STDOUT_BYTES) {
    throw new GitHubCodeContextPortError("gh-output-truncated");
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new GitHubCodeContextPortError("gh-invalid-json", error);
  }
}

async function runGhApi(
  argv: readonly string[],
  runDeps: RunCommandDeps,
  timeoutMs: number,
  activityLog: ServerLogSink,
  context: GitHubCodeContextReadContext,
): Promise<CommandResult> {
  try {
    return await runCommand(
      {
        command: "gh",
        args: argv,
        cwd: undefined,
        timeoutMs,
        signal: context.signal ?? new AbortController().signal,
        onTerminated: (evidence): void => {
          logCommandTermination(
            activityLog,
            context.correlationId ?? UNKNOWN_CORRELATION_ID,
            evidence,
          );
        },
      },
      runDeps,
    );
  } catch (error) {
    // Timeout, cancellation, or spawn failure: surface a content-free code only. Every one of these
    // REJECTS in the spawn boundary, so a resolved result can never be a disguised timeout — which
    // is what lets the truncation check below mean the byte cap and nothing else. A wall-time
    // timeout is transient (#3384 B5-13): the boundary rejects with `CommandTimeoutError` rather
    // than resolving a `CommandResult` with `timedOut: true`, so it must be classified HERE, before
    // that distinction is lost to the generic `gh-failed` code.
    if (error instanceof CommandTimeoutError) {
      throw new GitHubCodeContextPortError("gh-transient-failure", error);
    }
    throw new GitHubCodeContextPortError("gh-failed", error);
  }
}

export function createGitHubCodeContextApiPort(
  options: GitHubCodeContextPortOptions,
): GitHubCodeContextApiPort {
  const runDeps = runDepsFor(options);
  const timeoutMs = options.timeoutMs ?? GH_API_TIMEOUT_MS;
  const activityLog = options.activityLog ?? processServerLogSink();
  return {
    readJson: async (argv, context = {}): Promise<unknown> => {
      try {
        assertReadOnlyGhApiArgv(argv);
        const result = await runGhApi(argv, runDeps, timeoutMs, activityLog, context);
        // Truncation is classified FIRST, and it outranks both later branches for the same reason:
        // hitting the cap kills the child and replaces stdout with a marker, so the very same run
        // also presents as a non-zero exit (the kill) or as unparsable output (the marker). Reading
        // either of those first turns "the response did not fit" into "gh failed" or "GitHub sent
        // invalid JSON" — two defects that are not there.
        if (result.truncated) throw new GitHubCodeContextPortError("gh-output-truncated");
        if (result.exitCode !== 0) {
          throw new GitHubCodeContextPortError(
            isTransientGhExit(result) ? "gh-transient-failure" : "gh-failed",
          );
        }
        const parsed = parseBoundedJson(result.stdout);
        recordRead(activityLog, context, undefined, Buffer.byteLength(result.stdout, "utf8"));
        return parsed;
      } catch (error) {
        recordRead(activityLog, context, error);
        throw error;
      }
    },
  };
}

function recordRead(
  log: ServerLogSink,
  context: GitHubCodeContextReadContext,
  error: unknown,
  byteCount = 0,
): void {
  log.write({
    category: "process",
    op: "coding-context.github.read",
    correlationId: context.correlationId ?? UNKNOWN_CORRELATION_ID,
    ...(error === undefined ? {} : { level: "warn", errorKind: errorKindOf(error) }),
    extra: {
      byteCount,
      outcome: readOutcome(context, error),
      ...(error === undefined
        ? {}
        : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
    },
  });
}

function readOutcome(context: GitHubCodeContextReadContext, error: unknown): string {
  if (context.signal?.aborted === true) return "cancelled";
  if (error === undefined) return "succeeded";
  return error instanceof GitHubCodeContextPortError ? error.code : "failed";
}
