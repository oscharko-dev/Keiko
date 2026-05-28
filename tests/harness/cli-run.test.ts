import { describe, expect, it, vi } from "vitest";
import { runAgentCli } from "../../src/cli/run.js";
import { runCli, type CliIo } from "../../src/cli/runner.js";

// Replace every filesystem write entry point with a throwing stub. If any code path in the
// dry-run run command touched the disk, these would throw and fail the test. They are never
// called, which is the assertion: the dry-run path makes zero filesystem writes. vi.hoisted
// ensures the stub exists when the hoisted vi.mock factories below execute.
const failWrite = vi.hoisted(() => (): never => {
  throw new Error("filesystem write attempted during dry-run");
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: failWrite,
    appendFileSync: failWrite,
    writeSync: failWrite,
    mkdirSync: failWrite,
    rmSync: failWrite,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: failWrite,
    appendFile: failWrite,
    mkdir: failWrite,
    rm: failWrite,
  };
});

function capture(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string): void => {
        out += t;
      },
      err: (t: string): void => {
        err += t;
      },
    },
    out: (): string => out,
    err: (): string => err,
  };
}

describe("runAgentCli dry-run", () => {
  it("runs explain-plan to completion and exits 0", async () => {
    const c = capture();
    const code = await runAgentCli(["explain-plan", "--file", "src/foo.ts"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("run:started");
    expect(c.out()).toContain("run:completed");
    expect(c.out()).toContain("completed");
  });

  it("runs generate-unit-tests and proposes a patch without applying it", async () => {
    const c = capture();
    const code = await runAgentCli(["generate-unit-tests", "--file", "src/foo.ts"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("patch:proposed");
    // The diff content is redacted at the CLI sink; only metadata is printed.
    expect(c.out()).toContain("diff redacted");
  });

  it("returns usage error 2 for an unknown task type", async () => {
    const c = capture();
    const code = await runAgentCli(["frobnicate", "--file", "x"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain("unknown task type");
  });

  it("returns usage error 2 when a required argument is missing", async () => {
    const c = capture();
    const code = await runAgentCli(["explain-plan"], c.io);
    expect(code).toBe(2);
    expect(c.err().toLowerCase()).toContain("missing required argument");
  });

  it("dispatches through runCli's run branch", async () => {
    const c = capture();
    const result = runCli(["run", "explain-plan", "--file", "src/foo.ts"], c.io);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(0);
  });
});

describe("runAgentCli makes zero filesystem writes", () => {
  it("completes the generate-unit-tests dry-run without any fs write (mocked writers throw)", async () => {
    const c = capture();
    const code = await runAgentCli(["generate-unit-tests", "--file", "src/foo.ts"], c.io);
    expect(code).toBe(0);
  });
});
