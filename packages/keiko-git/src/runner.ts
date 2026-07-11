// Single hardened git spawn path. Owns process lifecycle, byte caps, wall-clock timeout with
// SIGTERM→SIGKILL escalation, and spawn-error mapping. `buildEnv` is the only seam — local reads
// pass the config-isolated `gitEnv`, network sync passes the credential-capable `networkGitEnv`;
// everything else is identical, so every consumer inherits the same bounded-output behaviour.

import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { gitEnv, networkGitEnv } from "./env.js";
import type { GitProcessResult, GitProcessRunner } from "./types.js";

// Grace period between SIGTERM and SIGKILL: a git process that ignores SIGTERM (stuck on a dead
// filesystem, wedged hook) must never wedge the caller for longer than the timeout plus this.
const KILL_GRACE_MS = 2_000;

// Args every git invocation should carry: never page, and never take optional locks — a Keiko
// read must not block the user's own concurrent git commands on the same repository.
export const GIT_BASE_ARGS: readonly string[] = ["--no-pager", "--no-optional-locks"];

// Repository-local configuration is intentionally still visible for ordinary repository data,
// but executable read helpers must never run. This fixed override is injected by the local runner
// before every caller-supplied argument, so no route can accidentally omit it.
const LOCAL_READ_CONFIG_ARGS: readonly string[] = ["-c", "core.fsmonitor=false"];

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

interface OutputAccumulator {
  readonly chunks: Buffer[];
  bytes: number;
}

interface RunState {
  readonly stdout: OutputAccumulator;
  readonly stderr: OutputAccumulator;
  truncated: boolean;
  timedOut: boolean;
  settled: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

function newRunState(): RunState {
  return {
    stdout: { chunks: [], bytes: 0 },
    stderr: { chunks: [], bytes: 0 },
    truncated: false,
    timedOut: false,
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
  const remaining = maxBytes - sink.bytes;
  if (remaining > 0) {
    sink.chunks.push(chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk);
    sink.bytes = Math.min(maxBytes, sink.bytes + chunk.byteLength);
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
  };
}

const SPAWN_ERROR_RESULT: Omit<GitProcessResult, "truncated" | "timedOut"> = {
  exitCode: 127,
  signal: null,
  stdout: "",
  stderr: "git executable unavailable",
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

function createGitProcessRunnerWithFixedArgs(
  buildEnv: () => NodeJS.ProcessEnv,
  fixedArgs: readonly string[],
): GitProcessRunner {
  return (args, options) =>
    new Promise((resolveResult) => {
      // Fail closed before the spawn: a remote-command option (`--upload-pack`/`--receive-pack`/
      // `--exec`) in the args — however it got there — is refused, so git can never be steered
      // into executing an arbitrary local command via a hostile URL argument.
      const forbidden = forbiddenGitOption(args);
      if (forbidden !== undefined) {
        resolveResult(refusedOptionResult(forbidden));
        return;
      }
      const child = spawn("git", [...fixedArgs, ...args], {
        cwd: options.cwd,
        env: buildEnv(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const state = newRunState();
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
        resolveResult(result);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        captureChunk(state, child, state.stdout, chunk, options.maxBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        captureChunk(state, child, state.stderr, chunk, options.maxBytes);
      });
      child.on("error", () => {
        settle({ ...SPAWN_ERROR_RESULT, truncated: state.truncated, timedOut: state.timedOut });
      });
      child.on("close", (exitCode, signal) => {
        settle(runResult(state, exitCode, signal));
      });
    });
}

export function createGitProcessRunner(buildEnv: () => NodeJS.ProcessEnv): GitProcessRunner {
  return createGitProcessRunnerWithFixedArgs(buildEnv, []);
}

// Local reads use the hardened, config-isolated env; network sync needs the user's credential
// configuration but must still never prompt (fail-closed) — see env.ts.
export const defaultGitProcessRunner: GitProcessRunner = createGitProcessRunnerWithFixedArgs(
  gitEnv,
  LOCAL_READ_CONFIG_ARGS,
);

export const defaultGitNetworkProcessRunner: GitProcessRunner =
  createGitProcessRunner(networkGitEnv);
