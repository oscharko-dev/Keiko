// ADR-0013 D6 — Path validation policy (fail-closed). Seven rules; each maps to a stable error code.
// These tests pin every branch so a single-line mutation in validateProjectPath is caught.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProjectPath, UiStoreError } from "./index.js";

let tmpDir: string;
let realDir: string;
let realFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keiko-validate-"));
  realDir = join(tmpDir, "project");
  mkdirSync(realDir, { recursive: true });
  realFile = join(tmpDir, "afile");
  writeFileSync(realFile, "x");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UiStoreError);
    expect((e as UiStoreError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

describe("validateProjectPath — happy path", () => {
  it("returns a normalized absolute path for an existing directory", () => {
    const out = validateProjectPath(realDir, { mustExist: true });
    expect(out).toBe(realDir);
  });

  it("accepts a path with redundant separators and normalizes", () => {
    const messy = `/${realDir.slice(1).replace(/\//g, "//")}`;
    const out = validateProjectPath(messy, { mustExist: true });
    expect(out).toBe(realDir);
  });

  it("skips the stat check when mustExist is false (PATCH/DELETE paths)", () => {
    const missing = join(tmpDir, "ghost-" + String(Date.now()));
    expect(() => validateProjectPath(missing, { mustExist: false })).not.toThrow();
  });
});

describe("validateProjectPath — fail-closed", () => {
  it("rejects a null-byte → invalid_path", () => {
    expectCode(
      () => validateProjectPath("/tmp/has\0null", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects a non-absolute path → invalid_path", () => {
    expectCode(() => validateProjectPath("relative/path", { mustExist: false }), "invalid_path");
  });

  it("rejects http:// remote URL → invalid_path", () => {
    expectCode(
      () => validateProjectPath("http://evil.example.com/x", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects ssh:// remote URL → invalid_path", () => {
    expectCode(() => validateProjectPath("ssh://host/x", { mustExist: false }), "invalid_path");
  });

  it("rejects file:// remote URL → invalid_path", () => {
    expectCode(
      () => validateProjectPath("file:///etc/passwd", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects Windows drive paths → invalid_path", () => {
    expectCode(
      () => validateProjectPath("C:\\Users\\dev\\repo", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects Windows UNC paths → invalid_path", () => {
    expectCode(
      () => validateProjectPath("\\\\server\\share\\repo", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects forward-slash UNC paths → invalid_path", () => {
    expectCode(
      () => validateProjectPath("//server/share/repo", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects Windows-style traversal segments → invalid_path", () => {
    expectCode(() => validateProjectPath("/tmp\\..\\etc", { mustExist: false }), "invalid_path");
  });

  it("rejects a path with a /../ traversal segment → invalid_path", () => {
    expectCode(
      () => validateProjectPath("/tmp/../etc/passwd", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects an over-length path (>4096) → invalid_path", () => {
    const huge = "/" + "x".repeat(5000);
    expectCode(() => validateProjectPath(huge, { mustExist: false }), "invalid_path");
  });

  it("rejects an empty string → invalid_path", () => {
    expectCode(() => validateProjectPath("", { mustExist: false }), "invalid_path");
  });

  it("rejects a non-directory file → path_not_directory", () => {
    expectCode(() => validateProjectPath(realFile, { mustExist: true }), "path_not_directory");
  });

  it("rejects a missing path → path_not_found", () => {
    const missing = join(tmpDir, "nope-" + String(Date.now()));
    expectCode(() => validateProjectPath(missing, { mustExist: true }), "path_not_found");
  });
});
