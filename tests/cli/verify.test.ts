import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerifyCli } from "../../src/cli/verify.js";
import type { CliIo } from "../../src/cli/runner.js";

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
      out: (t: string): void => void outChunks.push(t),
      err: (t: string): void => void errChunks.push(t),
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

let dir: string;

interface PackageOptions {
  readonly devDependencies?: Record<string, string> | undefined;
}

// The scripts use `node -e` through npm scripts so the CLI exercises the real #6 spawn path
// end-to-end without depending on an installed test runner.
function writePackage(scripts: Record<string, string>, options: PackageOptions = {}): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "verify-demo",
        version: "0.1.3",
        scripts,
        ...(options.devDependencies === undefined
          ? {}
          : { devDependencies: options.devDependencies }),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeWorkspaceFile(relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function prependFakeNpxToPath(): () => void {
  const fakeBin = mkdtempSync(join(tmpdir(), "keiko-verify-bin-"));
  const executable = join(fakeBin, process.platform === "win32" ? "npx.cmd" : "npx");
  const body =
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/usr/bin/env sh\nexit 0\n";
  writeFileSync(executable, body, "utf8");
  chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ""}`;
  return (): void => {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    rmSync(fakeBin, { recursive: true, force: true });
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-verify-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runVerifyCli", () => {
  it("exits 0 when every step passes and prints a human table", async () => {
    writePackage({ test: 'node -e "process.exit(0)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "test"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("Verification: passed");
    expect(c.out()).toContain("test\tpassed");
    expect(c.out()).toContain("\tCOMMAND\t");
    expect(c.out()).toContain("\tnpm test\t");
  });

  it("exits 1 when a step fails", async () => {
    writePackage({ test: 'node -e "process.exit(1)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "test"], c.io);
    expect(code).toBe(1);
    expect(c.out()).toContain("Verification: failed");
  });

  it("runs a non-literal test script selected by script detection", async () => {
    writePackage({ "test:unit": 'node -e "process.exit(0)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "test"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("test\tpassed");
    expect(c.out()).toContain("\tnpm run test:unit\t");
  });

  it("emits a JSON summary with --json (exit 0 on pass)", async () => {
    writePackage({ test: 'node -e "process.exit(0)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "test", "--json"], c.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as {
      overallStatus: string;
      results: { kind: string; status: string; appliedLimits: unknown[] }[];
    };
    expect(parsed.overallStatus).toBe("passed");
    expect(parsed.results[0]?.kind).toBe("test");
    expect(parsed.results[0]?.appliedLimits).toHaveLength(4);
  });

  it("filters with --only and marks an unrequested kind absent from the report", async () => {
    writePackage({ test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "lint", "--json"], c.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as { results: { kind: string }[] };
    expect(parsed.results.map((r) => r.kind)).toEqual(["lint"]);
  });

  it("runs a targeted-test step from --changed and reports command evidence", async () => {
    writePackage({ test: 'node -e "process.exit(0)"' }, { devDependencies: { vitest: "4.1.7" } });
    writeWorkspaceFile("src/add.ts", "export const add = (a, b) => a + b;\n");
    writeWorkspaceFile("src/add.test.ts", "test('add', () => {});\n");
    const restorePath = prependFakeNpxToPath();
    try {
      const c = makeIo();
      const code = await runVerifyCli(
        ["--dir", dir, "--only", "targeted-test", "--changed", "src/add.ts", "--json"],
        c.io,
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(c.out()) as {
        results: { kind: string; status: string; command: string }[];
      };
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0]).toMatchObject({
        kind: "targeted-test",
        status: "passed",
        command: "npx vitest run src/add.test.ts",
      });
    } finally {
      restorePath();
    }
  });

  it("fails instead of reporting a false pass when targeted verification has no changed files", async () => {
    writePackage({ test: 'node -e "process.exit(0)"' }, { devDependencies: { vitest: "4.1.7" } });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "targeted-test", "--json"], c.io);
    expect(code).toBe(1);
    expect(c.err()).toContain("VERIFICATION_PLAN_EMPTY");
    expect(c.out()).toBe("");
  });

  it("fails instead of reporting a false pass when --changed resolves no targeted test", async () => {
    writePackage({ test: 'node -e "process.exit(0)"' }, { devDependencies: { vitest: "4.1.7" } });
    writeWorkspaceFile("src/orphan.ts", "export const orphan = 1;\n");
    const c = makeIo();
    const code = await runVerifyCli(
      ["--dir", dir, "--only", "targeted-test", "--changed", "src/orphan.ts", "--json"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("VERIFICATION_PLAN_EMPTY");
    expect(c.out()).toBe("");
  });

  it("reports a missing requested kind as skipped (exit 0), no process run", async () => {
    writePackage({ test: 'node -e "process.exit(0)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "build", "--json"], c.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as { results: { kind: string; status: string }[] };
    expect(parsed.results[0]).toMatchObject({ kind: "build", status: "skipped" });
  });

  it("returns 2 on an invalid --only kind (usage error)", async () => {
    writePackage({ test: 'node -e "process.exit(0)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "bogus"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("returns 2 when --dir is supplied without a value", async () => {
    const c = makeIo();
    expect(await runVerifyCli(["--dir"], c.io)).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("redacts a secret printed by a verification command", async () => {
    const secret = "ghp_" + "0123456789abcdefABCDEFghijklmnopqrst";
    writePackage({ test: `node -e "console.log('${secret}'); process.exit(1)"` });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "test", "--json"], c.io);
    expect(code).toBe(1);
    expect(c.out()).not.toContain(secret);
  });

  it("returns 1 and writes to err on a WorkspaceError (non-existent --dir)", async () => {
    // Exercises the WorkspaceError catch branch in runVerifyCli.
    // A directory with no package.json and no .git ancestor triggers WorkspaceNotFoundError.
    const orphan = mkdtempSync(join(tmpdir(), "keiko-verify-noroot-"));
    try {
      const c = makeIo();
      const code = await runVerifyCli(["--dir", orphan], c.io);
      // Detection may still succeed if orphan sits under a git repo; only assert the error
      // contract when it fails, otherwise it must be a clean success.
      if (code === 1) {
        expect(c.err()).toContain("WORKSPACE_");
      } else {
        expect(code).toBe(0);
      }
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  }, 15_000);
});
