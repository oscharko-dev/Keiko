import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../../src/workspace/detect.js";
import { WorkspaceNotFoundError } from "../../src/workspace/errors.js";
import type { WorkspaceFs } from "../../src/workspace/fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-detect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePkg(root: string, body: unknown): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(body), "utf8");
}

describe("detectWorkspace", () => {
  it("detects the root via package.json and reads name/version", () => {
    writePkg(dir, { name: "demo", version: "1.2.3" });
    const info = detectWorkspace(dir);
    expect(info.root).toBe(dir);
    expect(info.name).toBe("demo");
    expect(info.version).toBe("1.2.3");
  });

  it("detects the framework from devDependencies", () => {
    writePkg(dir, { name: "demo", devDependencies: { vitest: "^4.0.0" } });
    expect(detectWorkspace(dir).testFramework).toBe("vitest");
  });

  it("detects jest and mocha frameworks", () => {
    writePkg(dir, { name: "demo", dependencies: { jest: "^29" } });
    expect(detectWorkspace(dir).testFramework).toBe("jest");
    writePkg(dir, { name: "demo", devDependencies: { mocha: "^10" } });
    expect(detectWorkspace(dir).testFramework).toBe("mocha");
  });

  it("returns unknown framework when none is declared", () => {
    writePkg(dir, { name: "demo" });
    expect(detectWorkspace(dir).testFramework).toBe("unknown");
  });

  it("walks up to a parent root from a nested directory", () => {
    writePkg(dir, { name: "demo" });
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(detectWorkspace(nested).root).toBe(dir);
  });

  it("detects a .git directory as a root even without package.json", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    expect(detectWorkspace(dir).root).toBe(dir);
    expect(detectWorkspace(dir).name).toBeUndefined();
  });

  it("detects source and test dirs that exist", () => {
    writePkg(dir, { name: "demo" });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    const info = detectWorkspace(dir);
    expect(info.sourceDirs).toContain("src");
    expect(info.testDirs).toContain("tests");
  });

  it("reports typescript when tsconfig.json is present", () => {
    writePkg(dir, { name: "demo" });
    writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
    expect(detectWorkspace(dir).languages).toContain("typescript");
  });

  it("reads .gitignore lines", () => {
    writePkg(dir, { name: "demo" });
    writeFileSync(join(dir, ".gitignore"), "dist/\n*.log\n", "utf8");
    expect(detectWorkspace(dir).ignoreLines).toContain("dist/");
  });

  it("tolerates a malformed package.json without throwing", () => {
    writeFileSync(join(dir, "package.json"), "{ not valid json", "utf8");
    const info = detectWorkspace(dir);
    expect(info.root).toBe(dir);
    expect(info.name).toBeUndefined();
  });

  it("throws WorkspaceNotFoundError when no marker exists above startDir", () => {
    // Inject a fake fs that reports no markers anywhere, so the walk reaches the volume root
    // without finding `.git`/`package.json`. Environment-independent.
    const emptyFs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): never => {
        throw new Error("not used");
      },
      readDir: (): readonly never[] => [],
      realPath: (p: string): string => p,
      exists: (): boolean => false,
    };
    expect(() => detectWorkspace("/some/deep/path", emptyFs)).toThrow(WorkspaceNotFoundError);
  });
});
