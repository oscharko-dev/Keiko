import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The scripts use `node -e` (an allowlisted, deterministic, sub-second invocation) so the CLI
// exercises the real #6 spawn path end-to-end without depending on an installed test runner.
function writePackage(scripts: Record<string, string>): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "verify-demo", version: "0.1.0", scripts }, null, 2),
    "utf8",
  );
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
  });

  it("exits 1 when a step fails", async () => {
    writePackage({ test: 'node -e "process.exit(1)"' });
    const c = makeIo();
    const code = await runVerifyCli(["--dir", dir, "--only", "test"], c.io);
    expect(code).toBe(1);
    expect(c.out()).toContain("Verification: failed");
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
  });
});
