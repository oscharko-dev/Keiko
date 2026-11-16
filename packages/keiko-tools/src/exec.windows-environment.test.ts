import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace } from "./_support.js";
import { defaultResolveExecutable } from "./exec.js";
import { CommandDeniedError } from "./errors.js";

let fixture: ReturnType<typeof makeWorkspace>;
let bin: string;

function executable(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, "synthetic executable identity; never spawned\n");
  chmodSync(path, 0o755);
  return realpathSync(path);
}

beforeEach(() => {
  fixture = makeWorkspace();
  bin = realpathSync(mkdtempSync(join(tmpdir(), "keiko-executable-env-")));
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("Windows executable lookup from copied environments", () => {
  it("resolves mixed-case Path and PATHEXT through the existing executable trust check", () => {
    const expected = executable(bin, "git.ALT");
    expect(
      defaultResolveExecutable("git", {
        workspace: fixture.info,
        processEnv: { Path: bin, PathExt: ".ALT" },
      }),
    ).toBe(expected);
  });

  it("uses the same first duplicate alias as the child environment", () => {
    const expected = executable(bin, "git.EXE");
    expect(
      defaultResolveExecutable("git", {
        workspace: fixture.info,
        processEnv: { Path: fixture.root, PATH: bin, PATHEXT: ".EXE" },
      }),
    ).toBe(expected);
  });

  it("still refuses an executable selected inside the workspace", () => {
    executable(fixture.root, "git.ALT");
    expect(() =>
      defaultResolveExecutable("git", {
        workspace: fixture.info,
        processEnv: { Path: fixture.root, PathExt: ".ALT" },
      }),
    ).toThrow("executable resolves inside workspace");
  });

  it("never falls back to an ambient executable when the copied PATH is absent", () => {
    expect(() =>
      defaultResolveExecutable("git", { workspace: fixture.info, processEnv: {} }),
    ).toThrow(CommandDeniedError);
  });
});
