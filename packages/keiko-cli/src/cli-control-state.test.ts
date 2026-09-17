import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  cliControlStateConflictsWithTarget,
  cliTargetIdentitySha256,
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

describe("cliControlStateConflictsWithTarget", () => {
  it("detects when the control root is directly or canonically below the target", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-control-overlap-"));
    const target = join(root, "target");
    const alias = join(root, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    try {
      expect(cliControlStateConflictsWithTarget(join(target, "control"), target)).toBe(true);
      expect(cliControlStateConflictsWithTarget(join(alias, "control"), target)).toBe(true);
      expect(cliControlStateConflictsWithTarget(join(root, "control"), target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a selected target nested below the canonical control root", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-control-parent-overlap-"));
    const control = join(root, "control");
    const alias = join(root, "alias");
    mkdirSync(control);
    symlinkSync(control, alias, "dir");
    try {
      expect(cliControlStateConflictsWithTarget(control, join(control, "logs"))).toBe(true);
      expect(cliControlStateConflictsWithTarget(alias, join(control, "logs"))).toBe(true);
      expect(cliControlStateConflictsWithTarget(control, join(root, "target"))).toBe(false);
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
