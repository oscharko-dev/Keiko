import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const LIFECYCLE_PORT = 4388;

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

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-script-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

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
    it("start fails with guidance when dist assets are missing", () => {
      // Point ROOT-derived asset paths at a tree with no dist by running with a state dir only;
      // when dist IS present locally this asserts nothing useful, so guard on the negative case.
      if (DIST_READY) {
        return; // covered by the lifecycle test instead
      }
      const r = run(["start"], {
        KEIKO_STATE_DIR: stateDir,
        KEIKO_UI_PORT: String(LIFECYCLE_PORT),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("build assets missing");
    });
  });

  describe.skipIf(!DIST_READY)("full lifecycle (requires built dist/)", () => {
    const lifecycleEnv = (): Record<string, string> => ({
      KEIKO_STATE_DIR: stateDir,
      KEIKO_UI_PORT: String(LIFECYCLE_PORT),
    });

    afterEach(() => {
      run(["stop"], lifecycleEnv());
    });

    it("starts healthy, reports running, and stops cleanly", async () => {
      const start = run(["start"], lifecycleEnv());
      expect(start.status).toBe(0);
      expect(start.stdout).toContain("running");

      const health = await fetch(`http://127.0.0.1:${String(LIFECYCLE_PORT)}/api/health`);
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
    });
  });
});
