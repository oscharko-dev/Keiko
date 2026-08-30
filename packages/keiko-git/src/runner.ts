// Single hardened git spawn path. Owns process lifecycle, a shared stdout/stderr byte cap,
// wall-clock timeout with SIGTERM→SIGKILL escalation, and spawn-error mapping. `buildEnv` is the
// only seam: local reads pass the config-isolated `gitEnv`, network sync passes the
// credential-capable `networkGitEnv`; everything else is identical, so every consumer inherits
// the same bounded-output behaviour.

import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { gitEnv, networkGitEnv } from "./env.js";
import { resolveGitExecutable } from "./git-executable.js";
import type {
  GitProcessOptions,
  GitProcessResult,
  GitProcessRunner,
  GitRefusalClass,
} from "./types.js";

// Grace period between SIGTERM and SIGKILL: a git process that ignores SIGTERM (stuck on a dead
// filesystem, wedged hook) must never wedge the caller for longer than the timeout plus this.
const KILL_GRACE_MS = 2_000;

// Args every git invocation should carry: never page, and never take optional locks — a Keiko
// read must not block the user's own concurrent git commands on the same repository.
export const GIT_BASE_ARGS: readonly string[] = ["--no-pager", "--no-optional-locks"];

// Repository-local configuration is intentionally still visible for ordinary repository data,
// but executable read helpers must never run. This fixed override is injected by the local runner
// before every caller-supplied argument, so no route can accidentally omit it. `diff.external` is
// deliberately NOT here as a blanket `-c diff.external=`: git treats an explicit empty override as
// "the external diff command is the empty string" and fails the whole invocation at exec time
// (exit 128) instead of falling back to the internal differ, which would turn every `git diff` on
// this runner into a hard failure. That helper is neutralized per diff-family subcommand instead —
// see `withDiffFamilyNeutralized` below. `core.editor=true` has no reachable local-read path (no
// subcommand this runner uses launches an editor) but costs nothing and closes the config value
// for good if one is ever added.
const LOCAL_READ_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.editor=true",
];
const NETWORK_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.sshCommand=",
  "-c",
  "credential.helper=",
  "-c",
  "core.pager=cat",
  "-c",
  "pager.fetch=false",
  "-c",
  "pager.pull=false",
  "-c",
  "alias.fetch=",
  "-c",
  "alias.pull=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "submodule.recurse=false",
];

// Git options that make a remote-facing subcommand run a local command of the caller's choosing:
// `git clone --upload-pack=<cmd>` / `--receive-pack=<cmd>` / `git send-pack --exec=<cmd>`. No Keiko
// git invocation ever needs these, so the single spawn boundary refuses them for EVERY command —
// defense in depth against option injection that does not depend on any one call site validating
// its positionals. The `=`-or-word-boundary anchor keeps legitimate flags like `--exec-path` and
// `--upload-archive` allowed; `-c` (config override) is a separate, permitted option.
const FORBIDDEN_GIT_OPTION = /^--(?:upload-pack|receive-pack|exec)(?:=|$)/u;

function forbiddenGitOption(args: readonly string[]): string | undefined {
  return args.find((arg) => FORBIDDEN_GIT_OPTION.test(arg));
}

// `--ext-diff`/`--textconv` re-enable exactly the external helpers `withDiffFamilyNeutralized`
// below otherwise neutralizes for every diff-family subcommand. Checked anywhere in the caller's
// args, not only after a resolved subcommand: this is the literal override audit finding #3348
// reproduces (`[...GIT_BASE_ARGS, "diff", "--ext-diff"]` must never reach spawn), and neither flag
// has any other meaning at any argv position in git's grammar, so there is no legitimate call
// shape this could reject by mistake.
const FORBIDDEN_DIFF_ENABLING_FLAG = /^--(?:ext-diff|textconv)(?:=|$)/u;

function forbiddenDiffEnablingFlag(args: readonly string[]): string | undefined {
  return args.find((arg) => FORBIDDEN_DIFF_ENABLING_FLAG.test(arg));
}

// Diff-family subcommands whose default behaviour can shell out to a repository-local
// `diff.external` helper, or run a repository-local `textconv` filter, unless the invocation
// carries `--no-ext-diff --no-textconv`. Injected right after the subcommand token at the single
// spawn boundary so no caller can silently reopen the gap by omitting the flags — mirroring how
// NETWORK_CONFIG_ARGS neutralizes remote-facing repository config regardless of the call site.
// `show` and `log` render diffs too (a bare `git show <commit>` and `git log -p` both honour
// diff.external/textconv by default) and both are reachable through the agent-facing git tool
// allowlist (keiko-contracts DEFAULT_COMMAND_RULES) alongside `diff` itself — audit finding on
// #3348: the neutralization must cover every porcelain surface that can render a diff, not only
// the literal `diff` subcommand.
const DIFF_FAMILY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "log",
  "show",
]);
const DIFF_NO_EXTERNAL_ARGS: readonly string[] = ["--no-ext-diff", "--no-textconv"];

// Global flags this codebase's callers pass before the subcommand: GIT_BASE_ARGS'
// `--no-pager`/`--no-optional-locks` take no value; `-C <path>` and `-c <key>=<value>` each take
// one (the latter is how gitHistoryArgs() in grounded-git-history-evidence.ts passes
// `-c core.quotepath=false` ahead of `log`). Extend the relevant set before any caller adds
// another pre-subcommand flag, or subcommand detection below stops one token early and the
// diff-family injection silently becomes a no-op for that call shape.
const PRE_SUBCOMMAND_FLAG_NO_VALUE: ReadonlySet<string> = new Set([
  "--no-pager",
  "--no-optional-locks",
]);

// The config-override flags, named ONCE. `forbiddenTwoTokenConfigOverride` below reads this set to
// decide which flags carry a config key, and `PRE_SUBCOMMAND_FLAG_ONE_VALUE` reads it to decide
// which flags consume the token after them. Those two lived as independent literals, and they
// disagreed: the override check knew `--config-env`, the subcommand scan did not. So
// `git --config-env <key>=<envvar> diff` resolved to NO subcommand, `withDiffFamilyNeutralized`
// treated it as a non-diff command, and the invocation reached git without
// `--no-ext-diff --no-textconv` — silently reopening the repository-local `diff.external` /
// `textconv` path that #3348 closed, for any key the deny-list does not name. One set now, so a
// flag added to the grammar cannot be known to one half of it and invisible to the other.
const CONFIG_OVERRIDE_FLAGS: ReadonlySet<string> = new Set(["-c", "--config-env"]);
const CONFIG_ENV_JOINED_PREFIX = "--config-env=";

const PRE_SUBCOMMAND_FLAG_ONE_VALUE: ReadonlySet<string> = new Set([
  "-C",
  ...CONFIG_OVERRIDE_FLAGS,
]);

function findSubcommandIndex(args: readonly string[]): number | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg !== undefined && PRE_SUBCOMMAND_FLAG_ONE_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    // `--config-env=<name>=<envvar>` carries its value in the same token, so it consumes one slot,
    // not two. Its documented single-token form is why this is a prefix test and not a set lookup.
    if (
      arg !== undefined &&
      (PRE_SUBCOMMAND_FLAG_NO_VALUE.has(arg) || arg.startsWith(CONFIG_ENV_JOINED_PREFIX))
    ) {
      index += 1;
      continue;
    }
    return arg !== undefined && !arg.startsWith("-") ? index : undefined;
  }
  return undefined;
}

// git subcommand names are lower-case ASCII words (`status`, `for-each-ref`, `rev-parse`). The
// shape guard is what makes the answer safe to LOG: every Keiko call site passes a literal here,
// but this function reads whatever token sits at the subcommand position, so a value that is not a
// plausible subcommand name is reported as `undefined` rather than copied into an activity log.
// Bounded alphabet, bounded length, no separators, no whitespace — a token that passes cannot
// carry a path, a config value, or a secret.
const GIT_SUBCOMMAND_SHAPE = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * The git subcommand `args` resolves to (`status`, `diff`, `for-each-ref`, …), or `undefined` when
 * the array has no subcommand token or the token is not a plausible subcommand name.
 *
 * Exported because a consumer that wants to name the failing command must not restate this
 * module's pre-subcommand argv grammar (`-C`/`-c` take a value, `--no-pager` does not): a second
 * copy of that table drifts silently the moment a caller adds a global flag, and the copy would
 * then name the wrong token. One grammar, one reader.
 */
export function gitSubcommand(args: readonly string[]): string | undefined {
  const index = findSubcommandIndex(args);
  const token = index === undefined ? undefined : args[index];
  return token !== undefined && GIT_SUBCOMMAND_SHAPE.test(token) ? token : undefined;
}

function withDiffFamilyNeutralized(args: readonly string[]): readonly string[] {
  const index = findSubcommandIndex(args);
  const subcommand = index === undefined ? undefined : args[index];
  if (index === undefined || subcommand === undefined || !DIFF_FAMILY_SUBCOMMANDS.has(subcommand)) {
    return args;
  }
  if (DIFF_NO_EXTERNAL_ARGS.every((flag) => args.includes(flag))) return args;
  return [...args.slice(0, index + 1), ...DIFF_NO_EXTERNAL_ARGS, ...args.slice(index + 1)];
}

// ─── `-c`/`--config-env` config-key preflight (audit finding on #3348) ────────────────────────
//
// Reuse decision (AGENTS.md §5): packages/keiko-contracts/src/tools.ts already denies `-c` and
// `--config-env` OUTRIGHT for the agent-facing git TOOL surface (DEFAULT_COMMAND_RULES) — no call
// through that narrow, read-only allowlist ever needs a config override, so it can afford to
// blanket-deny the flag by NAME via a flat denyFlags list. This runner sits one layer lower and is
// consumed by more than that tool surface (gitRoutes.ts, gitDelivery/syncExecution.ts, and
// grounded-git-history-evidence.ts's gitHistoryArgs(), which legitimately passes
// `-c core.quotepath=false` ahead of `log` — a real production call), so it cannot deny `-c`
// wholesale without breaking that caller. The only sound boundary here is to permit `-c`/
// `--config-env` in general and deny by the config KEY the value carries — a check that operates
// on a wholly different shape of data (parsed key patterns, several with a caller/repo-chosen
// middle segment such as a diff driver or protocol name) than tools.ts's flat flag-name list. The
// two lists are kept separate on purpose, not duplicated silently: if the set of enabling flag
// NAMES (--ext-diff/--textconv/--config-env) ever changes, update both this file and tools.ts's
// git denyFlags together (see the cross-reference comment left on that list).
//
// git only treats `-c`/`--config-env` as a GLOBAL config override when it appears before the
// resolved subcommand — verified empirically against git 2.50: `git diff -c core.pager=cat`
// parses `-c` as diff's OWN combined-format flag and `core.pager=cat` as a revision argument,
// never touching config. The scan below is therefore bounded to the pre-subcommand region (the
// same region findSubcommandIndex resolves for withDiffFamilyNeutralized above), which also
// matches the one real production call shape. When no subcommand boundary can be resolved at all,
// the whole array is treated as pre-subcommand — fail closed rather than silently narrow the scan.

const DENIED_CONFIG_EXACT_KEYS: readonly string[] = [
  "diff.external",
  "core.pager",
  "core.editor",
  "sequence.editor",
  "core.sshCommand",
  "core.fsmonitor",
  "core.hooksPath",
  "uploadpack.packObjectsHook",
  "http.proxy",
  "credential.helper",
  "init.templateDir",
  "safe.directory",
];
const DENIED_CONFIG_EXACT_KEYS_LOWER: ReadonlySet<string> = new Set(
  DENIED_CONFIG_EXACT_KEYS.map((key) => key.toLowerCase()),
);

// Per-driver / per-remote-protocol / per-alias keys: the middle segment is caller- or
// repository-chosen (a diff driver name, a protocol name, an alias name), so no exact string can
// enumerate them. `[\s\S]*` (not just "no dot") is deliberate: a subsection that itself contains a
// dot must still match rather than slip past a narrower pattern — fail closed.
const DENIED_CONFIG_WILDCARD_PATTERNS: readonly RegExp[] = [
  /^diff\.[\s\S]*\.textconv$/u,
  /^diff\.[\s\S]*\.command$/u,
  /^pager\.[\s\S]+$/u,
  /^alias\.[\s\S]+$/u,
  /^protocol\.[\s\S]*\.allow$/u,
];

function configKeyFromSpec(spec: string): string {
  const equalsIndex = spec.indexOf("=");
  return equalsIndex === -1 ? spec : spec.slice(0, equalsIndex);
}

// git config section/variable names are case-insensitive (git-config(1)); compare lowercase so
// `-c DIFF.External=...` cannot bypass the checks above by casing alone.
function isDangerousConfigKey(rawKey: string): boolean {
  const key = rawKey.toLowerCase();
  if (DENIED_CONFIG_EXACT_KEYS_LOWER.has(key)) return true;
  return DENIED_CONFIG_WILDCARD_PATTERNS.some((pattern) => pattern.test(key));
}

function preSubcommandRegion(args: readonly string[]): readonly string[] {
  const boundary = findSubcommandIndex(args);
  return boundary === undefined ? args : args.slice(0, boundary);
}

// Two-token form: `-c key=value` / `--config-env key=value`. The value token belongs to the flag
// immediately before it, so this walks by index rather than using Array#find. A dangling flag
// with no following token is denied too — there is no value to prove safe.
function forbiddenTwoTokenConfigOverride(region: readonly string[]): string | undefined {
  for (let index = 0; index < region.length; index += 1) {
    const arg = region[index];
    if (arg === undefined || !CONFIG_OVERRIDE_FLAGS.has(arg)) continue;
    const value = region[index + 1];
    if (value === undefined) return arg;
    const key = configKeyFromSpec(value);
    if (isDangerousConfigKey(key)) return `${arg} ${key}`;
    index += 1; // the value token is this flag's argument, never re-scanned as one of its own
  }
  return undefined;
}

// --config-env's documented single-token form: `--config-env=<name>=<envvar>`.
function forbiddenConfigEnvJoinedOverride(region: readonly string[]): string | undefined {
  for (const arg of region) {
    if (!arg.startsWith(CONFIG_ENV_JOINED_PREFIX)) continue;
    const key = configKeyFromSpec(arg.slice(CONFIG_ENV_JOINED_PREFIX.length));
    if (isDangerousConfigKey(key)) return `--config-env ${key}`;
  }
  return undefined;
}

// Defensive: this git build rejects a joined `-cKEY=VALUE` token today (verified: "unknown
// option: -c...") but an input this preflight cannot positively classify as safe is denied, never
// silently allowed — never assume today's parser behaviour holds for every git version this
// runner may execute against.
function forbiddenShortFlagJoinedOverride(region: readonly string[]): string | undefined {
  for (const arg of region) {
    if (arg === "-c" || !arg.startsWith("-c")) continue;
    const key = configKeyFromSpec(arg.slice(2).replace(/^=/u, ""));
    if (isDangerousConfigKey(key)) return `-c ${key}`;
  }
  return undefined;
}

function forbiddenConfigOverride(args: readonly string[]): string | undefined {
  const region = preSubcommandRegion(args);
  return (
    forbiddenTwoTokenConfigOverride(region) ??
    forbiddenConfigEnvJoinedOverride(region) ??
    forbiddenShortFlagJoinedOverride(region)
  );
}

interface OutputAccumulator {
  readonly chunks: Buffer[];
}

interface RunState {
  readonly stdout: OutputAccumulator;
  readonly stderr: OutputAccumulator;
  capturedBytes: number;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  settled: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

function newRunState(): RunState {
  return {
    stdout: { chunks: [] },
    stderr: { chunks: [] },
    capturedBytes: 0,
    truncated: false,
    timedOut: false,
    aborted: false,
    settled: false,
    killTimer: undefined,
  };
}

function terminateWithEscalation(state: RunState, child: ChildProcess): void {
  if (state.killTimer !== undefined) return;
  child.kill("SIGTERM");
  state.killTimer = setTimeout(() => {
    child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  state.killTimer.unref();
}

function captureChunk(
  state: RunState,
  child: ChildProcess,
  sink: OutputAccumulator,
  chunk: Buffer,
  maxBytes: number,
): void {
  const remaining = maxBytes - state.capturedBytes;
  if (remaining > 0) {
    sink.chunks.push(chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk);
    state.capturedBytes = Math.min(maxBytes, state.capturedBytes + chunk.byteLength);
  }
  if (chunk.byteLength > remaining) {
    state.truncated = true;
    terminateWithEscalation(state, child);
  }
}

// KEIKO-0733: a raw byte-index cut (captureChunk) can bisect a multi-byte UTF-8 codepoint, leaving
// a dangling lead byte (or lead byte plus a partial run of continuation bytes) at the very end of
// the captured buffer. `Buffer#toString("utf8")` decodes that dangling tail as U+FFFD, which is a
// decoding artifact of the cut, not anything git actually emitted. Scan back up to 3 bytes from the
// end to find and drop an incomplete trailing lead-byte sequence before decoding, so a truncated
// capture never surfaces a replacement character it didn't earn.
function trimIncompleteUtf8Tail(buffer: Buffer): Buffer {
  const length = buffer.length;
  const maxScan = Math.min(3, length);
  for (let distanceFromEnd = 1; distanceFromEnd <= maxScan; distanceFromEnd += 1) {
    const byte = buffer[length - distanceFromEnd];
    if (byte === undefined) break;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte — keep scanning back for its lead byte
    const sequenceLength = utf8LeadByteSequenceLength(byte);
    if (sequenceLength === undefined) return buffer; // not a multi-byte lead byte — nothing to trim
    return sequenceLength > distanceFromEnd ? buffer.subarray(0, length - distanceFromEnd) : buffer;
  }
  return buffer;
}

// Returns the total codepoint byte length a UTF-8 lead byte announces, or undefined for an ASCII
// byte / a byte that is not a valid multi-byte lead byte.
function utf8LeadByteSequenceLength(byte: number): number | undefined {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return undefined;
}

function decodeCapturedStream(sink: OutputAccumulator, truncated: boolean): string {
  const buffer = Buffer.concat(sink.chunks);
  return (truncated ? trimIncompleteUtf8Tail(buffer) : buffer).toString("utf8");
}

function runResult(
  state: RunState,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): GitProcessResult {
  return {
    exitCode,
    signal,
    stdout: decodeCapturedStream(state.stdout, state.truncated),
    stderr: decodeCapturedStream(state.stderr, state.truncated),
    truncated: state.truncated,
    timedOut: state.timedOut,
    aborted: state.aborted,
  };
}

const SPAWN_ERROR_RESULT: Omit<GitProcessResult, "truncated" | "timedOut" | "aborted"> = {
  exitCode: 127,
  signal: null,
  stdout: "",
  stderr: "git executable unavailable",
};

// KEIKO-0263: a resolver rejection whose cause is "an executable exists on PATH but it lives in
// a location this process must not trust" (workspace-contained, group- or world-writable) is a
// distinct operator concern from "git is not installed". Callers see the same exit-127 shape as
// today (existing consumers unchanged), but the stderr now names the class so a planted-binary
// indicator is not silently squashed into "git executable unavailable". No filesystem path is
// leaked — the message states the class, never the location.
const SPAWN_UNTRUSTED_RESULT: Omit<GitProcessResult, "truncated" | "timedOut" | "aborted"> = {
  exitCode: 127,
  signal: null,
  stdout: "",
  stderr: "git executable in untrusted location refused",
  // The structured half of the same fact. The stderr above already names the class, but stderr is
  // not body-free and never reaches an activity log, so without this field a planted-binary
  // indicator and a plain "git is not installed" are the same exit-127 `git-missing` to every
  // consumer that cannot read the message (AGENTS.md §8 Rule 1).
  refusal: "untrusted-executable",
};

function refusedOptionResult(forbidden: string, refusal: GitRefusalClass): GitProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: `refused git option: ${forbidden.split("=")[0] ?? forbidden}`,
    truncated: false,
    timedOut: false,
    // `aborted` is optional only so pre-existing fake literals stay assignable; types.ts states the
    // real runner always sets it, and this is a real-runner terminal result. Setting it explicitly
    // means a consumer never has to read "absent" as a third state on this path.
    aborted: false,
    refusal,
  };
}

function abortedProcessResult(): GitProcessResult {
  return {
    exitCode: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    truncated: true,
    timedOut: false,
    aborted: true,
  };
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface GitRefusal {
  readonly forbidden: string;
  readonly refusal: GitRefusalClass;
}

// One ordered table instead of a `??` chain of three differently-shaped calls: the class travels
// WITH the predicate that decides it, so a fourth preflight cannot be added without naming what it
// refuses. The predicates, and the order they run in, are unchanged from the chain this replaces —
// first match wins, exactly as `??` short-circuited.
const REFUSAL_CHECKS: readonly (readonly [
  GitRefusalClass,
  (args: readonly string[]) => string | undefined,
])[] = [
  ["remote-command-option", forbiddenGitOption],
  ["diff-enabling-flag", forbiddenDiffEnablingFlag],
  ["config-override", forbiddenConfigOverride],
];

function firstRefusal(args: readonly string[]): GitRefusal | undefined {
  for (const [refusal, check] of REFUSAL_CHECKS) {
    const forbidden = check(args);
    if (forbidden !== undefined) return { forbidden, refusal };
  }
  return undefined;
}

function gitSpawnPreflight(
  args: readonly string[],
  options: GitProcessOptions,
): GitProcessResult | undefined {
  // Fail closed before the spawn: a remote-command option, an external-diff/textconv enabling
  // flag, or a `-c`/`--config-env` override of a dangerous config key is refused here so none of
  // them can ever reach the child process — however they got into `args` (audit finding #3348).
  // Each check names its own `GitRefusalClass` so the refusal stays a structured fact a consumer
  // can log body-free (AGENTS.md §8 Rule 1); the raw token stays in `stderr` and goes no further.
  const refused = firstRefusal(args);
  if (refused !== undefined) return refusedOptionResult(refused.forbidden, refused.refusal);
  return signalIsAborted(options.abortSignal) ? abortedProcessResult() : undefined;
}

function wireGitProcessEvents(
  child: ChildProcess,
  state: RunState,
  maxBytes: number,
  settle: (result: GitProcessResult) => void,
): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    captureChunk(state, child, state.stdout, chunk, maxBytes);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    captureChunk(state, child, state.stderr, chunk, maxBytes);
  });
  child.on("error", () => {
    settle({
      ...SPAWN_ERROR_RESULT,
      truncated: state.truncated,
      timedOut: state.timedOut,
      aborted: state.aborted,
    });
  });
  child.on("close", (exitCode, signal) => {
    settle(runResult(state, exitCode, signal));
  });
}

function createGitProcessRunnerWithFixedArgs(
  buildEnv: () => NodeJS.ProcessEnv,
  fixedArgs: readonly string[],
): GitProcessRunner {
  return (args, options) =>
    new Promise((resolveResult) => {
      // Fail closed before the spawn: a remote-command option (`--upload-pack`/`--receive-pack`/
      // `--exec`) in the args — however it got there — is refused, so git can never be steered
      // into executing an arbitrary local command via a hostile URL argument.
      const preflight = gitSpawnPreflight(args, options);
      if (preflight !== undefined) {
        resolveResult(preflight);
        return;
      }
      const env = buildEnv();
      const resolution = resolveGitExecutable(env, options.cwd);
      if (!resolution.ok) {
        const base =
          resolution.reason === "untrusted-location" ? SPAWN_UNTRUSTED_RESULT : SPAWN_ERROR_RESULT;
        resolveResult({ ...base, truncated: false, timedOut: false, aborted: false });
        return;
      }
      const child = spawn(resolution.path, [...fixedArgs, ...withDiffFamilyNeutralized(args)], {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const state = newRunState();
      const onAbort = (): void => {
        state.truncated = true;
        state.aborted = true;
        terminateWithEscalation(state, child);
      };
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (signalIsAborted(options.abortSignal)) onAbort();
      const timer = setTimeout(() => {
        state.truncated = true;
        state.timedOut = true;
        terminateWithEscalation(state, child);
      }, options.timeoutMs);
      const settle = (result: GitProcessResult): void => {
        if (state.settled) return;
        state.settled = true;
        clearTimeout(timer);
        if (state.killTimer !== undefined) clearTimeout(state.killTimer);
        options.abortSignal?.removeEventListener("abort", onAbort);
        resolveResult(result);
      };
      wireGitProcessEvents(child, state, options.maxBytes, settle);
    });
}

export function createGitProcessRunner(buildEnv: () => NodeJS.ProcessEnv): GitProcessRunner {
  return createGitProcessRunnerWithFixedArgs(buildEnv, []);
}

// Local reads use the hardened, config-isolated env; network sync needs credential account state
// but command-overrides repository-controlled executable config and never prompts — see env.ts.
export const defaultGitProcessRunner: GitProcessRunner = createGitProcessRunnerWithFixedArgs(
  gitEnv,
  LOCAL_READ_CONFIG_ARGS,
);

export const defaultGitNetworkProcessRunner: GitProcessRunner = createGitProcessRunnerWithFixedArgs(
  networkGitEnv,
  NETWORK_CONFIG_ARGS,
);
