import { describe, expect, it, vi } from "vitest";
import { runAgentCli } from "./run.js";
import { runCli, type CliIo } from "./runner.js";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { EvidenceWriteError } from "@oscharko-dev/keiko-evidence";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

// Replace every filesystem write entry point with a throwing stub. With these mocked, any code path
// that touched the disk would throw. The run command now writes evidence by DEFAULT, so the tests
// either inject an in-memory EvidenceStore (no disk) or pass --no-evidence — proving the run path
// makes zero UNINTENDED filesystem writes and never writes under the repository tree. vi.hoisted
// ensures the stub exists when the hoisted vi.mock factories below execute.
const failWrite = vi.hoisted(() => (): never => {
  throw new Error("unexpected filesystem write");
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

function response(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "--- a/file\n+++ b/file\n+// dry-run proposed change\n",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "test-run",
      promptTokens: 0,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function testModel(): ModelPort {
  return {
    call: (request: GatewayRequest): Promise<NormalizedResponse> =>
      Promise.resolve(response(request.modelId)),
  };
}

describe("runAgentCli dry-run", () => {
  it("runs explain-plan to completion and exits 0", async () => {
    const c = capture();
    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--model", "test-model"],
      c.io,
      {},
      {
        store: createInMemoryEvidenceStore(),
        model: testModel(),
      },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("run:started");
    expect(c.out()).toContain("run:completed");
    expect(c.out()).toContain("completed");
  });

  it("runs generate-unit-tests and proposes a patch without applying it", async () => {
    const c = capture();
    const code = await runAgentCli(
      ["generate-unit-tests", "--file", "src/foo.ts", "--model", "test-model"],
      c.io,
      {},
      {
        store: createInMemoryEvidenceStore(),
        model: testModel(),
      },
    );
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

  it("dispatches through runCli's run branch and surfaces missing gateway config", async () => {
    const c = capture();
    const result = runCli(["run", "explain-plan", "--file", "src/foo.ts", "--no-evidence"], c.io);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(1);
    expect(c.err()).toContain("model gateway configuration problem");
  });
});

describe("runAgentCli evidence-by-default", () => {
  it("writes a redacted evidence manifest to the injected store and prints the report", async () => {
    const c = capture();
    const store = createInMemoryEvidenceStore();
    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--model", "test-model"],
      c.io,
      {},
      { store, model: testModel() },
    );
    expect(code).toBe(0);
    expect(store.list()).toHaveLength(1);
    const runId = store.list()[0];
    expect(runId).toBeDefined();
    if (runId === undefined) {
      return;
    }
    const raw = store.get(runId);
    expect(raw).toContain('"evidenceSchemaVersion": "1"');
    expect(c.out()).toContain("Evidence:");
    expect(c.out()).toContain("fingerprint");
    expect(c.out()).toContain("usage");
    expect(c.out()).toContain("cost class");
    expect(c.out()).toContain("verification");
    expect(c.out()).toContain("known limitations");
  });

  it("reports harness verification results from the evidence report", async () => {
    const c = capture();
    const store = createInMemoryEvidenceStore();
    const code = await runAgentCli(
      ["generate-unit-tests", "--file", "src/foo.ts", "--model", "test-model"],
      c.io,
      {},
      { store, model: testModel() },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("verification   passed");
  });

  it("makes zero filesystem writes when --no-evidence is passed (mocked writers throw)", async () => {
    const c = capture();
    const code = await runAgentCli(
      ["generate-unit-tests", "--file", "src/foo.ts", "--no-evidence", "--model", "test-model"],
      c.io,
      {},
      { model: testModel() },
    );
    expect(code).toBe(0);
    expect(c.out()).not.toContain("Evidence:");
  });

  it("never reaches a real fs write even on the default path (injected store intercepts)", async () => {
    const c = capture();
    const store = createInMemoryEvidenceStore();
    const code = await runAgentCli(
      ["generate-unit-tests", "--file", "src/foo.ts", "--model", "test-model"],
      c.io,
      {},
      {
        store,
        model: testModel(),
      },
    );
    expect(code).toBe(0);
    expect(store.list()).toHaveLength(1);
  });
});

describe("runAgentCli evidence write failure (C3)", () => {
  it("returns exit 1 and prints a redacted error when the store put throws (no rejection)", async () => {
    const c = capture();
    const failingStore: EvidenceStore = {
      put: (): string => {
        throw new EvidenceWriteError("disk is read-only");
      },
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    };
    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--model", "test-model"],
      c.io,
      {},
      {
        store: failingStore,
        model: testModel(),
      },
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("failed to write evidence");
  });
});
