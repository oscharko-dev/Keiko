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

export function createGitProcessRunner(buildEnv: () => NodeJS.ProcessEnv): GitProcessRunner {
  return (args, options) =>
    new Promise((resolveResult) => {
      const child = spawn("git", args, {
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

// Local reads use the hardened, config-isolated env; network sync needs the user's credential
// configuration but must still never prompt (fail-closed) — see env.ts.
export const defaultGitProcessRunner: GitProcessRunner = createGitProcessRunner(gitEnv);

export const defaultGitNetworkProcessRunner: GitProcessRunner =
  createGitProcessRunner(networkGitEnv);
