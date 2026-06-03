import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInitCli } from "./init.js";
import type { CliIo } from "./runner.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const tempRoots: string[] = [];

function makeTempPackage(contents: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-init-"));
  tempRoots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  return root;
}

function readPackage(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runInitCli", () => {
  it("adds local Keiko start and stop scripts to package.json", () => {
    const root = makeTempPackage({ name: "target-project", version: "1.0.0" });
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(c.err()).toBe("");
    expect(readPackage(root).scripts).toEqual({
      "keiko:start": "keiko start",
      "keiko:stop": "keiko stop",
    });
    expect(c.out()).toContain("npm run keiko:start");
  });

  it("is idempotent when scripts already match", () => {
    const root = makeTempPackage({
      name: "target-project",
      scripts: { test: "vitest run", "keiko:start": "keiko start", "keiko:stop": "keiko stop" },
    });
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(readPackage(root).scripts).toEqual({
      test: "vitest run",
      "keiko:start": "keiko start",
      "keiko:stop": "keiko stop",
    });
  });

  it("does not overwrite conflicting scripts without --force", () => {
    const root = makeTempPackage({
      name: "target-project",
      scripts: { "keiko:start": "echo custom" },
    });
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(1);
    expect(c.err()).toContain("conflicting script");
    expect(readPackage(root).scripts).toEqual({ "keiko:start": "echo custom" });
  });

  it("overwrites conflicting scripts with --force", () => {
    const root = makeTempPackage({
      name: "target-project",
      scripts: { "keiko:start": "echo custom" },
    });
    const c = makeIo();

    const code = runInitCli(["--force"], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(readPackage(root).scripts).toEqual({
      "keiko:start": "keiko start",
      "keiko:stop": "keiko stop",
    });
  });

  it("returns a runtime error when package.json is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-init-missing-"));
    tempRoots.push(root);
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(1);
    expect(c.err()).toContain("package.json not found");
  });
});
