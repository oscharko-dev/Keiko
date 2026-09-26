import { lstatSync, mkdirSync, mkdtempSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanStateDir } from "./update-local-state-scan.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    opendirSync: vi.fn(actual.opendirSync),
  };
});

const tempRoots: string[] = [];
const lstatSyncMock = vi.mocked(lstatSync);
const opendirSyncMock = vi.mocked(opendirSync);

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-update-scan-"));
  tempRoots.push(root);
  const state = join(root, ".keiko");
  mkdirSync(join(state, "memory"), { recursive: true });
  writeFileSync(join(state, "memory", "memory.db"), "sealed", "utf8");
  return state;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  lstatSyncMock.mockClear();
  opendirSyncMock.mockClear();
});

describe("bounded update local-state scanner", () => {
  it.each([
    {
      name: "entry count",
      options: { maxEntries: 1 },
      limit: "entry-count",
    },
    {
      name: "depth",
      options: { maxDepth: 0 },
      limit: "depth",
    },
    {
      name: "relative path bytes",
      options: { maxRelativePathBytes: 5 },
      limit: "relative-path-bytes",
    },
  ] as const)("reports the $name limit as incomplete", ({ options, limit }) => {
    expect(scanStateDir(stateDir(), options)).toMatchObject({
      status: "directory",
      completion: "incomplete",
      limit,
    });
  });

  it("uses a monotonic injected clock for the elapsed-time limit", () => {
    let elapsed = 0;
    const scan = scanStateDir(stateDir(), {
      maxDurationMs: 1,
      now: () => {
        elapsed += 1;
        return elapsed;
      },
    });

    expect(scan).toMatchObject({
      status: "directory",
      completion: "incomplete",
      limit: "elapsed-time",
    });
  });

  it("does not stat an entry when reading it exhausts the elapsed-time budget", () => {
    const readings = [0, 0, 0, 2];
    const scan = scanStateDir(stateDir(), {
      maxDurationMs: 1,
      now: () => readings.shift() ?? 2,
    });

    expect(scan).toMatchObject({
      completion: "incomplete",
      limit: "elapsed-time",
      files: [],
      directories: [],
    });
    expect(lstatSyncMock).toHaveBeenCalledTimes(1);
    expect(opendirSyncMock).toHaveBeenCalledTimes(1);
  });

  it("returns a complete scan when all entries fit inside the limits", () => {
    const scan = scanStateDir(stateDir(), {
      maxEntries: 10,
      maxDepth: 4,
      maxRelativePathBytes: 128,
      maxDurationMs: 1_000,
      now: () => 0,
    });

    expect(scan).toMatchObject({ completion: "complete", status: "directory" });
    expect(scan.files.map((entry) => entry.relPath)).toEqual(["memory/memory.db"]);
  });
});
