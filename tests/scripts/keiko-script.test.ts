import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives the real scripts/keiko.sh through a child bash. No mocks: these tests exercise the actual
// lifecycle logic. State (pid/log) is redirected to a per-test temp dir via KEIKO_STATE_DIR so a run
// never touches the repo's .keiko/ or a developer's running instance.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "keiko.sh");
const ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const STATIC_DIR = join(REPO_ROOT, "dist", "ui", "static");

// The full start→health→stop path needs the built assets and a free socket; in the `ci` job dist/ is
// absent (it does not build), so that one test skips there and runs wherever the package is built.
const DIST_READY = existsSync(ENTRY) && existsSync(STATIC_DIR);

// Probes an OS-assigned ephemeral port and releases it immediately. The port is then handed to
// a SEPARATE process (scripts/keiko.sh, which spawns its own `node` child), so the probe-then-
// release-then-reuse handoff is inherently non-atomic: nothing holds the port reserved between
// this function returning and that other process's own bind(). On a busy machine an unrelated
// process can win that gap. Callers that spawn a real listener on the returned port must treat a
// resulting EADDRINUSE as retryable-with-a-fresh-port, not as a defect (see startLifecycle below).
function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) {
          resolvePort(address.port);
          return;
        }
        reject(new Error("failed to allocate a loopback test port"));
      });
    });
  });
}

function run(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 45_000,
    env: { ...process.env, ...env },
  });
}

describe("scripts/keiko.sh", () => {
  let stateDir: string;
  let lifecyclePort: number;

  beforeEach(async () => {
    // macOS exposes its temporary directory through `/var`, which resolves through the
    // `/var -> /private/var` compatibility symlink. The production path boundary correctly
    // refuses symlinked ancestors, so the fixture must hand it the canonical directory it created.
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-script-")));
    lifecyclePort = await freeLoopbackPort();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  // freeLoopbackPort()'s probe-then-release is not atomic with a spawned process's own bind (see
  // that function's comment), so an unrelated process occasionally wins the race and the child
  // exits with EADDRINUSE. A port collision and a child that was never scheduled to bind before
  // its own caller gave up (KEIKO-3157 Codex P2, second round) are the same *shape* of problem: an
  // environmental precondition this test needs that the machine did not guarantee on this
  // specific try. One bounded-retry mechanism serves both, parameterized only by how each caller
  // recognizes its own failure signature -- reprobing a fresh port before each retry, so any
  // other failure -- a real product defect -- still surfaces through whatever assertion the
  // caller makes on the result a persistent failure is returned as-is.
  const ENVIRONMENTAL_RETRY_LIMIT = 2;

  async function retryOnEnvironmentalFailure(
    attempt: () => SpawnSyncReturns<string>,
    isEnvironmentalFailure: (result: SpawnSyncReturns<string>) => boolean,
  ): Promise<SpawnSyncReturns<string>> {
    for (let i = 0; ; i += 1) {
      const result = attempt();
      if (!isEnvironmentalFailure(result) || i >= ENVIRONMENTAL_RETRY_LIMIT) {
        return result;
      }
      lifecyclePort = await freeLoopbackPort();
    }
  }

  async function retryOnPortCollision(
    attempt: () => SpawnSyncReturns<string>,
  ): Promise<SpawnSyncReturns<string>> {
    return retryOnEnvironmentalFailure(
      attempt,
      (result) => result.status !== 0 && result.stderr.includes("EADDRINUSE"),
    );
  }

  describe("usage", () => {
    it("prints help and exits 0", () => {
      const r = run(["help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Usage:");
      for (const sub of ["start", "stop", "restart", "status"]) {
        expect(r.stdout).toContain(sub);
      }
    });

    it("exits 2 on an unknown command", () => {
      const r = run(["definitely-not-a-command"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("unknown command");
    });

    it("exits 2 when no command is given", () => {
      const r = run([]);
      expect(r.status).toBe(2);
    });
  });

  describe("status / stop without a running server", () => {
    it("status reports not running and exits 0", () => {
      const r = run(["status"], { KEIKO_STATE_DIR: stateDir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("not running");
    });

    it("stop is idempotent when nothing is running", () => {
      const r = run(["stop"], { KEIKO_STATE_DIR: stateDir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("not running");
    });
  });

  describe("timeout validation", () => {
    // The validation runs before any asset check or process work, so it returns 2
    // regardless of whether dist/ is built.
    it("rejects a non-numeric start timeout with exit 2", () => {
      const r = run(["start"], { KEIKO_STATE_DIR: stateDir, KEIKO_START_TIMEOUT_SECS: "abc" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("KEIKO_START_TIMEOUT_SECS must be a positive integer");
    });

    it("rejects a non-positive stop timeout with exit 2", () => {
      const r = run(["stop"], { KEIKO_STATE_DIR: stateDir, KEIKO_STOP_TIMEOUT_SECS: "0" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("KEIKO_STOP_TIMEOUT_SECS must be a positive integer");
    });

    it("rejects a non-loopback host before starting the control plane", () => {
      const r = run(["start"], {
        KEIKO_STATE_DIR: stateDir,
        KEIKO_UI_HOST: "0.0.0.0",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("KEIKO_UI_HOST must be 127.0.0.1 or localhost");
    });

    it("keeps the audited S5332 disposition on the validated loopback sink", () => {
      const lines = readFileSync(SCRIPT, "utf8").split("\n");
      const sink = lines.findIndex((line) => line.includes('curl -fsS "$HEALTH_URL"'));
      expect(sink).toBeGreaterThan(0);
      expect(lines[sink - 1]).toContain("strict loopback allowlist");
      expect(lines[sink]).toContain("# NOSONAR");
      expect(lines.find((line) => line.startsWith('LOOPBACK_ORIGIN="http'))).not.toContain(
        "NOSONAR",
      );
    });
  });

  describe("pid-file hygiene", () => {
    it("clears a stale pid file pointing at a dead process", () => {
      const pidFile = join(stateDir, "ui.pid");
      writeFileSync(pidFile, "999999\n"); // a pid that is not alive
      const r = run(["status"], { KEIKO_STATE_DIR: stateDir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("not running");
      expect(existsSync(pidFile)).toBe(false);
    });

    it("does not treat or kill an unrelated live process as the UI (recycled pid)", async () => {
      // A long-lived process whose command line is NOT the Keiko UI.
      const decoy = spawn("sleep", ["60"], { stdio: "ignore" });
      await new Promise<void>((res, rej) => {
        decoy.once("spawn", res);
        decoy.once("error", rej);
      });
      const decoyPid = decoy.pid;
      expect(decoyPid).toBeTypeOf("number");
      if (decoyPid === undefined) throw new Error("decoy process did not report a pid");

      try {
        const pidFile = join(stateDir, "ui.pid");
        writeFileSync(pidFile, `${String(decoyPid)}\n`);

        const status = run(["status"], { KEIKO_STATE_DIR: stateDir });
        expect(status.status).toBe(0);
        expect(status.stdout).toContain("not running");

        const stop = run(["stop"], { KEIKO_STATE_DIR: stateDir });
        expect(stop.status).toBe(0);

        // The decoy must still be alive: the guard refused to signal a non-UI process.
        expect(decoy.killed).toBe(false);
        expect(() => process.kill(decoyPid, 0)).not.toThrow();
      } finally {
        decoy.kill("SIGKILL");
      }
    });
  });

  describe("build-asset guard", () => {
    it("start fails with guidance when dist assets are missing", (ctx) => {
      // Point ROOT-derived asset paths at a tree with no dist by running with a state dir only;
      // when dist IS present locally this asserts nothing useful, so guard on the negative case.
      if (DIST_READY) {
        ctx.skip(); // covered by the lifecycle test instead
      }
      const r = run(["start"], {
        KEIKO_STATE_DIR: stateDir,
        KEIKO_UI_PORT: String(lifecyclePort),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("build assets missing");
    });
  });

  describe.skipIf(!DIST_READY)("full lifecycle (requires built dist/)", () => {
    const lifecycleEnv = (): Record<string, string> => ({
      KEIKO_STATE_DIR: stateDir,
      KEIKO_UI_PORT: String(lifecyclePort),
      KEIKO_START_TIMEOUT_SECS: "60",
      KEIKO_STOP_TIMEOUT_SECS: "30",
    });

    afterEach(() => {
      run(["stop"], lifecycleEnv());
    });

    // scripts/keiko.sh's health poll bounds every curl attempt, so losing the port-collision
    // race (see retryOnPortCollision above) fails promptly and visibly instead of hanging.
    async function startLifecycle(): Promise<SpawnSyncReturns<string>> {
      return retryOnPortCollision(() => run(["start"], lifecycleEnv()));
    }

    it("starts healthy, reports running, and stops cleanly", async () => {
      const start = await startLifecycle();
      expect(start.status, `${start.stdout}\n${start.stderr}`).toBe(0);
      expect(start.stdout).toContain("running");

      const health = await fetch(`http://127.0.0.1:${String(lifecyclePort)}/api/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { status?: string };
      expect(body.status).toBe("ok");

      const pidFile = join(stateDir, "ui.pid");
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(pid)).toBe(true);

      const status = run(["status"], lifecycleEnv());
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("is running");

      const stop = run(["stop"], lifecycleEnv());
      expect(stop.status).toBe(0);
      expect(stop.stdout).toContain("stopped");
      expect(existsSync(pidFile)).toBe(false);

      const after = run(["status"], lifecycleEnv());
      expect(after.stdout).toContain("not running");
    }, 30_000);
  });

  describe("cmd_start health-poll deadline (KfQ #3156, scripts/keiko.sh)", () => {
    // A real port collision does not exercise this: the spawned `node dist/cli/index.js` crashes
    // on EADDRINUSE via an unhandled rejection well under a second after the attempt, so `kill -0`
    // stops seeing it as alive almost immediately -- it never stays around long enough to hang a
    // health check. To reproduce "accepts connections but never answers" (the scenario the code
    // comment above the curl call describes) without mocking keiko.sh itself, per this file's own
    // no-mocks rule, this points the REAL, unmodified script at a substitute dist/cli/index.js
    // under a throwaway root: identical script, identical logic, only the downstream server is a
    // stub. `ENTRY` is derived from the invoked script's own path (`$ROOT/dist/cli/index.js`), so
    // running a copy of keiko.sh from a fake root is the only way to control what it spawns.
    function writeFakeRoot(): string {
      const fakeRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-fake-root-")));
      mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
      cpSync(SCRIPT, join(fakeRoot, "scripts", "keiko.sh"));
      mkdirSync(join(fakeRoot, "dist", "cli"), { recursive: true });
      mkdirSync(join(fakeRoot, "dist", "ui", "static"), { recursive: true });
      writeFileSync(join(fakeRoot, "dist", "ui", "csp-hashes.json"), "{}");
      // CommonJS, and deliberately dependency-free: accepts a connection on --host/--port and
      // never writes a response, so every curl attempt against it runs to its own --max-time.
      // Also appends one byte to HEALTH_ATTEMPT_COUNTER_FILE per accepted connection when that
      // env var is set -- a discrete, scheduler-independent record of how many times the health
      // poll actually attempted a connection, used instead of wall-clock timing (KEIKO-3157
      // Codex P2 round 1). And writes HEALTH_STUB_READY_FILE the instant its own listen()
      // callback confirms the bind succeeded -- listen()'s callback fires only on a real,
      // completed bind, never speculatively -- so a caller can tell the difference between "the
      // stub never got scheduled to run this far" and "it ran and is genuinely listening"
      // (KEIKO-3157 Codex P2 round 2: see the assertion below for why this matters).
      writeFileSync(
        join(fakeRoot, "dist", "cli", "index.js"),
        [
          'const net = require("node:net");',
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          'const port = Number(args[args.indexOf("--port") + 1]);',
          'const host = args[args.indexOf("--host") + 1];',
          "const counterFile = process.env.HEALTH_ATTEMPT_COUNTER_FILE;",
          "const readyFile = process.env.HEALTH_STUB_READY_FILE;",
          "const server = net.createServer((socket) => {",
          '  if (counterFile) fs.appendFileSync(counterFile, "x");',
          "});",
          "server.listen(port, host, () => {",
          '  if (readyFile) fs.writeFileSync(readyFile, "1");',
          "});",
          "",
        ].join("\n"),
      );
      return fakeRoot;
    }

    it("bounds the number of health-check attempts by the deadline, not a fixed iteration count, when the health endpoint hangs", async () => {
      const fakeRoot = writeFakeRoot();
      const attemptCounterFile = join(fakeRoot, "attempts.count");
      const readyFile = join(fakeRoot, "stub.ready");
      try {
        const startTimeoutSecs = 4;
        // Codex P2 (#3157), round 2: the attempt counter proves the deadline behavior only if
        // the stub was actually listening while cmd_start's poll loop ran -- if the freshly
        // spawned Node stub is not scheduled to reach its own listen() call before the 4s
        // deadline elapses, every curl fails on connection-refused (not a timeout) before ever
        // reaching the stub's connection callback, attemptCount stays at 0, and the assertion
        // below would fail even though cmd_start expired exactly as it should. That is a
        // process-scheduling dependency in place of the wall-clock one round 1 removed --
        // deterministic *given* the stub is listening, and that precondition was not guaranteed.
        //
        // retryOnPortCollision does not cover this: a stub that was merely slow to be scheduled
        // produces no EADDRINUSE. But a stub that never got scheduled at all and a stub that
        // crashed on a port collision look identical from here -- neither ever reaches its own
        // listen() success callback, so neither ever writes HEALTH_STUB_READY_FILE. Checking for
        // that file's absence is a strict superset of the EADDRINUSE check: it is retried through
        // the same environmental-failure mechanism instead of a second, narrower one, so
        // retryOnPortCollision itself is not called here. The precondition this test needs -- the
        // stub was truly listening at some point during the kept run -- holds by construction of
        // the retry, not by hope for a single try: a run that never got there is discarded and
        // retried with a fresh port, bounded, exactly like every other environmental race this
        // file absorbs; a failure that survives every retry surfaces for real via the
        // existsSync(readyFile) assertion below rather than being silently accepted.
        const start = await retryOnEnvironmentalFailure(
          () => {
            writeFileSync(attemptCounterFile, "");
            rmSync(readyFile, { force: true });
            return spawnSync("bash", [join(fakeRoot, "scripts", "keiko.sh"), "start"], {
              encoding: "utf8",
              timeout: 45_000,
              env: {
                ...process.env,
                KEIKO_STATE_DIR: stateDir,
                KEIKO_UI_PORT: String(lifecyclePort),
                KEIKO_START_TIMEOUT_SECS: String(startTimeoutSecs),
                HEALTH_ATTEMPT_COUNTER_FILE: attemptCounterFile,
                HEALTH_STUB_READY_FILE: readyFile,
              },
            });
          },
          () => !existsSync(readyFile),
        );

        expect(start.status, `${start.stdout}\n${start.stderr}`).toBe(1);
        expect(start.stderr).toContain("did not become healthy");
        expect(existsSync(readyFile)).toBe(true);

        // The number of connection attempts the health poll actually made, now that the stub is
        // known to have been listening throughout, is a discrete, deterministic proxy for the
        // regression itself: a scheduler pause changes how long each attempt takes, never how
        // many the loop reaches, so this count cannot be inflated or deflated by machine load --
        // only by the loop's own control flow, which is exactly what regressed. Pre-fix,
        // cmd_start always made exactly startTimeoutSecs*2 attempts (a hardcoded iteration count,
        // independent of timing) -- 8 for this 4s budget, deterministically, every single run.
        // Post-fix, each attempt against a hung endpoint takes most of curl's --max-time, so the
        // wall-clock deadline caps it at roughly startTimeoutSecs/2 attempts plus at most one
        // more in flight when the deadline passes -- 2-3 here. Asserting strictly fewer than
        // startTimeoutSecs attempts sits at half of the pre-fix formula: unreachable under the
        // old iteration-counting bug (which never produces fewer than double this ceiling, for
        // any startTimeoutSecs), and clears the new deadline-bounded behavior with margin to
        // spare regardless of how fast or slow this specific run was.
        const attemptCount = readFileSync(attemptCounterFile, "utf8").length;
        expect(attemptCount).toBeGreaterThan(0);
        expect(attemptCount).toBeLessThan(startTimeoutSecs);
      } finally {
        rmSync(fakeRoot, { recursive: true, force: true });
      }
    }, 20_000);
  });
});
