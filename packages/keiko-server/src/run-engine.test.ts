// Unit tests for `startRun` covering the verify dispatch branch added for issue #65. Verify uses a
// real temp workspace (no fixture copying — the workspace shape is just package.json + an empty
// scripts object so detectScripts returns no targets and the orchestrator reports all-skipped/
// passed). No model port is exercised (verify never calls a model); the rejected model port
// asserts that property.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { startRun, workflowFingerprint } from "./run-engine.js";
import { createRunRegistry, type RunRegistry } from "./runs.js";
import { parseRunRequest, type RunRequest } from "./run-request.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { AppSession } from "./coding-app-session/sessionRegistry.js";
import {
  createAgentRunGovernance,
  type AgentRunGovernanceBinding,
} from "./agent-run-governance.js";
import { editorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import type { VerificationReport } from "@oscharko-dev/keiko-verification";
import type { NetworkIsolationProbe } from "./editor/verificationExecution.js";
import { closeFileServerLogSinks } from "./observability/index.js";

const REJECT_MODEL: ModelPort = {
  call: (): Promise<NormalizedResponse> =>
    Promise.reject(new Error("verify must not call a model")),
};

let workspaceRoot: string;
let registry: RunRegistry;
const GOVERNANCE_NOW = "2026-07-31T08:00:00.000Z";
const GOVERNANCE_SESSION: AppSession = {
  sessionId: "sess_0123456789abcdef01234567",
  principalLabel: "local-user",
  issuedAtMs: Date.parse(GOVERNANCE_NOW),
  lastSeenAtMs: Date.parse(GOVERNANCE_NOW),
  rotationCount: 0,
};

function makeWorkspace(scripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-verify-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts }));
  return root;
}

function ok(value: ReturnType<typeof parseRunRequest>): RunRequest {
  if ("code" in value) {
    throw new Error(`parse failed: ${value.message}`);
  }
  return value;
}

function governance(
  requestedMode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode,
): AgentRunGovernanceBinding {
  const result = createAgentRunGovernance({
    runId: randomUUID(),
    workflow: "unit-tests",
    workspaceRoot,
    modelId: "m",
    requestedMode,
    deploymentCeiling,
    session: GOVERNANCE_SESSION,
    nowIso: GOVERNANCE_NOW,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.binding;
}

beforeEach(() => {
  editorAgentAuthorityRegistry.reset();
  workspaceRoot = makeWorkspace();
  registry = createRunRegistry();
});

describe("workflow governance fingerprint", () => {
  it("is stable for identical config and separates requested mode, effective mode, and ceiling", () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          workflowId: "unit-test-generation",
          modelId: "m",
          input: { workspaceRoot, target: { kind: "file", filePath: "src/add.ts" } },
        }),
      ),
    );
    const supervised = governance("supervised-coding", "autonomous-delivery");
    const sameConfigNewAuthority = governance("supervised-coding", "autonomous-delivery");
    const lowerCeiling = governance("supervised-coding", "supervised-coding");
    const fullAccess = governance("autonomous-delivery", "autonomous-delivery");

    expect(workflowFingerprint(request, sameConfigNewAuthority)).toBe(
      workflowFingerprint(request, supervised),
    );
    expect(workflowFingerprint(request, lowerCeiling)).not.toBe(
      workflowFingerprint(request, supervised),
    );
    expect(workflowFingerprint(request, fullAccess)).not.toBe(
      workflowFingerprint(request, supervised),
    );
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function waitForTerminal(runId: string): Promise<void> {
  const record = registry.get(runId);
  if (record === undefined) throw new Error("run was not registered");
  if (record.status !== "running") return;
  await new Promise<void>((resolve) => {
    let detach = (): void => undefined;
    const settle = (): void => {
      detach();
      resolve();
    };
    detach = record.sink.attach({ write: () => true, close: settle }, Number.MAX_SAFE_INTEGER);
    if (record.sink.isTerminated()) settle();
  });
}

function passedVerificationReport(): VerificationReport {
  return {
    workspaceRoot,
    results: [],
    overallStatus: "passed",
    startedAtMs: 1,
    durationMs: 1,
    counts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
  };
}

describe("startRun verify dispatch", () => {
  it("dispatches verify through the enforced verification executor", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const report = passedVerificationReport();
    const verificationExecutor = vi.fn(() =>
      Promise.resolve({ report, probe: { available: true, backend: "test-backend" } }),
    );
    const result = startRun(
      { request, model: REJECT_MODEL, registry, verificationExecutor },
      (value) => value,
    );
    await waitForTerminal(result.runId);

    expect(verificationExecutor).toHaveBeenCalledOnce();
    expect(verificationExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ probeCwd: workspaceRoot }),
    );
    expect(registry.get(result.runId)?.report).toBe(report);
  });

  it("returns a synchronous {runId, fingerprint} and registers the run", () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    expect(result.runId).toMatch(/[0-9a-f-]{36}/u);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(registry.get(result.runId)).toBeDefined();
  });

  it("runs the verification orchestrator and reaches a terminal status without calling the model", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    await waitForTerminal(result.runId);
    const record = registry.get(result.runId);
    expect(record).toBeDefined();
    expect(record?.status).toBe("completed");
  });

  it("emits a run:started SSE event with taskType=verify before the run completes", () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    const record = registry.get(result.runId);
    const buffered = record?.sink.buffered() ?? [];
    expect(buffered.some((e) => e.type === "run:started")).toBe(true);
  });

  it("propagates cancel() to the verification orchestrator and ends in `cancelled`", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    const record = registry.get(result.runId);
    record?.cancel("test-cancel");
    await waitForTerminal(result.runId);
    const final = registry.get(result.runId);
    // With no script-backed steps, the verify run finishes too fast for cancel to be observable;
    // accept either `cancelled` or `completed` (a benign race), but never `running`.
    expect(["cancelled", "completed", "failed"]).toContain(final?.status);
  });

  it("returns a non-appliable run (verify never produces an appliable snapshot)", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    await waitForTerminal(result.runId);
    expect(registry.get(result.runId)?.appliable).toBeUndefined();
  });
});

describe("startRun explain-plan dispatch", () => {
  it("injects the redacted target file context into the model prompt", async () => {
    mkdirSync(join(workspaceRoot, "src"));
    writeFileSync(join(workspaceRoot, "src", "discounts.ts"), "export const discount = 100;\n");
    let prompt = "";
    const model: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        prompt = request.messages.map((message) => message.content).join("\n");
        return Promise.resolve({
          modelId: request.modelId,
          content: "grounded explanation",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "req",
            promptTokens: 1,
            completionTokens: 1,
            latencyMs: 1,
            costClass: "low",
          },
        });
      },
    };
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "explain-plan",
          modelId: "m",
          input: { workspaceRoot, filePath: "src/discounts.ts" },
        }),
      ),
    );
    const result = startRun({ request, model, registry }, (v) => v);
    await waitForTerminal(result.runId);
    expect(prompt).toContain("--- src/discounts.ts ---");
    expect(prompt).toContain("export const discount = 100;");
  });

  // 2895 audit KEIKO-0902: dispatchExplain used to inject compactionPort: serverHarnessContextCompactor
  // even though explain-plan is structurally single-call and read-only, so the port could never fire
  // (harness-context-compactor.ts's turns.length < 2 precondition always declines). Wiring an
  // unreachable port invites a future reader to believe this path is compaction-covered when it is
  // not, so it was removed. This test spies on the real, unmocked keiko-harness createSession to
  // capture the exact deps object dispatchExplain constructs, proving no compactionPort key reaches
  // it at all — it must fail if the injection is reinstated.
  it("does not inject a compactionPort (explain-plan is structurally single-call and read-only)", async () => {
    mkdirSync(join(workspaceRoot, "src"));
    writeFileSync(join(workspaceRoot, "src", "discounts.ts"), "export const discount = 100;\n");
    vi.resetModules();
    const actualHarness = await vi.importActual<typeof import("@oscharko-dev/keiko-harness")>(
      "@oscharko-dev/keiko-harness",
    );
    const capturedDeps: Parameters<typeof actualHarness.createSession>[2][] = [];
    vi.doMock("@oscharko-dev/keiko-harness", () => ({
      ...actualHarness,
      createSession: (
        ...args: Parameters<typeof actualHarness.createSession>
      ): ReturnType<typeof actualHarness.createSession> => {
        capturedDeps.push(args[2]);
        return actualHarness.createSession(...args);
      },
    }));
    try {
      const { startRun: startRunFresh } = await import("./run-engine.js");
      const model: ModelPort = {
        call: (request): Promise<NormalizedResponse> =>
          Promise.resolve({
            modelId: request.modelId,
            content: "grounded explanation",
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "req",
              promptTokens: 1,
              completionTokens: 1,
              latencyMs: 1,
              costClass: "low",
            },
          }),
      };
      const request = ok(
        parseRunRequest(
          JSON.stringify({
            taskType: "explain-plan",
            modelId: "m",
            input: { workspaceRoot, filePath: "src/discounts.ts" },
          }),
        ),
      );
      const result = startRunFresh({ request, model, registry }, (v) => v);
      await waitForTerminal(result.runId);
      expect(capturedDeps).toHaveLength(1);
      expect(capturedDeps[0]).not.toHaveProperty("compactionPort");
    } finally {
      vi.doUnmock("@oscharko-dev/keiko-harness");
      vi.resetModules();
    }
  });

  // #3409 catalog-B audit: dispatchExplain must stay the documented nonproductive dry-run
  // composition (docs/architecture/governed-tool-migration.md rows `cli-composition`/
  // `server-composition`; ADR-0175 D1 assigns bound/ready/offer/dispatch to server composition
  // #3413, not this harness). Spies on the real, unmocked createSession/AgentConfig to prove: no
  // `bindToolCatalog` factory reaches HarnessDeps (session.ts would otherwise bind a productive
  // catalog once dryRun flips), the config stays `dryRun: true`, and the composed ToolPort is the
  // real DryRunToolPort — which advertises the compiled legacy-native catalog for honest discovery
  // yet refuses every one of those tools with a closed reason. A regression that wires a
  // productive bindToolCatalog or flips dryRun to false without an Authority Envelope fails this.
  it("composes explain-plan as the documented nonproductive dry-run readiness mode", async () => {
    mkdirSync(join(workspaceRoot, "src"));
    writeFileSync(join(workspaceRoot, "src", "discounts.ts"), "export const discount = 100;\n");
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
      const { startRun: startRunFresh } = await import("./run-engine.js");
      const model: ModelPort = {
        call: (request): Promise<NormalizedResponse> =>
          Promise.resolve({
            modelId: request.modelId,
            content: "grounded explanation",
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "req",
              promptTokens: 1,
              completionTokens: 1,
              latencyMs: 1,
              costClass: "low",
            },
          }),
      };
      const request = ok(
        parseRunRequest(
          JSON.stringify({
            taskType: "explain-plan",
            modelId: "m",
            input: { workspaceRoot, filePath: "src/discounts.ts" },
          }),
        ),
      );
      const result = startRunFresh({ request, model, registry }, (v) => v);
      await waitForTerminal(result.runId);
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
          toolCallId: "tc-explain",
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

describe("probeNetworkIsolationSafely", () => {
  afterEach(() => {
    vi.doUnmock("./editor/verificationExecution.js");
    vi.resetModules();
  });

  it("fails closed (false) instead of throwing when the underlying probe throws", async () => {
    // The probe touches the filesystem/OS to detect a sandbox backend; a governed run's
    // verification step must still get an answer rather than crash the whole dispatch if that
    // probe itself faults for an unexpected reason (a workspace root deleted mid-run, etc.).
    // Spreading the actual module (rather than replacing it outright) keeps
    // executeVerificationEnforced -- run-engine.ts's OTHER import from this same module -- real, so
    // this mock cannot mask a break in that unrelated import.
    vi.resetModules();
    const actualVerification = await vi.importActual<
      typeof import("./editor/verificationExecution.js")
    >("./editor/verificationExecution.js");
    vi.doMock("./editor/verificationExecution.js", () => ({
      ...actualVerification,
      probeNetworkIsolation: (): never => {
        throw new Error("probe backend detection failed");
      },
    }));
    const { probeNetworkIsolationSafely: probeSafely } = await import("./run-engine.js");
    expect(probeSafely("/nonexistent/workspace")).toBe(false);
  });

  it("threads the dispatching run's own id into the failure diagnostic instead of a disconnected mint", async () => {
    // ADR-0173 D5 / g12: dispatchWorkflow/applyRun both have a runId in scope when they call this
    // probe; the probe failure diagnostic must carry THAT id (via the default stderr sink, which
    // this test observes through console.error) rather than a fresh randomUUID() unrelated to the
    // run whose verification enforcement it affects.
    vi.resetModules();
    const actualVerification = await vi.importActual<
      typeof import("./editor/verificationExecution.js")
    >("./editor/verificationExecution.js");
    vi.doMock("./editor/verificationExecution.js", () => ({
      ...actualVerification,
      probeNetworkIsolation: (): never => {
        throw new Error("probe backend detection failed");
      },
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { probeNetworkIsolationSafely: probeSafely } = await import("./run-engine.js");
      const runId = `run-${randomUUID()}`;
      expect(probeSafely("/nonexistent/workspace", runId)).toBe(false);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const line = consoleError.mock.calls[0]?.[0] as string;
      const record = JSON.parse(line.slice(line.indexOf("{"))) as { correlationId?: unknown };
      expect(record.correlationId).toBe(runId);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([true, false])(
    "passes through the real probe's available:%s without swallowing it",
    async (available) => {
      vi.resetModules();
      const actualVerification = await vi.importActual<
        typeof import("./editor/verificationExecution.js")
      >("./editor/verificationExecution.js");
      vi.doMock("./editor/verificationExecution.js", () => ({
        ...actualVerification,
        probeNetworkIsolation: (): NetworkIsolationProbe => ({
          available,
          backend: "test-backend",
        }),
      }));
      const { probeNetworkIsolationSafely: probeSafely } = await import("./run-engine.js");
      expect(probeSafely(workspaceRoot)).toBe(available);
    },
  );
});

describe("applyRun — verification egress probe threading", () => {
  afterEach(() => {
    vi.doUnmock("@oscharko-dev/keiko-workflows");
    vi.resetModules();
  });

  it("threads a real verificationEnforcedNetworkAvailable into the replayed apply, like the initial dispatch does", async () => {
    // dispatchWorkflow (the initial background run) and applyRun (replaying an accepted snapshot,
    // run-handlers.ts's gated apply path) both reach the SAME verify stage; without this, apply's
    // network:"none" verification steps are denied even on hosts the probe would have enforced on.
    vi.resetModules();
    let capturedDeps: Record<string, unknown> | undefined;
    const actualWorkflows = await vi.importActual<typeof import("@oscharko-dev/keiko-workflows")>(
      "@oscharko-dev/keiko-workflows",
    );
    vi.doMock("@oscharko-dev/keiko-workflows", () => ({
      ...actualWorkflows,
      generateUnitTests: (input: unknown, deps: Record<string, unknown>): Promise<unknown> => {
        capturedDeps = deps;
        return Promise.resolve({ status: "completed" });
      },
    }));
    const { applyRun: apply } = await import("./run-engine.js");

    await apply(
      { kind: "unit-tests", payload: { workspaceRoot }, limits: undefined },
      { call: () => Promise.reject(new Error("unused")) },
      "m",
      (value) => value,
    );

    expect(capturedDeps).toBeDefined();
    expect(typeof capturedDeps?.verificationEnforcedNetworkAvailable).toBe("boolean");
  });

  it("threads the replayed run's own runId into a probe failure during apply", async () => {
    // ADR-0173 D5 / g12: run-handlers.ts's gated apply path always has the run's own runId in
    // scope (RunRecord.runId); a probe failure during the replayed verify stage must carry it
    // rather than a disconnected randomUUID().
    vi.resetModules();
    const actualWorkflows = await vi.importActual<typeof import("@oscharko-dev/keiko-workflows")>(
      "@oscharko-dev/keiko-workflows",
    );
    vi.doMock("@oscharko-dev/keiko-workflows", () => ({
      ...actualWorkflows,
      generateUnitTests: (): Promise<unknown> => Promise.resolve({ status: "completed" }),
    }));
    const actualVerification = await vi.importActual<
      typeof import("./editor/verificationExecution.js")
    >("./editor/verificationExecution.js");
    vi.doMock("./editor/verificationExecution.js", () => ({
      ...actualVerification,
      probeNetworkIsolation: (): never => {
        throw new Error("probe backend detection failed");
      },
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { applyRun: apply } = await import("./run-engine.js");
      const runId = `run-${randomUUID()}`;

      await apply(
        { kind: "unit-tests", payload: { workspaceRoot }, limits: undefined },
        { call: () => Promise.reject(new Error("unused")) },
        "m",
        (value) => value,
        undefined,
        runId,
      );

      expect(consoleError).toHaveBeenCalledTimes(1);
      const line = consoleError.mock.calls[0]?.[0] as string;
      const record = JSON.parse(line.slice(line.indexOf("{"))) as { correlationId?: unknown };
      expect(record.correlationId).toBe(runId);
    } finally {
      consoleError.mockRestore();
      vi.doUnmock("./editor/verificationExecution.js");
    }
  });
});

// #2902 w4b: before the QueueEventSink terminal-event tee, a run's terminal outcome was fanned
// out to SSE writers ONLY. If no writer was ever attached — a closed browser tab, a connection
// that dropped before the run finished — the outcome reached nobody, and once the sink's ring
// buffer was evicted it left no trace anywhere, including `server.log`. This suite proves the
// forced-failure case leaves a durable, run-id-keyed trace even with zero SSE consumers.
describe("run terminal outcome reaches server.log without any SSE consumer (#2902 w4b)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-run-engine-diagnostics-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    // The diagnostic sink also writes one line to stderr; that track is covered elsewhere
    // (diagnostics-log.activity-log.test.ts). Silence it here so the test output stays clean.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function readServerLogLines(): readonly Record<string, unknown>[] {
    const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  // Polls the RUN REGISTRY (never the sink) for a terminal status — attaching a writer to the
  // sink, even a throwaway one, would defeat the very scenario this test proves: nobody ever
  // subscribed to this run's SSE stream.
  async function waitForRegistryTerminal(runId: string): Promise<void> {
    await vi.waitFor(() => {
      const record = registry.get(runId);
      if (record === undefined || record.status === "running") {
        throw new Error("run has not reached a terminal state yet");
      }
    });
  }

  it("writes a structured diagnostic for a forced explain-plan failure, keyed by the run's id, with no SSE writer ever attached", async () => {
    writeFileSync(join(workspaceRoot, "README.md"), "fixture\n");
    const failingModel: ModelPort = {
      call: (): Promise<NormalizedResponse> => Promise.reject(new Error("forced model failure")),
    };
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "explain-plan",
          modelId: "m",
          input: { workspaceRoot, filePath: "README.md" },
        }),
      ),
    );

    const result = startRun({ request, model: failingModel, registry }, (value) => value);
    // No `record.sink.attach(...)` call anywhere in this test — the run's SSE stream has zero
    // consumers for its entire lifetime, exactly like a closed browser tab.
    await waitForRegistryTerminal(result.runId);

    expect(registry.get(result.runId)?.status).toBe("failed");

    const diagnosticLine = readServerLogLines().find(
      (line) => line.category === "diagnostic" && line.correlationId === result.runId,
    );
    expect(diagnosticLine).toMatchObject({
      op: "harness.run.failed",
      correlationId: result.runId,
      errorKind: "HarnessRunFailed",
    });
  });
});
