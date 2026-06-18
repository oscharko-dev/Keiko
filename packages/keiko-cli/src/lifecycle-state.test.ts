import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeState,
  isForeignLivePid,
  metaFilePath,
  pidFilePath,
  readLaunchMetadata,
  readPidFile,
  writeLaunchMetadata,
  writePidFile,
} from "./lifecycle-state.js";

const tempRoots: string[] = [];

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-state-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("lifecycle-state", () => {
  it("round-trips the pid file as a plain-PID payload", () => {
    const dir = makeStateDir();
    writePidFile(dir, 4242);

    expect(readFileSync(pidFilePath(dir), "utf8")).toBe("4242\n");
    expect(readPidFile(dir)).toBe(4242);
  });

  it("returns undefined for a missing or non-numeric pid file", () => {
    const dir = makeStateDir();
    expect(readPidFile(dir)).toBeUndefined();
    writeFileSync(pidFilePath(dir), "not-a-pid\n", "utf8");
    expect(readPidFile(dir)).toBeUndefined();
  });

  it("round-trips launch metadata with pid and bin path", () => {
    const dir = makeStateDir();
    writeLaunchMetadata(dir, 12345, "/local/dist/cli/index.js");

    const metadata = readLaunchMetadata(dir);
    expect(metadata?.pid).toBe(12345);
    expect(metadata?.binPath).toBe("/local/dist/cli/index.js");
    expect(typeof metadata?.startedAt).toBe("string");
  });

  it("treats missing metadata as not foreign so legacy flows are never blocked", () => {
    const dir = makeStateDir();
    expect(isForeignLivePid(dir, 12345)).toBe(false);
  });

  it("treats malformed metadata as not foreign", () => {
    const dir = makeStateDir();
    writeFileSync(metaFilePath(dir), "{ broken", "utf8");
    expect(isForeignLivePid(dir, 12345)).toBe(false);
  });

  it("rejects metadata whose binPath or startedAt fields have the wrong type", () => {
    const dir = makeStateDir();
    writeFileSync(
      metaFilePath(dir),
      JSON.stringify({ pid: 999, binPath: 42, startedAt: null }),
      "utf8",
    );

    expect(readLaunchMetadata(dir)).toBeUndefined();
    // A pid mismatch would normally be foreign, but invalid metadata must fall
    // through to legacy behavior rather than blocking a stop.
    expect(isForeignLivePid(dir, 12345)).toBe(false);
  });

  it("reports a foreign pid only when recorded metadata pid differs (pid reuse)", () => {
    const dir = makeStateDir();
    writeLaunchMetadata(dir, 999, "/x/index.js");

    expect(isForeignLivePid(dir, 12345)).toBe(true);
    expect(isForeignLivePid(dir, 999)).toBe(false);
  });

  it("clears both the pid and metadata files", () => {
    const dir = makeStateDir();
    writePidFile(dir, 1);
    writeLaunchMetadata(dir, 1, "/x");

    clearRuntimeState(dir);

    expect(readPidFile(dir)).toBeUndefined();
    expect(readLaunchMetadata(dir)).toBeUndefined();
  });
});
