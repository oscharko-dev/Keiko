// Activity-log evidence for the git process boundary (AGENTS.md §8 Rule 1).
//
// ORIGIN: the #3348 audit hardened `keiko-git`'s spawn-boundary preflight with new `--ext-diff`/
// `--textconv` and `-c <denied key>` rejections. Those reuse the same `GitProcessResult` shape as
// the pre-existing `--upload-pack`/`--receive-pack`/`--exec` refusal — which, it turned out, no
// consumer had ever logged. The preflight was doing its job and saying so to nobody. This module
// is the separately-scoped follow-up that closes the reporting half, for that refusal and for
// every other git outcome on the same boundary.
//
// WHAT WAS MISSING
//
// Every read-only git route (`/api/git/status`, `/diff`, `/diff/structured`, `/blame`,
// `/branches`, and the repository summary/remotes/history reads) answers a failed `git` run with a
// redacted, content-free HTTP body — by design, so a caller cannot use the route as an oracle. The
// consequence was that NOTHING about the failure reached `<stateDir>/logs/server.log`: not an
// ordinary "not a git repository", not `git` missing from PATH, and not the spawn-boundary
// SECURITY refusal (`refused git option: …`, exit 128) that `keiko-git`'s preflight raises when an
// invocation carries `--upload-pack`/`--receive-pack`/`--exec`, `--ext-diff`/`--textconv`, or a
// `-c`/`--config-env` override of a denied config key. An operator handed such a log could see the
// route was called and that it returned 200-with-unavailable, and could not tell which of those
// happened — so the defect could not be reconstructed from the log alone, which is exactly what
// ADR-0173 makes the log's contract.
//
// WHY THE OBSERVATION SITS ON THE RUNNER, NOT ON EACH ROUTE
//
// The routes reach the runner from several places — six direct `options.runner(...)` calls in
// `gitRoutes.ts`, one shared `runGit()` helper in `gitRepositoryReads.ts`, and the runner handed to
// `resolveGitMembership()` inside `keiko-git`. That last one decides "not a repository", the single
// most common failure of all, and it never passes through a route handler's own body: a per-route
// instrumentation would have missed it entirely. Wrapping the runner fixes the whole class at the
// layer that owns the process outcome (AGENTS.md §7) — a route added tomorrow that runs git through
// the normalized options is observed without its author doing anything, and no call site can
// forget.
//
// WHY ONLY FAILURES
//
// `server.ts` already writes one `http`/`request` line per request, carrying the same
// `correlationId`, so a SUCCESSFUL route read is already reconstructible: the request line names
// the route and its status, and the git commands a given route runs are fixed. What that line
// cannot carry is WHY a git read came back unavailable, because the route deliberately does not
// put it in the response. That is the gap these lines close, and emitting a line per successful
// `git` spawn on top of it would multiply the log volume of a UI that polls status without adding
// a fact an operator does not already have.

import {
  classifyGitFailure,
  gitSubcommand,
  type GitProcessResult,
  type GitProcessRunner,
  type GitRefusalClass,
} from "@oscharko-dev/keiko-git";

import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { ServerLogLevel, ServerLogSink } from "./observability/index.js";

// `gitSubcommand` returns `undefined` for an argv with no subcommand token, and for a token whose
// shape is not a plausible subcommand name (its guard is what keeps this field body-free). Both
// are reported as this literal rather than omitted, so an operator grepping the field never has to
// tell "the key is missing" from "the command had no subcommand".
const UNNAMED_SUBCOMMAND = "unknown";

/**
 * `errorKind` per refusal class. Distinct from every `GitFailureReason` on purpose: a refused
 * invocation never reached a `git` process, so the shared failure classifier reports the argv
 * refusals as the generic `git-error` and the untrusted-executable refusal as the same
 * `git-missing` a machine without git produces — in both cases making Keiko's own security
 * decision indistinguishable from an ordinary environment problem.
 *
 * A `Record` over the union rather than a chain of `if`s, so a class added to `GitRefusalClass`
 * is a COMPILE error here and cannot silently inherit another class's kind.
 */
const REFUSAL_ERROR_KIND: Readonly<Record<GitRefusalClass, string>> = {
  "remote-command-option": "git-option-refused",
  "diff-enabling-flag": "git-option-refused",
  "config-override": "git-option-refused",
  "untrusted-executable": "git-executable-untrusted",
};

/** `errorKind` for a run the bounded caller cancelled — also not a git failure. */
const CANCELLED_ERROR_KIND = "git-cancelled";

/** `errorKind` for a run Keiko's wall-clock budget stopped. */
const TIMEOUT_ERROR_KIND = "timeout";

/** `errorKind` for a run Keiko's byte cap cut. Not a git failure either — Keiko stopped reading. */
const TRUNCATED_ERROR_KIND = "output-truncated";

// Precedence, and it is load-bearing. `classifyGitRemoteFailure` (keiko-git's classify.ts) documents
// the same ordering and the incident behind it: `truncated` and the exit code are set
// INDEPENDENTLY, so a run the cap cut while git was already finishing closes with exit 0, and
// ranking success first reported it as a clean run over output that was never fully read (#2869).
// The deadline outranks the cap for the same reason it does there, and the caller's own
// cancellation outranks both because it is the first cause.
function gitFailureErrorKind(result: GitProcessResult): string {
  if (result.refusal !== undefined) return REFUSAL_ERROR_KIND[result.refusal];
  if (result.aborted === true) return CANCELLED_ERROR_KIND;
  if (result.timedOut === true) return TIMEOUT_ERROR_KIND;
  // Only reachable for a truncated run — a clean exit never gets this far (see the emit guard).
  if (result.exitCode === 0) return TRUNCATED_ERROR_KIND;
  return classifyGitFailure(result);
}

// A cancelled run is the caller hanging up (a UI that abandoned a diff it no longer needs), not a
// fault: recorded, but never at a level that makes routine navigation look like an incident. Every
// other non-zero outcome is a real read failure an operator may have to act on.
function gitFailureLevel(result: GitProcessResult): ServerLogLevel {
  return result.aborted === true ? "info" : "warn";
}

// How the child process ended. A child either exits with a code or is killed by a signal, so
// `exitCode` and `signal` are mutually exclusive and one of them is ALWAYS null — which matters
// here because `redactLogFields` drops a null field outright (`redactLogValue` in
// `log-redaction.ts`). Emitting the raw pair therefore loses one of the two on every single line,
// and a missing key cannot be told apart from a producer that never writes one. This discriminator
// is always present, so each value field can be omitted when it is not the one carrying the answer
// and its absence still means something exact. `unknown` is unreachable through the real runner
// (every settle path sets one or the other) and exists so a fake that sets neither is reported
// honestly rather than mislabelled as a clean exit.
function gitTermination(result: GitProcessResult): "exit" | "signal" | "unknown" {
  if (result.exitCode !== null) return "exit";
  return result.signal === null ? "unknown" : "signal";
}

// Every field here is a count, a flag, a closed-vocabulary token or an exit status. `stdout` and
// `stderr` are deliberately absent and must stay absent: git writes repository paths, config
// values, branch names and remote URLs to both, and `refusal`'s own raw token carries a
// caller-chosen segment for the config-override family (see `GitRefusalClass` in keiko-git). The
// CLASS is the body-free half of that fact, which is why keiko-git reports it structurally.
function gitOutcomeFields(
  args: readonly string[],
  result: GitProcessResult,
): Record<string, unknown> {
  return {
    subcommand: gitSubcommand(args) ?? UNNAMED_SUBCOMMAND,
    endedBy: gitTermination(result),
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    // Which signal ended the child, when one did. Separates the runner's own SIGTERM timeout kill
    // from the SIGKILL escalation that follows an unresponsive git, and both from a crash — three
    // outcomes `timedOut`/`aborted` alone cannot tell apart.
    ...(result.signal === null ? {} : { signal: result.signal }),
    truncated: result.truncated,
    timedOut: result.timedOut === true,
    aborted: result.aborted === true,
  };
}

/**
 * Writes at most one body-free line for one finished git invocation. A successful run emits
 * nothing (see the header). Two distinct `op`s rather than one with an outcome field, because the
 * refusal is a different KIND of event — a Keiko policy decision on the `security` category, not a
 * repository read that failed on `diagnostic` — and an operator greps one without the other.
 */
export function logGitProcessOutcome(
  log: ServerLogSink,
  correlationId: string | undefined,
  args: readonly string[],
  result: GitProcessResult,
  durationMs: number,
): void {
  // NOT a bare `exitCode === 0`. Keiko's byte cap sets `truncated` and terminates the child
  // independently of the exit status, so a read cut off while git was already finishing closes
  // with 0 — a DEGRADED read the route's own response reports as `truncated: true` while the log
  // would have shown nothing at all. `classifyGitRemoteFailure` was hardened against this exact
  // shape after it made the sync executor call such a run "succeeded" (#2869); the same ranking
  // mistake must not be reintroduced here. `timedOut`/`aborted` imply `truncated` at the runner,
  // so this one condition covers every Keiko-side stop.
  if (result.exitCode === 0 && !result.truncated) return;
  const id = correlationId ?? UNKNOWN_CORRELATION_ID;
  const fields = gitOutcomeFields(args, result);
  if (result.refusal !== undefined) {
    log.write({
      level: "error",
      category: "security",
      op: "git.process.refused",
      correlationId: id,
      errorKind: gitFailureErrorKind(result),
      durationMs,
      extra: { ...fields, refusal: result.refusal },
    });
    return;
  }
  log.write({
    level: gitFailureLevel(result),
    category: "diagnostic",
    op: "git.process.failed",
    correlationId: id,
    errorKind: gitFailureErrorKind(result),
    durationMs,
    extra: fields,
  });
}

/**
 * Wraps a {@link GitProcessRunner} so every invocation through it reports its own failure. The
 * wrapper is transparent for the RESULT: it returns exactly what the underlying runner resolved.
 *
 * It does NOT catch around `log.write`, and that is deliberate. The production sink
 * (`processServerLogSink()`) routes into `getServerLogger().log`, which already catches a sink
 * failure, a throwing thunk and a hostile field getter, keeps the request alive, and reports the
 * breakage on stderr through `reportServerLogFailure` — an independent channel, because a logging
 * failure recorded only through the broken log is a failure nobody ever sees. A second catch here
 * could not reach that channel, so it would convert a diagnosable broken sink into a silent one
 * (AGENTS.md §7). What this function relies on is therefore the sink CONTRACT — `write` does not
 * throw — upheld by the only implementation production ever passes it.
 *
 * A THROWN error is re-thrown untouched and NOT logged here: the runner's contract is to resolve
 * with a `GitProcessResult` for every process outcome (spawn failure included, as exit 127), so a
 * throw is a defect in the runner itself rather than a git outcome, and it surfaces through the
 * route's existing `emitServerDiagnostic` path with the same correlation id.
 */
export function observedGitRunner(
  runner: GitProcessRunner,
  log: ServerLogSink,
  correlationId: string | undefined,
): GitProcessRunner {
  return async (args, options): Promise<GitProcessResult> => {
    const startedAt = Date.now();
    const result = await runner(args, options);
    logGitProcessOutcome(log, correlationId, args, result, Date.now() - startedAt);
    return result;
  };
}
