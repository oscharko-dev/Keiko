// ADR-0013 D6 — Path validation policy (fail-closed). Structural rules; each maps to a stable
// error code. These tests pin every branch so a single-line mutation in validateProjectPath is
// caught. Issue #174 — Windows drive paths are now accepted as local project roots; unsafe
// Windows shapes (UNC, device, traversal, null-byte, remote URL) remain rejected on any host OS.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPathShape, validateProjectPath, UiStoreError } from "./index.js";

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
    expectCode(() => validateProjectPath("/tmp/has\0null", { mustExist: false }), "invalid_path");
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

  it("rejects backslash Windows device paths → invalid_path", () => {
    expectCode(
      () => validateProjectPath("\\\\?\\C:\\Users\\dev\\repo", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects forward-slash Windows device paths → invalid_path", () => {
    expectCode(
      () => validateProjectPath("//?/C:/Users/dev/repo", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects DOS device paths (\\\\.\\PhysicalDrive0) → invalid_path", () => {
    expectCode(
      () => validateProjectPath("\\\\.\\PhysicalDrive0", { mustExist: false }),
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

// Issue #174 — Windows-shaped path validation is host-independent so these branches are pinned on
// Linux, macOS, and Windows hosts alike. `mustExist: false` skips the OS-specific stat step.
describe("validateProjectPath — Windows drive paths (cross-platform, mustExist: false)", () => {
  it("accepts a backslash Windows drive path", () => {
    const out = validateProjectPath("C:\\Users\\Example\\Project", { mustExist: false });
    expect(out).toBe("C:\\Users\\Example\\Project");
  });

  it("accepts a forward-slash Windows drive path and normalizes to backslashes", () => {
    const out = validateProjectPath("C:/Users/Example/Project", { mustExist: false });
    expect(out).toBe("C:\\Users\\Example\\Project");
  });

  it("accepts a lowercase drive letter", () => {
    const out = validateProjectPath("d:\\workspace\\repo", { mustExist: false });
    expect(out).toBe("d:\\workspace\\repo");
  });

  it("accepts a drive root", () => {
    const out = validateProjectPath("C:\\", { mustExist: false });
    expect(out).toBe("C:\\");
  });

  it("normalizes redundant separators in a Windows drive path", () => {
    const out = validateProjectPath("C:\\\\Users\\\\Example", { mustExist: false });
    expect(out).toBe("C:\\Users\\Example");
  });

  it("accepts a Windows drive path with redundant forward slashes (looks like a URL scheme prefix)", () => {
    const out = validateProjectPath("C://Users/Example/Project", { mustExist: false });
    expect(out).toBe("C:\\Users\\Example\\Project");
  });

  it("rejects a Windows drive path with a traversal segment", () => {
    expectCode(
      () => validateProjectPath("C:\\Users\\..\\Windows", { mustExist: false }),
      "invalid_path",
    );
  });

  it("rejects a Windows drive path containing a null byte", () => {
    expectCode(
      () => validateProjectPath("C:\\Users\\evil\0name", { mustExist: false }),
      "invalid_path",
    );
  });
});

// Issue #174 — Shape classifier is pure and host-independent; assert every branch is reachable
// from any host so cross-platform path coverage does not rely on the runner OS.
describe("classifyPathShape", () => {
  it("classifies a POSIX absolute path", () => {
    expect(classifyPathShape("/home/example/repo")).toBe("posix-absolute");
  });

  it("classifies a Windows drive path with backslashes", () => {
    expect(classifyPathShape("C:\\Users\\Example")).toBe("windows-drive");
  });

  it("classifies a Windows drive path with forward slashes", () => {
    expect(classifyPathShape("D:/workspace")).toBe("windows-drive");
  });

  it("classifies a Windows UNC path", () => {
    expect(classifyPathShape("\\\\server\\share")).toBe("windows-unc");
  });

  it("classifies a forward-slash UNC path", () => {
    expect(classifyPathShape("//server/share")).toBe("windows-unc");
  });

  it("classifies a Windows device path (\\\\?\\)", () => {
    expect(classifyPathShape("\\\\?\\C:\\Users\\dev")).toBe("windows-device");
  });

  it("classifies a Windows device path (\\\\.\\)", () => {
    expect(classifyPathShape("\\\\.\\COM1")).toBe("windows-device");
  });

  it("classifies a relative path", () => {
    expect(classifyPathShape("relative/path")).toBe("relative");
  });
});
