import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGenTestsCli } from "../../src/cli/gen-tests.js";
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
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
  return { call: (): Promise<NormalizedResponse> => Promise.resolve(response) };
}

const VALID_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,2 @@\n" +
  "+import { add } from '../src/add';\n+test('adds', () => expect(add(1, 2)).toBe(3));\n";

const FENCED = ["```diff", VALID_DIFF.trimEnd(), "```"].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-gentests-cli-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }, null, 2),
    "utf8",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "add.ts"),
    "export const add = (a: number, b: number) => a + b;\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runGenTestsCli (AC #1)", () => {
  it("exits 2 and prints usage when neither --file nor --dir is given", async () => {
    const c = makeIo();
    expect(await runGenTestsCli([], c.io, {}, { model: modelReturning(FENCED) })).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("exits 2 when BOTH --file and --dir are given (mutual exclusion)", async () => {
    const c = makeIo();
    const code = await runGenTestsCli(
      ["--file", "src/add.ts", "--dir", "src", "--dir-root", dir],
      c.io,
      {},
      { model: modelReturning(FENCED) },
    );
    expect(code).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("exits 2 when --file is supplied without a value", async () => {
    const c = makeIo();
    expect(await runGenTestsCli(["--file"], c.io, {}, { model: modelReturning(FENCED) })).toBe(2);
  });

  it("dry-runs and prints the proposed diff and validation summary on stdout (exit 0)", async () => {
    const c = makeIo();
    const code = await runGenTestsCli(
      ["--file", "src/add.ts", "--dir-root", dir],
      c.io,
      {},
      { model: modelReturning(FENCED) },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("PATCH OK");
    expect(c.out()).toContain("proposed test patch");
    expect(c.out()).toContain("tests/add.test.ts");
  });

  it("emits the full report as JSON with --json (exit 0)", async () => {
    const c = makeIo();
    const code = await runGenTestsCli(
      ["--file", "src/add.ts", "--dir-root", dir, "--json"],
      c.io,
      {},
      { model: modelReturning(FENCED) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as { status: string; proposedDiff: string };
    expect(parsed.status).toBe("dry-run");
    expect(parsed.proposedDiff).toContain("tests/add.test.ts");
  });

  it("exits 1 when the model produces only out-of-scope (source) patches", async () => {
    const sourceDiff = "--- /dev/null\n+++ b/src/extra.ts\n@@ -0,0 +1,1 @@\n+export const x = 1;\n";
    const c = makeIo();
    const code = await runGenTestsCli(
      ["--file", "src/add.ts", "--dir-root", dir, "--json"],
      c.io,
      {},
      { model: modelReturning(sourceDiff) },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(c.out()) as { status: string };
    expect(parsed.status).toBe("rejected");
  });

  it("drops empty entries from --changed (C2: trailing/consecutive commas)", async () => {
    const c = makeIo();
    const code = await runGenTestsCli(
      ["--file", "src/add.ts", "--dir-root", dir, "--changed", "a.ts,,b.ts,"],
      c.io,
      {},
      { model: modelReturning(FENCED) },
    );
    // Should succeed (treats --changed a.ts,b.ts as the target, not a usage error)
    expect(code).toBe(0);
  });

  it("treats --changed with only commas as absent, falling back to --file target (C2)", async () => {
    const c = makeIo();
    const code = await runGenTestsCli(
      ["--file", "src/add.ts", "--dir-root", dir, "--changed", ",,"],
      c.io,
      {},
      { model: modelReturning(FENCED) },
    );
    // Falls back to --file target, no usage error
    expect(code).toBe(0);
    expect(c.err()).toBe("");
  });

  it("exits 1 with a specific error message when no gateway config is found (C3)", async () => {
    const c = makeIo();
    // No deps.model injected — buildModel runs and throws ConfigInvalidError (a GatewayError)
    const code = await runGenTestsCli(["--file", "src/add.ts", "--dir-root", dir], c.io, {}, {});
    expect(code).toBe(1);
    expect(c.err()).toContain("model gateway configuration problem");
    expect(c.err()).toContain("KEIKO_DEFAULT_API_KEY");
  });
});
