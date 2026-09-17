import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  cliControlStateLexicallyWouldMutateTarget,
  cliControlStateWouldMutateTarget,
  cliTargetIdentitySha256,
  resolveCliControlFailureStateDir,
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

  it("uses a separate fixed location for control-root refusal evidence", () => {
    expect(resolveCliControlFailureStateDir("linux", "/home/alice")).toBe(
      "/home/alice/.cache/keiko/control-failures",
    );
    expect(resolveCliControlFailureStateDir("darwin", "/Users/alice")).toBe(
      "/Users/alice/Library/Caches/Keiko/control-failures",
    );
    expect(resolveCliControlFailureStateDir("win32", String.raw`C:\Users\alice`)).toBe(
      String.raw`C:\Users\alice\AppData\Local\KeikoControlFailures`,
    );
  });

  it("provides a conservative lexical check when canonical validation cannot complete", () => {
    expect(cliControlStateLexicallyWouldMutateTarget("/state/control", "/state")).toBe(true);
    expect(cliControlStateLexicallyWouldMutateTarget("/control", "/state")).toBe(false);
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

describe("cliTargetIdentitySha256", () => {
  it("is stable, body-free, and distinguishes normalized targets", () => {
    const first = cliTargetIdentitySha256("/tmp/forensic-a/../forensic-a");
    const same = cliTargetIdentitySha256("/tmp/forensic-a");
    const second = cliTargetIdentitySha256("/tmp/forensic-b");

    expect(first).toBe(same);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toContain("forensic");
  });
});
