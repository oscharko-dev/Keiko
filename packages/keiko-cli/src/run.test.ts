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
  it("returns usage error 2 when no task type is provided", async () => {
    const c = capture();
    const code = await runAgentCli([], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain("Usage:");
  });

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

  it("runs investigate-bug with description and optional file scope", async () => {
    const c = capture();
    const code = await runAgentCli(
      [
        "investigate-bug",
        "--description",
        "Grounded answer omits the linked PDF source.",
        "--file",
        "src/rag.ts",
        "--no-evidence",
        "--model",
        "test-model",
      ],
      c.io,
      {},
      { model: testModel() },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("run:started");
    expect(c.out()).toContain("completed");
  });

  // 2895 audit KEIKO-0903 (Finding D, #3323 follow-up): before this fix, run.ts constructed the
  // tool-using CLI dispatch (generate-unit-tests / investigate-bug) with only shaperPort -- no
  // compactionPort -- so a session whose accumulated assistant/tool history genuinely exceeded
  // maxContextBytes (512,000 -- keiko-contracts/src/harness.ts DEFAULT_LIMITS) hard-failed
  // HARNESS_LIMIT_CONTEXT_SIZE instead of compacting and continuing, exactly the gap #3323 closed
  // for the reachable server call sites.
  //
  // Each growth round answers with finishReason "tool_calls" and an EMPTY toolCalls array. This is
  // the same construction keiko-harness/src/loop.test.ts's own "checkModelCallLimits compaction
  // (KEIKO-0726)" tests use, and for the same documented reason: routeAfterModel (executor.ts)
  // sends the run to the tool-call state on finishReason alone, and handleToolCall's per-call loop
  // has nothing to iterate when toolCalls is empty, so it returns straight to model-call WITHOUT
  // running its own tool-result byte check (selectToolMessage/toolOutputBudgetExceeded). That
  // per-tool-result check is a narrower, EARLIER gate scoped to whether one new tool message fits
  // (HarnessShaperPort, ADR-0055 D4) -- growth concentrated in assistant content routes around it
  // and lands on checkModelCallLimits at the next model-call entry exactly as it would for a real
  // provider response that narrates large reasoning alongside a request to keep working, which is
  // the actual target of this fix. 8 rounds of ~70,000 bytes of assistant content comfortably
  // exceeds 512,000 bytes cumulative before the model finally stops on round 9. A session this
  // large can only reach `completed` if checkModelCallLimits' compaction attempt
  // (keiko-harness/src/loop.ts's tryCompact) actually fires and the injected port actually evicts
  // old turns; the unfixed run.ts hard-fails instead.
  it("compacts a tool-using session that grows past maxContextBytes and completes, instead of hard-failing (multi-round regression)", async () => {
    const c = capture();
    const GROWTH_ROUNDS = 8;
    let calls = 0;
    const growingModel: ModelPort = {
      call: (request: GatewayRequest): Promise<NormalizedResponse> => {
        calls += 1;
        if (calls <= GROWTH_ROUNDS) {
          return Promise.resolve({
            modelId: request.modelId,
            content: "x".repeat(70_000),
            finishReason: "tool_calls",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: `req-${String(calls)}`,
              promptTokens: 1,
              completionTokens: 1,
              latencyMs: 1,
              costClass: "low",
            },
          });
        }
        return Promise.resolve(response(request.modelId));
      },
    };
    const code = await runAgentCli(
      [
        "investigate-bug",
        "--description",
        "Grounded answer omits the linked PDF source.",
        "--no-evidence",
        "--model",
        "test-model",
      ],
      c.io,
      {},
      { model: growingModel },
    );
    expect(code).toBe(0);
    expect(c.err()).not.toContain("HARNESS_LIMIT_CONTEXT_SIZE");
    expect(c.out()).toContain("run:completed");
    expect(c.out()).toContain("context:compacted");
    // The model was called past the growth rounds into its final "stop" response -- the run
    // reached completion rather than hard-failing partway through the tool-calling loop.
    expect(calls).toBeGreaterThan(GROWTH_ROUNDS);
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

  it("returns usage error 2 when investigate-bug is missing its description", async () => {
    const c = capture();
    const code = await runAgentCli(["investigate-bug", "--file", "src/foo.ts"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain("missing required argument for investigate-bug");
  });

  it("requires an explicit model id when a test model is injected without config", async () => {
    const c = capture();
    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--no-evidence"],
      c.io,
      {},
      { model: testModel() },
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("no model id available");
  });

  it("returns exit 1 and a failed run summary when the model port rejects", async () => {
    const c = capture();
    const secret = "Bearer fixture-token-value";
    const failingModel: ModelPort = {
      call: () => Promise.reject(new Error(`provider leaked ${secret}`)),
    };

    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--no-evidence", "--model", "test-model"],
      c.io,
      {},
      { model: failingModel },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("failed");
    expect(c.err()).toContain("MODEL_ERROR");
    expect(c.err()).not.toContain(secret);
    expect(c.err()).toContain("[REDACTED]");
  });

  it("dispatches through runCli's run branch and surfaces missing gateway config", async () => {
    const c = capture();
    const result = runCli(["run", "explain-plan", "--file", "src/foo.ts", "--no-evidence"], c.io);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(1);
    expect(c.err()).toContain("model gateway configuration problem");
  });

  // #3409 catalog-B audit: `keiko run` must stay the documented nonproductive dry-run readiness
  // mode (docs/architecture/governed-tool-migration.md row `cli-composition`; the command's own
  // usage text says "All tasks run in dry-run mode for tools/files"). ADR-0175 D1 assigns
  // bound/ready/offer/dispatch to server composition (#3413) and D4 requires an Authority
  // Envelope before any productive tool is offered -- a bare CLI invocation holds none. Spies on
  // the real, unmocked createSession to prove no `bindToolCatalog` factory reaches HarnessDeps and
  // the composed ToolPort is the real DryRunToolPort: it advertises the compiled legacy-native
  // catalog for honest discovery yet refuses every one of those tools with a closed reason. A
  // regression that wires a productive catalog into this CLI path without an authority path fails
  // this test.
  it("composes explain-plan as the documented nonproductive dry-run readiness mode", async () => {
    vi.resetModules();
    const actualHarness = await vi.importActual<typeof import("@oscharko-dev/keiko-harness")>(
      "@oscharko-dev/keiko-harness",
    );
    const capturedConfigs: Parameters<typeof actualHarness.createSession>[1][] = [];
    const capturedDeps: Parameters<typeof actualHarness.createSession>[2][] = [];
    vi.doMock("@oscharko-dev/keiko-harness", () => ({
      ...actualHarness,
      createSession: (
        ...args: Parameters<typeof actualHarness.createSession>
      ): ReturnType<typeof actualHarness.createSession> => {
        capturedConfigs.push(args[1]);
        capturedDeps.push(args[2]);
        return actualHarness.createSession(...args);
      },
    }));
    try {
      const { runAgentCli: runAgentCliFresh } = await import("./run.js");
      const c = capture();
      const code = await runAgentCliFresh(
        ["explain-plan", "--file", "src/foo.ts", "--no-evidence", "--model", "test-model"],
        c.io,
        {},
        { model: testModel() },
      );
      expect(code).toBe(0);
      expect(capturedConfigs).toHaveLength(1);
      expect(capturedConfigs[0]?.dryRun).toBe(true);
      expect(capturedDeps).toHaveLength(1);
      const deps = capturedDeps[0];
      expect(deps).not.toHaveProperty("bindToolCatalog");
      const advertised = deps?.tools.listTools() ?? [];
      expect(advertised.length).toBeGreaterThan(0);
      const first = advertised[0];
      if (first === undefined) throw new Error("expected an advertised legacy tool");
      await expect(
        deps?.tools.execute({
          toolCallId: "tc-cli-explain",
          toolName: first.name,
          arguments: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("unavailable");
    } finally {
      vi.doUnmock("@oscharko-dev/keiko-harness");
      vi.resetModules();
    }
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
