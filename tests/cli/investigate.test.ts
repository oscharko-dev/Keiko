import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInvestigateCli } from "../../src/cli/investigate.js";
import { runCli } from "../../src/cli/runner.js";
import type { CliIo } from "../../src/cli/runner.js";
import type { ModelPort } from "../../src/harness/ports.js";
import type { NormalizedResponse } from "../../src/gateway/types.js";

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

function modelReturning(content: string): ModelPort {
  const response: NormalizedResponse = {
    modelId: "m",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "high",
    },
  };
  return { call: (): Promise<NormalizedResponse> => Promise.resolve(response) };
}

const FIX = [
  "```diff",
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -1 +1 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
  "```",
  "## Root cause",
  "Divisor was 3.",
  "## Confidence",
  "high",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-investigate-cli-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }, null, 2),
    "utf8",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "buggy.ts"),
    "export const half = (n: number): number => n / 3;\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runInvestigateCli (AC #1 CLI)", () => {
  it("is documented in the top-level help text", () => {
    const cap = makeIo();
    const code = runCli(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain("keiko investigate");
  });

  it("exits 2 with usage when no evidence source is given", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--dir-root", dir],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(2);
    expect(cap.err()).toContain("Usage:");
  });

  it("exits 2 when a value flag is missing its value", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--description"],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(2);
  });

  it("dry-run prints the proposed fix and the verified/hypothesis sections (exit 0)", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
      ],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain("proposed fix");
    expect(cap.out()).toContain("n / 2");
    expect(cap.out()).toContain("UNVERIFIED");
  });

  it("reads failing output from --output-file via the injected reader", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--output-file", "/virtual/out.txt", "--dir-root", dir, "--json"],
      cap.io,
      {},
      { model: modelReturning(FIX), readFile: () => "AssertionError at src/buggy.ts:1:40" },
    );
    expect(code).toBe(0);
    const report = JSON.parse(cap.out()) as {
      status: string;
      verified: { failureFrames: unknown[] };
    };
    expect(report.status).toBe("fix-proposed");
    expect(report.verified.failureFrames.length).toBeGreaterThan(0);
  });

  it("exits 1 when an evidence file cannot be read", async () => {
    const cap = makeIo();
    const reader = (): string => {
      const err = new Error("ENOENT: no such file") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };
    const code = await runInvestigateCli(
      ["--output-file", "/missing.txt", "--dir-root", dir],
      cap.io,
      {},
      { model: modelReturning(FIX), readFile: reader },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("could not read");
  });
});
