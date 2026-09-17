import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  cliControlStateWouldMutateTarget,
  resolveCliControlStateDir,
} from "./cli-control-state.js";

describe("resolveCliControlStateDir", () => {
  it("uses fixed per-user platform locations without environment input", () => {
    expect(resolveCliControlStateDir("linux", "/home/alice")).toBe(
      "/home/alice/.local/state/keiko/control",
    );
    expect(resolveCliControlStateDir("darwin", "/Users/alice")).toBe(
      "/Users/alice/Library/Application Support/Keiko/control",
    );
    expect(resolveCliControlStateDir("win32", String.raw`C:\Users\alice`)).toBe(
      String.raw`C:\Users\alice\AppData\Local\Keiko\control`,
    );
  });
});

describe("cliControlStateWouldMutateTarget", () => {
  it("detects direct and canonicalized descendant overlap", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-control-overlap-"));
    const target = join(root, "target");
    const alias = join(root, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    try {
      expect(cliControlStateWouldMutateTarget(join(target, "control"), target)).toBe(true);
      expect(cliControlStateWouldMutateTarget(join(alias, "control"), target)).toBe(true);
      expect(cliControlStateWouldMutateTarget(join(root, "control"), target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
