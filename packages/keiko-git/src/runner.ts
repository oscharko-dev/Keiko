// Single hardened git spawn path. Owns process lifecycle, a shared stdout/stderr byte cap,
// wall-clock timeout with SIGTERM→SIGKILL escalation, and spawn-error mapping. `buildEnv` is the
// only seam: local reads pass the config-isolated `gitEnv`, network sync passes the
// credential-capable `networkGitEnv`; everything else is identical, so every consumer inherits
// the same bounded-output behaviour.

import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { gitEnv, networkGitEnv } from "./env.js";
import { resolveGitExecutable } from "./git-executable.js";
import type { GitProcessOptions, GitProcessResult, GitProcessRunner } from "./types.js";

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

// Diff-family subcommands whose default behaviour can shell out to a repository-local
// `diff.external` helper, or run a repository-local `textconv` filter, unless the invocation
// carries `--no-ext-diff --no-textconv`. Injected right after the subcommand token at the single
// spawn boundary so no caller can silently reopen the gap by omitting the flags — mirroring how
// NETWORK_CONFIG_ARGS neutralizes remote-facing repository config regardless of the call site.
const DIFF_FAMILY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
]);
const DIFF_NO_EXTERNAL_ARGS: readonly string[] = ["--no-ext-diff", "--no-textconv"];

// Global flags this codebase's callers pass before the subcommand: GIT_BASE_ARGS'
// `--no-pager`/`--no-optional-locks` take no value, `-C <path>` takes one. Extend this set before
// any caller adds another pre-subcommand flag, or subcommand detection below stops one token early
// and the diff-family injection silently becomes a no-op for that call shape.
const PRE_SUBCOMMAND_FLAG_NO_VALUE: ReadonlySet<string> = new Set([
  "--no-pager",
  "--no-optional-locks",
]);

function findSubcommandIndex(args: readonly string[]): number | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-C") {
      index += 2;
      continue;
    }
    if (arg !== undefined && PRE_SUBCOMMAND_FLAG_NO_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    return arg !== undefined && !arg.startsWith("-") ? index : undefined;
  }
  return undefined;
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

function runResult(
  state: RunState,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): GitProcessResult {
  return {
    exitCode,
    signal,
    stdout: Buffer.concat(state.stdout.chunks).toString("utf8"),
    stderr: Buffer.concat(state.stderr.chunks).toString("utf8"),
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
};

function refusedOptionResult(forbidden: string): GitProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: `refused git option: ${forbidden.split("=")[0] ?? forbidden}`,
    truncated: false,
    timedOut: false,
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

function gitSpawnPreflight(
  args: readonly string[],
  options: GitProcessOptions,
): GitProcessResult | undefined {
  const forbidden = forbiddenGitOption(args);
  if (forbidden !== undefined) return refusedOptionResult(forbidden);
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
