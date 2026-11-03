import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readUiLifecycleTracking,
  writeExclusivePidFile,
  writePendingUiLaunch,
} from "./state-paths.js";

interface PublicationFault {
  mode: "none" | "short" | "flush" | "close" | "rename";
  paths: Map<number, string>;
  writes: number;
  legacyBytes: number;
}

const fault = vi.hoisted<PublicationFault>(() => ({
  mode: "none",
  paths: new Map<number, string>(),
  writes: 0,
  legacyBytes: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const staged = (fd: number): boolean => (fault.paths.get(fd) ?? "").includes(".launcher-state-");
  const fail = (): never => {
    fault.mode = "none";
    throw Object.assign(new Error("Fixture I/O failure"), { code: "EIO" });
  };
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      const fd = actual.openSync(...args);
      if (typeof args[0] === "string") fault.paths.set(fd, args[0]);
      return fd;
    },
    writeSync: (...args: unknown[]): number => {
      const fd = args[0],
        value = args[1];
      if (
        fault.mode === "short" &&
        typeof fd === "number" &&
        fault.paths.get(fd)?.endsWith("ui.pid") &&
        (typeof value === "string" || Buffer.isBuffer(value))
      ) {
        if (fault.writes++ > 0) return fail();
        const bytes = typeof value === "string" ? Buffer.from(value) : value;
        return actual.writeSync(fd, bytes, 0, fault.legacyBytes, null);
      }
      const result: unknown = Reflect.apply(actual.writeSync, undefined, args);
      if (typeof result !== "number") throw new TypeError("Unexpected write result");
      return result;
    },
    fsyncSync: (fd: number): void => {
      if (fault.mode === "flush" && staged(fd)) fail();
      actual.fsyncSync(fd);
    },
    closeSync: (fd: number): void => {
      const failure = fault.mode === "close" && staged(fd);
      actual.closeSync(fd);
      fault.paths.delete(fd);
      if (failure) fail();
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>): void => {
      if (fault.mode === "rename" && String(args[0]).includes(".launcher-state-")) fail();
      actual.renameSync(...args);
    },
  };
});

const roots: string[] = [];
const launchId = "c".repeat(32),
  pid = 45678;
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-publish-"));
  roots.push(root);
  mkdirSync(join(root, "state"), { mode: 0o700 });
  const legacy = join(root, "legacy.pid");
  writeExclusivePidFile(legacy, pid, launchId, true);
  fault.legacyBytes = readFileSync(legacy).length;
  return join(root, "state", "ui.pid");
}

afterEach(() => {
  fault.mode = "none";
  fault.writes = 0;
  fault.paths.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("atomic native PID publication", () => {
  it.each(["short", "flush", "close", "rename"] as const)(
    "retains the exact pending attempt after a real staged %s failure",
    (mode) => {
      const path = fixture();
      writePendingUiLaunch(path, launchId);
      const before = readFileSync(path);
      fault.mode = mode;
      let failed = false;
      try {
        writeExclusivePidFile(path, pid, launchId, true, true);
      } catch {
        failed = true;
      }
      expect(readFileSync(path)).toEqual(before);
      expect(readUiLifecycleTracking(path)).toEqual({ kind: "starting", launchId });
      expect(failed).toBe(true);
    },
  );

  it("publishes a complete native record over its exact reserved attempt", () => {
    const path = fixture();
    writePendingUiLaunch(path, launchId);
    writeExclusivePidFile(path, pid, launchId, true, true);
    expect(readUiLifecycleTracking(path)).toEqual({
      kind: "process",
      record: {
        pid,
        launchId,
        browserOpenSupported: true,
        nativeAppRuntime: true,
      },
    });
  });

  it("retains a different pending generation", () => {
    const path = fixture();
    writePendingUiLaunch(path, "d".repeat(32));
    expect(() => {
      writeExclusivePidFile(path, pid, launchId, true, true);
    }).toThrow();
    expect(readUiLifecycleTracking(path)).toEqual({ kind: "starting", launchId: "d".repeat(32) });
  });

  it.each(["native-app-v", "native-app-v2\n", "native-app-v1", "native-app-v1\nextra\n"])(
    "retains an unknown or truncated capability %j",
    (suffix) => {
      const path = fixture();
      writeExclusivePidFile(path, pid, launchId, true);
      const legacy = readFileSync(path);
      writeFileSync(path, Buffer.concat([legacy, Buffer.from(suffix)]));
      expect(readUiLifecycleTracking(path)).toEqual({ kind: "unknown" });
    },
  );
});
