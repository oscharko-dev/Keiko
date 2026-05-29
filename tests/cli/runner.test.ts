import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/runner.js";

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
    expect(c.out()).toMatch(/^keiko \d+\.\d+\.\d+\n$/);
    expect(c.err()).toBe("");
  });

  it("lists the evidence subcommand in help", () => {
    const c = makeIo();
    const code = runCli(["--help"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("keiko evidence");
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
