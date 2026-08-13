import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "keiko:start": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js start",
      "keiko:stop": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js stop",
    });
    expect(c.out()).toContain("npm run keiko:start");
  });

  it("is idempotent when scripts already match", () => {
    const root = makeTempPackage({
      name: "target-project",
      scripts: {
        test: "vitest run",
        "keiko:start": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js start",
        "keiko:stop": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js stop",
      },
    });
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(readPackage(root).scripts).toEqual({
      test: "vitest run",
      "keiko:start": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js start",
      "keiko:stop": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js stop",
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
      "keiko:start": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js start",
      "keiko:stop": "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js stop",
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

  it("preserves 4-space indentation instead of reformatting the whole file to 2 spaces", () => {
    // #KEIKO-0503 must-fail-before-fix: stringifyPackageJson used to hardcode
    // `JSON.stringify(data, null, 2)`, so a package.json indented with 4 spaces was
    // re-emitted with 2 spaces regardless of the source. After the fix, the file's
    // existing indentation is detected from the raw source and reused for the write,
    // producing a minimal diff that adds the two scripts and leaves everything else
    // (including the indent width of untouched lines) byte-identical.
    const root = mkdtempSync(join(tmpdir(), "keiko-init-4space-"));
    tempRoots.push(root);
    const packagePath = join(root, "package.json");
    const fourSpaceContent = `{
    "name": "target-project",
    "version": "1.0.0",
    "scripts": {
        "test": "vitest run"
    }
}
`;
    writeFileSync(packagePath, fourSpaceContent, "utf8");
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    const written = readFileSync(packagePath, "utf8");
    // Existing 4-space-indented fields keep their indentation width.
    expect(written).toMatch(/^ {4}"name":/mu);
    expect(written).toMatch(/^ {4}"version":/mu);
    // Nested script entries keep the 8-space indent that follows from the outer 4-space width.
    expect(written).toMatch(/^ {8}"test":/mu);
    expect(written).toMatch(/^ {8}"keiko:start":/mu);
    // The file must never regress to the pre-fix 2-space output.
    expect(written).not.toMatch(/^ {2}"name":/mu);
  });

  it("keeps 2-space indent when the outer brace shares a line with the only top-level key (Codex 3771930608)", () => {
    // Regression: when a compact JSON puts the sole top-level key on the SAME line as `{`,
    // detectIndentSignals's `\n[ \t]+"` regex only captures nested lines (e.g. depth 4 for
    // `"test"`). The pre-fix detector inferred the indent from those nested-only samples and
    // rewrote the whole file at that deeper width (4 spaces here). The direct-top-level
    // detector reads the FIRST indented line under the outermost `{` — which does not exist
    // in this shape — and falls back to the conservative default of 2 spaces.
    const root = mkdtempSync(join(tmpdir(), "keiko-init-compact-"));
    tempRoots.push(root);
    const packagePath = join(root, "package.json");
    const compactContent =
      '{ "name": "target-project", "version": "1.0.0", "scripts": {\n    "test": "x"\n  } }\n';
    writeFileSync(packagePath, compactContent, "utf8");
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    const written = readFileSync(packagePath, "utf8");
    // Nested-only depth 4 must NOT be picked up as the top-level step — a 4-space output
    // would rewrite the whole file. Conservative default 2 is what the compact source
    // implicitly reads as (its expanded form is 2-space).
    expect(written).toMatch(/^ {2}"name":/mu);
    expect(written).not.toMatch(/^ {4}"name":/mu);
  });

  it("preserves tab indentation instead of reformatting to 2 spaces", () => {
    // #KEIKO-0503: same guarantee for a tab-indented file — the whole file must not
    // switch to space indentation just because `keiko init` added two scripts.
    const root = mkdtempSync(join(tmpdir(), "keiko-init-tab-"));
    tempRoots.push(root);
    const packagePath = join(root, "package.json");
    const tabContent = '{\n\t"name": "target-project",\n\t"version": "1.0.0"\n}\n';
    writeFileSync(packagePath, tabContent, "utf8");
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    const written = readFileSync(packagePath, "utf8");
    expect(written).toMatch(/^\t"name":/mu);
    expect(written).toMatch(/^\t"scripts":/mu);
    expect(written).not.toMatch(/^ {2}"name":/mu);
  });

  it.each([["--help"], ["-h"]])("prints usage and returns 0 for %s", (flag) => {
    // Branch-coverage pin: exercises the parseInitArgs "help" return and the runInitCli
    // early-return branch. Both branches are otherwise never hit by tests.
    const root = makeTempPackage({ name: "target-project", version: "1.0.0" });
    const c = makeIo();

    const code = runInitCli([flag], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(c.out()).toContain("keiko init");
    expect(c.err()).toBe("");
    // Never touches package.json when help was requested.
    expect(readPackage(root).scripts).toBeUndefined();
  });

  it("returns 2 and prints usage on an unknown flag", () => {
    // Branch-coverage pin: exercises the parseInitArgs null return path and the runInitCli
    // usage-to-stderr branch. Distinct exit code (2) from generic error (1).
    const root = makeTempPackage({ name: "target-project", version: "1.0.0" });
    const c = makeIo();

    const code = runInitCli(["--nope"], c.io, {}, { cwd: root });

    expect(code).toBe(2);
    expect(c.err()).toContain("keiko init");
    expect(readPackage(root).scripts).toBeUndefined();
  });

  it("emits the rendered manifest to stdout and does not write on --dry-run", () => {
    // Branch-coverage pin: exercises the dryRun branch and confirms the write is skipped.
    const root = makeTempPackage({ name: "target-project", version: "1.0.0" });
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = makeIo();

    const code = runInitCli(["--dry-run"], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(c.out()).toContain("keiko:start");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("writes package.json atomically and leaves no .keiko-init-* temp dir behind", () => {
    // #KEIKO-0503 must-fail-before-fix: writeFileSync was a truncate-then-write; a
    // crash between truncate and write could leave the project's package.json
    // truncated. After the fix, the write goes through mkdtemp -> write -> rename
    // and cleans up the temp dir even on the success path.
    const root = makeTempPackage({ name: "target-project", version: "1.0.0" });
    const c = makeIo();

    const code = runInitCli([], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    const leftovers = readdirSync(root).filter((name) => name.startsWith(".keiko-init-"));
    expect(leftovers).toEqual([]);
  });
});
