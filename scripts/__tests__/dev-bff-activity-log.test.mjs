// The dev BFF's Activity Log lifecycle, proven on the real process. A live dev session showed every
// one of 15 code-change restarts leaving the previous process's segment active: the next process
// then recovered it as an orphan (`activity-log.segment.recovered`, a warn line each time), and no
// startup readiness check ever ran, so `/api/health` reported a readiness nothing had evaluated.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const devBff = join(repoRoot, "scripts", "dev-bff.mjs");
const LISTEN_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 40_000;
const children = new Set();
const dirs = [];

afterEach(() => {
  // A child still running after a failed assertion must not outlive the test or its directory.
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function childEnv(stateDir, projectDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("KEIKO_") && !key.startsWith("VITEST")) env[key] = value;
  }
  return {
    ...env,
    KEIKO_STATE_DIR: stateDir,
    KEIKO_DEV_BFF_PORT: "0",
    KEIKO_INITIAL_PROJECT_PATH: projectDir,
  };
}

function waitFor(child, predicate, timeoutMs, what) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`dev BFF did not ${what} in time; stderr: ${child.stderrTail ?? ""}`)),
      timeoutMs,
    );
    predicate(child, (value) => {
      clearTimeout(timer);
      resolvePromise(value);
    });
  });
}

// Starts the real dev BFF on an ephemeral port, stops it with SIGTERM once it listens (what the dev
// runner sends on a code-change restart), and returns its exit code.
async function startAndStop(stateDir, projectDir) {
  const child = spawn(process.execPath, [devBff], {
    cwd: repoRoot,
    env: childEnv(stateDir, projectDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stderrTail = "";
  child.stderr.on("data", (chunk) => {
    child.stderrTail = (child.stderrTail + String(chunk)).slice(-2_000);
  });
  const exited = waitFor(
    child,
    (proc, done) => proc.once("exit", (code) => done(code)),
    LISTEN_TIMEOUT_MS + EXIT_TIMEOUT_MS,
    "exit",
  );
  await waitFor(
    child,
    (proc, done) => {
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("[dev:bff] listening on")) done(undefined);
      });
    },
    LISTEN_TIMEOUT_MS,
    "listen",
  );
  child.kill("SIGTERM");
  const code = await exited;
  children.delete(child);
  return code;
}

function persistedLines(stateDir) {
  const logs = join(stateDir, "logs");
  const names = readdirSync(logs).filter((name) => name.startsWith("activity-"));
  const lines = names.flatMap((name) =>
    readFileSync(join(logs, name), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line)),
  );
  return { names, lines };
}

function lastLineOf(stateDir, name) {
  const text = readFileSync(join(stateDir, "logs", name), "utf8").trim();
  return JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
}

describe("dev BFF Activity Log lifecycle", () => {
  it("checks readiness at startup and seals its segment on every restart", async () => {
    // The UI store refuses a symlinked path; macOS tmpdir() sits behind /var -> /private/var.
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-bff-log-")));
    dirs.push(stateDir);
    const projectDir = join(stateDir, "project");
    mkdirSync(projectDir);

    expect(await startAndStop(stateDir, projectDir)).toBe(0);
    const first = persistedLines(stateDir);
    expect(first.names.filter((name) => name.endsWith(".active.jsonl"))).toEqual([]);
    expect(first.lines.filter((line) => line.op === "activity-log.readiness")).toEqual([
      expect.objectContaining({ trigger: "startup", readiness: "ready" }),
    ]);
    expect(first.names).toHaveLength(1);
    expect(lastLineOf(stateDir, first.names[0])).toMatchObject({
      op: "activity-log.segment.sealed",
      sealReason: "close",
    });

    // A restart on the same directory finds nothing to recover: its predecessor sealed itself.
    expect(await startAndStop(stateDir, projectDir)).toBe(0);
    const second = persistedLines(stateDir);
    expect(second.names.filter((name) => name.endsWith(".active.jsonl"))).toEqual([]);
    expect(second.lines.filter((line) => line.op === "activity-log.segment.recovered")).toEqual([]);
    expect(second.lines.filter((line) => line.op === "activity-log.readiness")).toHaveLength(2);
  }, 120_000);
});
