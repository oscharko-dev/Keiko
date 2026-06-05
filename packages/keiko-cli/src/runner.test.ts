import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./runner.js";
import { SDK_VERSION } from "./_sdk-version.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Root product package.json sits three directories above this test file:
//   packages/keiko-cli/src/runner.test.ts → packages/keiko-cli/ → packages/ → <root>
const ROOT_PACKAGE_JSON = resolve(HERE, "..", "..", "..", "package.json");

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

function isPackageJson(value: unknown): value is { readonly version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  );
}

// Reads the ROOT product package.json via an absolute path derived from this
// test file's location, so the assertion works whether `vitest` runs from the
// repo root (`npm test`) or from this package (`cd packages/keiko-cli && npm test`).
// The CLI surfaces the root product version via `keiko --version`, so the assertion
// below guards against drift between the local SDK_VERSION literal
// (_sdk-version.ts) and the root package's version field.
function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8"));
  if (!isPackageJson(parsed)) {
    throw new Error("package.json version is missing");
  }
  return parsed.version;
}

describe("runCli", () => {
  it("prints help and returns 0 when no args are given", () => {
    const c = makeIo();
    const code = runCli([], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("keiko");
    expect(c.out()).toContain("--help");
    expect(c.out()).toContain("--version");
    expect(c.err()).toBe("");
  });

  it.each(["--help", "-h"])("prints help and returns 0 for %s", (flag) => {
    const c = makeIo();
    const code = runCli([flag], c.io);
    expect(code).toBe(0);
    expect(c.out().toLowerCase()).toContain("usage");
    expect(c.out()).toContain("Exit codes");
    expect(c.out()).toContain("0");
    expect(c.out()).toContain("1");
    expect(c.out()).toContain("2");
    expect(c.err()).toBe("");
  });

  it.each(["--version", "-v"])("prints version and returns 0 for %s", (flag) => {
    const c = makeIo();
    const code = runCli([flag], c.io);
    expect(code).toBe(0);
    expect(SDK_VERSION).toBe(packageVersion());
    expect(c.out()).toBe(`keiko ${packageVersion()}\n`);
    expect(c.err()).toBe("");
  });

  it("lists the evidence subcommand in help", () => {
    const c = makeIo();
    const code = runCli(["--help"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("keiko evidence");
    expect(c.out()).toContain("keiko init");
    expect(c.out()).toContain("keiko start|stop|status|restart");
  });

  it("lists the launcher subcommand in help (epic #121 child #125)", () => {
    const c = makeIo();
    const code = runCli(["--help"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("keiko launcher");
    expect(c.out()).toContain("install|remove|status");
  });

  it("dispatches the launcher subcommand (prints USAGE and returns 0 with no args)", () => {
    const c = makeIo();
    // Bare `keiko launcher` is `runLauncherCli([], ...)` which prints USAGE and returns 0
    // per the launcher dispatcher contract; the runner.ts wiring must forward the empty rest.
    const code = runCli(["launcher"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("keiko launcher install");
    expect(c.err()).toBe("");
  });

  it("dispatches the evidence subcommand (usage error 2 with no subcommand, no disk touched)", () => {
    const c = makeIo();
    const code = runCli(["evidence"], c.io);
    expect(code).toBe(2);
    expect(c.err().toLowerCase()).toContain("usage");
  });

  it("returns 2 and reports the offending token for an unknown command", () => {
    const c = makeIo();
    const code = runCli(["frobnicate"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain("frobnicate");
    expect(c.err()).toContain("keiko --help");
    expect(c.out()).toBe("");
  });

  it("returns 2 with a non-empty error for an unknown flag", () => {
    const c = makeIo();
    const code = runCli(["--nope"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain("--nope");
    expect(c.err().length).toBeGreaterThan(0);
    expect(c.out()).toBe("");
  });
});
