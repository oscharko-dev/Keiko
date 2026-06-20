import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_DIR_NAME,
  KEIKO_STATE_FILES,
  classifyPid,
  defaultIsProcessAlive,
  readPidFile,
  resolveStateDir,
} from "./state-paths.js";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-state-paths-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveStateDir", () => {
  it("uses an explicit --state-dir argument over env and default", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "/env/state" }, "/explicit/state");
    expect(dir).toBe("/explicit/state");
  });

  it("resolves a relative --state-dir argument against cwd", () => {
    const dir = resolveStateDir("/cwd", {}, "custom-state");
    expect(dir).toBe(join("/cwd", "custom-state"));
  });

  it("falls back to KEIKO_STATE_DIR when no argument is given", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "/env/state" });
    expect(dir).toBe("/env/state");
  });

  it("ignores an empty-string argument and uses env", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "/env/state" }, "");
    expect(dir).toBe("/env/state");
  });

  it("defaults to <cwd>/.keiko when neither argument nor env is set", () => {
    const dir = resolveStateDir("/cwd", {});
    expect(dir).toBe(join("/cwd", DEFAULT_STATE_DIR_NAME));
    expect(isAbsolute(dir)).toBe(true);
  });

  it("resolves a relative KEIKO_STATE_DIR against cwd", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "rel" });
    expect(dir).toBe(join("/cwd", "rel"));
  });
});

describe("readPidFile", () => {
  it("returns undefined when the file is absent", () => {
    expect(readPidFile(join(makeRoot(), "ui.pid"))).toBeUndefined();
  });

  it("returns undefined for a non-numeric pid", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "not-a-pid\n", "utf8");
    expect(readPidFile(path)).toBeUndefined();
  });

  it("returns undefined for a zero or negative pid", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "0\n", "utf8");
    expect(readPidFile(path)).toBeUndefined();
  });

  it("parses a valid positive pid, trimming whitespace", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "  4242 \n", "utf8");
    expect(readPidFile(path)).toBe(4242);
  });
});

describe("defaultIsProcessAlive", () => {
  it("reports the current process as alive", () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
  });

  it("reports an unused high pid as not alive", () => {
    expect(defaultIsProcessAlive(2147483646)).toBe(false);
  });
});

describe("classifyPid", () => {
  it("classifies an absent pid file", () => {
    const result = classifyPid(join(makeRoot(), "ui.pid"), () => true);
    expect(result.state).toBe("absent");
    expect(result.pid).toBeUndefined();
  });

  it("classifies a recorded but dead pid as stale", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "1234\n", "utf8");
    const result = classifyPid(path, () => false);
    expect(result.state).toBe("stale");
    expect(result.pid).toBe(1234);
  });

  it("classifies a recorded and live pid as running", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "1234\n", "utf8");
    const result = classifyPid(path, () => true);
    expect(result.state).toBe("running");
    expect(result.pid).toBe(1234);
  });
});

describe("KEIKO_STATE_FILES", () => {
  it("enumerates the lifecycle and launcher state files", () => {
    expect(KEIKO_STATE_FILES).toContain("ui.pid");
    expect(KEIKO_STATE_FILES).toContain("ui.log");
    expect(KEIKO_STATE_FILES).toContain("launcher-state.json");
  });
});
