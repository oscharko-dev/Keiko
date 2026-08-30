// Shared process-level types for the single hardened git spawn path. These are runtime-layer
// types (not wire contracts): server routes, tool adapters, and workspace detection all execute
// git through this one interface so byte caps, timeouts, and error mapping behave identically.

/**
 * Why the single spawn boundary refused an invocation BEFORE starting a process.
 *
 * This union is the body-free half of that fact: it names WHICH preflight fired and nothing about
 * the value that tripped it. The RAW token in the result's `stderr` is not — for the
 * config-override family its middle segment is caller-chosen (`-c alias.<name>`, `-c pager.<cmd>`,
 * `-c diff.<driver>.textconv`) — so the token must never reach an activity log, an evidence
 * manifest, or a diagnostic, and this class always may.
 *
 * Produced here, at the layer that owns the decision, so no consumer has to parse `stderr` to
 * learn it — a consumer-side string match would drift from the refusal message the moment either
 * side moved, and would re-derive a classification this module already computed.
 */
export type GitRefusalClass =
  /** `--upload-pack` / `--receive-pack` / `--exec`: makes a remote-facing subcommand run a local command. */
  | "remote-command-option"
  /** `--ext-diff` / `--textconv`: re-enables the external diff/textconv helpers the runner neutralizes. */
  | "diff-enabling-flag"
  /** `-c` / `--config-env` overriding a denied config key (`diff.external`, `core.pager`, …). */
  | "config-override"
  /**
   * A `git` on PATH that resolves to a location this process must not trust — workspace-contained,
   * or group/world-writable (KEIKO-0263's planted-binary indicator). Not an argv refusal, but the
   * same KIND of fact and the reason this union is named for the refusal rather than for the
   * option: the spawn boundary declined, no process ran.
   *
   * It is a member here because without one, the only signal separating "someone planted a git on
   * PATH" from "git is not installed" was the `stderr` text — and `stderr` is not body-free, so it
   * can never reach an activity log. Both cases exit 127 and both classify as `git-missing`, so a
   * consumer reading only the classification cannot tell the security event from the mundane one.
   */
  | "untrusted-executable";

export interface GitProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Output was cut at the byte cap OR the run was cut by the timeout (see `timedOut`). */
  readonly truncated: boolean;
  /**
   * The run exceeded its wall-clock budget and was killed. Implies `truncated`. Optional so that
   * result literals predating this field (fake runners in tests) stay valid; the real runner
   * always sets it.
   */
  readonly timedOut?: boolean | undefined;
  /**
   * The bounded caller aborted the run via the abortSignal. Also implies `truncated` at the
   * runner (the child is killed to keep the caller unblocked), so `truncated`/`timedOut` alone
   * cannot distinguish an aborted run from a byte-cap cut. Optional for the same reason as
   * `timedOut`; the real runner always sets it.
   */
  readonly aborted?: boolean | undefined;
  /**
   * Set only when the spawn boundary refused this invocation and no process ever ran — the argv
   * preflight (`exitCode` 128) or the executable-trust check (`exitCode` 127). Optional for the
   * same reason as `timedOut`/`aborted` above — result literals in fake runners stay valid — and
   * absent on every result that reached a real `git` process, so `refusal !== undefined` is the
   * exact test for "Keiko itself refused this", never a stderr match.
   */
  readonly refusal?: GitRefusalClass | undefined;
}

export interface GitProcessOptions {
  readonly cwd: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Cancels an admitted process when the originating bounded request disconnects. */
  readonly abortSignal?: AbortSignal | undefined;
  /**
   * Non-zero exit codes THIS call site treats as a successful domain outcome, so an observer must
   * not report them as failures. `git diff --no-index` exits 1 to mean "the files differ" — the
   * whole point of that call — and `git log` in a repository with no commits exits non-zero for an
   * empty history. Both are normalized to a successful route response, so without this a healthy
   * untracked-file diff would write a `warn` line claiming a git command failed, and the log would
   * contradict the very response it is supposed to explain.
   *
   * The runner itself does not read this: it changes no process behaviour and no result field. It
   * travels with the invocation because "is exit 1 a failure here?" is knowledge only the caller
   * has, and it must reach the observation layer without every call site re-implementing logging.
   */
  readonly expectedExitCodes?: readonly number[] | undefined;
  /**
   * A call-site override for `errorKind` classification when a caller already owns a more precise
   * taxonomy than the generic one an observer would pick. `gitDelivery/syncExecution.ts` is the
   * motivating case: it classifies a failed pull's `stderr` into `not-fast-forward` /
   * `dirty-worktree` / `no-upstream` / `detached-head` for its own response and evidence, but the
   * activity-log observer has no route to that knowledge and would otherwise report the generic
   * remote-failure kind — leaving the log unable to name the SAME outcome the response and
   * evidence already do. Returning `undefined` defers to the observer's own classification; this
   * is an ADDITIVE override, never a way to suppress a line.
   *
   * The runner does not read this or change any process behaviour because of it — same contract
   * as `expectedExitCodes`.
   */
  readonly classifyFailure?: ((result: GitProcessResult) => string | undefined) | undefined;
}

export type GitProcessRunner = (
  args: readonly string[],
  options: GitProcessOptions,
) => Promise<GitProcessResult>;
