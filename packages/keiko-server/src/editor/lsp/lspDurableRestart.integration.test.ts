import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const ownedPids: number[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of ownedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The exact test-owned child may already have exited.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable LSP quarantine across an actual supervisor-process boundary", () => {
  it("blocks process B while the detached child left by process A is still alive", () => {
    const stateDir = temporaryRoot("keiko-lsp-restart-state-");
    const workspaceRoot = temporaryRoot("keiko-lsp-restart-workspace-");
    const childPidPath = join(stateDir, "fixture-child-pid");
    const resultPath = join(stateDir, "replacement-result");
    const spawnMarkerPath = join(stateDir, "replacement-spawned");
    const fixture = fileURLToPath(
      new URL("./testing/lspDurableRestartProcess.mjs", import.meta.url),
    );
    const fixtureArgs = [stateDir, workspaceRoot, childPidPath, resultPath, spawnMarkerPath];

    const owner = spawnSync(process.execPath, [fixture, "owner", ...fixtureArgs], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(owner.status, owner.stderr).toBe(0);
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    ownedPids.push(childPid);
    expect(processExists(childPid)).toBe(true);

    const replacement = spawnSync(process.execPath, [fixture, "replacement", ...fixtureArgs], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(replacement.status, replacement.stderr).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      status: "CRASHED",
      retained: true,
    });
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(processExists(childPid)).toBe(true);
  });
});
