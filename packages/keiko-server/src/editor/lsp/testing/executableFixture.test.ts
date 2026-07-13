import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeExecutableFixture, writeNodeExecutableFixture } from "./executableFixture.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("writeNodeExecutableFixture", () => {
  it("creates a Windows command wrapper around a Node fixture script", () => {
    const root = fixtureRoot();
    const path = writeNodeExecutableFixture(root, "git", "process.exit(0);", "win32");

    expect(basename(path)).toBe("git.CMD");
    expect(readFileSync(path, "utf8")).toContain("git.fixture.cjs");
    expect(readFileSync(join(root, "git.fixture.cjs"), "utf8")).toBe("process.exit(0);");
  });

  it.skipIf(process.platform === "win32")(
    "executes the Node fixture through its POSIX wrapper",
    () => {
      const path = writeNodeExecutableFixture(fixtureRoot(), "git", "process.exit(0);", "linux");

      expect(statSync(path).mode & 0o111).toBe(0o111);
      expect(readFileSync(path, "utf8")).toContain("git.fixture.cjs");
    },
  );
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-lsp-executable-"));
  fixtureRoots.push(root);
  return root;
}

describe("writeExecutableFixture", () => {
  it("creates a PATHEXT-compatible command fixture for Windows", () => {
    const path = writeExecutableFixture(fixtureRoot(), "fakelsp", "win32");
    expect(basename(path)).toBe("fakelsp.CMD");
    expect(readFileSync(path, "utf8")).toBe("@echo off\r\n");
  });

  it.skipIf(process.platform === "win32")("creates an executable shell fixture for POSIX", () => {
    const path = writeExecutableFixture(fixtureRoot(), "fakelsp", "linux");
    expect(basename(path)).toBe("fakelsp");
    expect(statSync(path).mode & 0o111).toBe(0o111);
  });
});
