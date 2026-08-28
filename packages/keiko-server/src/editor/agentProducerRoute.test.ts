// Issue #2489 (Findings 1/2/3) — failure-first reachability tests. Each test in the first describe
// block drives the NEW producer route (`POST /api/editor/agent/producer/turn`) through a REAL
// listening HTTP server: a scripted ModelPort decides to call one governed editor-agent tool, and
// EditorAgentToolHost dispatches it over a REAL loopback fetch() back into this SAME server's
// already-production agentRoutes.ts / agentVerificationRoute.ts handlers. Nothing about the tool
// host, the HTTP client, or the target route is mocked — only the model (no real model API in a
// unit test) and, for requestVerification only, the sandboxed script execution (mirroring
// agentVerificationRoute.test.ts's FakeManager) are faked. Before the producer route existed, every
// one of these tests 404s; this is the failure-first proof that EditorAgentToolHost went from a
// test-only construct to production dispatch.
//
// The second describe block (Finding 3) drives EditorAgentToolHost.execute() directly against the
// same real running server to prove the additive wholeWord/regex search parity fields reach real
// production dispatch (mirroring the precedent packages/keiko-harness/src/editor-agent-tool-host.
// integration.test.ts pattern). It inspects the tool's OWN parsed JSON output rather than the
// content-free producer summary, because "wholeWord"/"regex" acceptance is exactly the kind of
// per-call detail the producer's aggregate response deliberately does not expose.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CodingWorkbenchAuthorityEnvelope,
  EditorAgentGovernedAuthorityReference,
  EditorAgentSessionSnapshot,
  VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/language-service";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import {
  createFetchEditorAgentHttpTransport,
  DEFAULT_EDITOR_AGENT_LANGUAGE_TIMEOUT_MS,
  EditorAgentHttpClient,
  EditorAgentToolHost,
  type EditorAgentToolOutput,
} from "@oscharko-dev/keiko-tools";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { createRunRegistry } from "../runs.js";
import { createUiServer, UI_HOST } from "../server.js";
import type { VerificationRunInput, VerificationRunnerManager } from "./verificationRunner.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "./agentAuthorityRegistry.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { _resetEditorAgentAuditForTests, listEditorAgentActionAudit } from "./agentActionAudit.js";
import { _producerToolOutcomeForTests } from "./agentProducerRoute.js";

const SESSION_ID = "session-2489";
const HASH = "a".repeat(64);
// Issue #2713 — kept strictly below DEFAULT_EDITOR_AGENT_LANGUAGE_TIMEOUT_MS (the budget the
// producer's own tool host arms) so the server's deadline is always the one that decides. Asserted,
// not assumed, by "keeps the server's analysis deadline under the producer's client budget". The
// value itself is the fixture's original headroom for a cold bootstrap: before #2713 it was dead
// letter, because the client aborted the call at 2s no matter what this said.
const PRODUCER_LANGUAGE_DEADLINE_MS = 15_000;
const CEILING = "autonomous-delivery" as const;
const DECL_TEXT = "export const sharedValue = 1;\n";
const MAIN_TEXT = "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n";

function runGit(root: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function buildWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-agent-producer-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
      },
      include: ["src/**/*.ts"],
    }),
    "utf8",
  );
  writeFileSync(join(root, "src", "a.ts"), "export const target = 1;\ntarget;\n", "utf8");
  writeFileSync(join(root, "src", "decl.ts"), DECL_TEXT, "utf8");
  writeFileSync(join(root, "src", "main.ts"), MAIN_TEXT, "utf8");
  writeFileSync(join(root, "NEEDLE.md"), "producer-reachability-needle\n", "utf8");
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.name", "Keiko Fixture"]);
  runGit(root, ["config", "user.email", "fixture@invalid.example"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  runGit(root, ["add", "tsconfig.json", "src/a.ts", "src/decl.ts", "src/main.ts", "NEEDLE.md"]);
  runGit(root, ["commit", "-q", "-m", "fixture baseline"]);
  writeFileSync(join(root, "src", "a.ts"), "export const target = 2;\ntarget;\n", "utf8");
  return root;
}

function snapshot(root: string): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    windowId: "window-2489",
    workspaceRoot: root,
    activePaneId: "pane-2489",
    panes: [
      { paneId: "pane-2489", activeFile: "src/main.ts", openFiles: ["src/main.ts", "src/a.ts"] },
    ],
    dirtyFiles: [],
    activeFile: "src/main.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1,
  };
}

function authority(root: string): EditorAgentGovernedAuthorityReference {
  const envelope: CodingWorkbenchAuthorityEnvelope = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-2489",
    localUser: "local-operator",
    taskRefs: ["issue-2489"],
    workspace: {
      workspaceId: "workspace-2489",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(root),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: CEILING,
    deploymentCeiling: CEILING,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(CEILING, CEILING),
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-2489",
      source: "keiko-model-gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "deny",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 1,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 300_000,
      maxToolCalls: 8,
      maxPromptTokens: 100_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    approvalProofDigest: HASH,
  };
  const registered = editorAgentAuthorityRegistry.register(
    envelope,
    CEILING,
    new Date().toISOString(),
  );
  if (!registered.ok) throw new Error("expected authority registration");
  return registered.authorityRef;
}

function passingVerificationReport(): VerificationReport {
  return {
    workspaceRoot: "/repo",
    overallStatus: "passed",
    startedAtMs: 1,
    durationMs: 5,
    counts: {
      passed: 1,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
    results: [
      {
        kind: "typecheck",
        scriptName: "typecheck",
        command: "npm",
        args: ["run", "typecheck"],
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 5,
        truncated: false,
        redacted: false,
        outputSummary: "",
        appliedLimits: [],
        locations: [],
      },
    ],
  };
}

class FakeVerificationRunnerManager implements VerificationRunnerManager {
  public calls = 0;
  public readonly discover = (): never => {
    throw new Error("discover not exercised");
  };
  public readonly execute = (): never => {
    throw new Error("execute not exercised");
  };
  public readonly abort = (): boolean => false;
  public readonly inFlightCount = (): number => 0;
  public readonly subscribe = (): (() => void) => (): void => undefined;
  public readonly runToReport = (_input: VerificationRunInput): Promise<VerificationReport> => {
    this.calls += 1;
    return Promise.resolve(passingVerificationReport());
  };
}

// One scripted tool_calls turn followed by a final stop turn -- exactly the two-message shape the
// harness executor drives (model-call -> tool-call -> model-call -> reporting).
function toolCallThenStop(toolName: string, args: Record<string, unknown>): ModelPort {
  let call = 0;
  return {
    call: (): Promise<NormalizedResponse> => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          modelId: "producer-test-model",
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call-1", name: toolName, arguments: args }],
          structuredOutput: null,
          usage: {
            requestId: "r1",
            promptTokens: 1,
            completionTokens: 1,
            latencyMs: 1,
            costClass: "low",
          },
        });
      }
      return Promise.resolve({
        modelId: "producer-test-model",
        content: "done",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "r2",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "low",
        },
      });
    },
  };
}

interface Fixture {
  readonly root: string;
  readonly server: Server;
  readonly port: number;
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly verificationRunner: FakeVerificationRunnerManager;
  readonly disconnectBridge: () => void;
  setModel: (model: ModelPort) => void;
}

let fixture: Fixture | undefined;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  return (server.address() as AddressInfo).port;
}

async function createFixture(): Promise<Fixture> {
  const root = buildWorkspace();
  const store = createInMemoryUiStore();
  store.createProject(root, "fixture");
  editorAgentRegistry.registerSnapshot(snapshot(root));
  // Even server-resolved actions (navigateSymbol/searchWorkspace/queryGit) require a live bridge
  // connection (agentRoutes.ts rejectServerResolvedReplay -> hasLiveBridge), or dispatch conflicts
  // with NO_ACTIVE_SESSION instead of reaching the underlying handler.
  const disconnectBridge = editorAgentRegistry.connect(SESSION_ID, () => undefined);
  const authorityRef = authority(root);
  const verificationRunner = new FakeVerificationRunnerManager();
  let model: ModelPort = { call: () => Promise.reject(new Error("no script configured")) };
  const deps = {
    autonomousDeliveryDeploymentCeiling: CEILING,
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    store,
    modelPortFactory: (modelId: string): ModelPort | undefined =>
      modelId === "producer-test-model" ? model : undefined,
    // Issue #2713: the producer dispatches back into THIS server over a real loopback hop, so two
    // budgets bound the same navigateSymbol call -- the server's analysis deadline below, and the
    // EditorAgentHttpClient budget the producer's own tool host arms
    // (DEFAULT_EDITOR_AGENT_LANGUAGE_TIMEOUT_MS). The server's must stay UNDER the client's, or the
    // client aborts mid-analysis and the governed verdict is replaced by an opaque transport error;
    // the shared 2s client default sat BELOW this, which is how a cold TypeScript project bootstrap
    // on a loaded 4-core runner turned into `{ ok: false }` with no cause attached.
    // Raised above the production default because the cold bootstrap this fixture forces (a fresh
    // mkdtemp root per test, so the project cache always misses) is exactly the case 2s is tight for.
    editorLanguageRouteOptions: {
      now: (): number => Date.now(),
      limits: { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, deadlineMs: PRODUCER_LANGUAGE_DEADLINE_MS },
    },
    gitRouteOptions: { timeoutMs: 5_000 },
    verificationRunner,
    workspaceScriptTrust: { trustLevelForRoot: (): "trusted" => "trusted" },
  } as unknown as UiHandlerDeps;
  // Two-phase bootstrap (mirrors tests/editor-agent-managed-lsp.integration.test.ts): the server
  // validates the request Host header against its OWN configured `port`, so the port must be known
  // before the real server is constructed. Learn the OS-assigned ephemeral port on a throwaway
  // server, close it, then rebuild with that exact port bound into config and listen for real.
  let server = createUiServer({ staticRoot: root, csp: "", port: 0, handlerDeps: deps });
  const port = await listen(server);
  await closeServer(server);
  server = createUiServer({ staticRoot: root, csp: "", port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  return {
    root,
    server,
    port,
    authorityRef,
    verificationRunner,
    disconnectBridge,
    setModel: (next: ModelPort): void => {
      model = next;
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

interface ProducerTurnResponse {
  readonly status: number;
  readonly body: {
    readonly runId?: string;
    readonly outcome?: string;
    readonly toolCallCount?: number;
    readonly toolNames?: readonly string[];
    readonly toolOutcomes?: readonly {
      readonly toolName: string;
      readonly ok: boolean;
      readonly status?: string;
      readonly failureKind?: string;
    }[];
    readonly error?: { readonly code: string };
  };
}

async function postProducerTurn(
  port: number,
  overrides: Record<string, unknown> = {},
): Promise<ProducerTurnResponse> {
  const response = await fetch(`http://${UI_HOST}:${String(port)}/api/editor/agent/producer/turn`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      sessionId: SESSION_ID,
      modelId: "producer-test-model",
      goal: "reachability probe",
      authorityRef: fixture?.authorityRef,
      ...overrides,
    }),
  });
  const body = (await response.json()) as ProducerTurnResponse["body"];
  return { status: response.status, body };
}

// Asserts the producer genuinely reached a SUCCEEDED dispatch, not merely an invoked-but-conflicted
// one (e.g. NO_ACTIVE_SESSION still counts as an invoked, completed harness tool call).
//
// Issue #2713: every assertion carries the serialized body. The #2704 shard run that exposed the
// navigateSymbol flake printed nothing but `[{ toolName, ok: false }]`, which named no cause and
// cost a full CI cycle to even categorise; with the body attached, the next occurrence reports the
// governed status or the `failureKind` discriminator that says WHICH layer refused.
function expectSucceededToolOutcome(
  response: ProducerTurnResponse,
  toolName: string,
  expectedStatus: string,
): void {
  const detail = JSON.stringify(response.body);
  expect(response.status, detail).toBe(200);
  expect(response.body.outcome, detail).toBe("completed");
  expect(response.body.toolCallCount, detail).toBe(1);
  expect(response.body.toolNames, detail).toEqual([toolName]);
  expect(response.body.toolOutcomes, detail).toEqual([
    { toolName, ok: true, status: expectedStatus },
  ]);
}

beforeEach(async () => {
  editorAgentRegistry.reset();
  editorAgentAuthorityRegistry.reset();
  _resetEditorAgentAuditForTests();
  fixture = await createFixture();
});

afterEach(async () => {
  if (fixture !== undefined) {
    fixture.disconnectBridge();
    await closeServer(fixture.server);
    rmSync(fixture.root, { recursive: true, force: true });
  }
  editorAgentRegistry.reset();
  editorAgentAuthorityRegistry.reset();
  _resetEditorAgentAuditForTests();
  fixture = undefined;
});

describe("editor-agent producer turn reachability (#2489 Findings 1/2)", () => {
  it("drives editor_navigate_symbol to real production dispatch", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    current.setModel(
      toolCallThenStop("editor_navigate_symbol", {
        sessionId: SESSION_ID,
        idempotencyKey: "idem-navigate-1",
        file: "src/main.ts",
        operation: "definition",
        position: { line: 1, character: 19 },
        languageId: "typescript",
        text: MAIN_TEXT,
      }),
    );
    const response = await postProducerTurn(current.port);
    expectSucceededToolOutcome(response, "editor_navigate_symbol", "succeeded");
  });

  it("drives editor_search_workspace to real production dispatch", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    current.setModel(
      toolCallThenStop("editor_search_workspace", {
        sessionId: SESSION_ID,
        idempotencyKey: "idem-search-1",
        query: "producer-reachability-needle",
        mode: "text",
        maxResults: 5,
      }),
    );
    const response = await postProducerTurn(current.port);
    expectSucceededToolOutcome(response, "editor_search_workspace", "succeeded");
  });

  it("drives editor_git_context to real production dispatch", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    current.setModel(
      toolCallThenStop("editor_git_context", {
        sessionId: SESSION_ID,
        idempotencyKey: "idem-git-1",
        path: "src/a.ts",
        aspects: ["status", "diff"],
      }),
    );
    const response = await postProducerTurn(current.port);
    expectSucceededToolOutcome(response, "editor_git_context", "succeeded");
  });

  it("drives editor_request_verification to real production dispatch", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    current.setModel(
      toolCallThenStop("editor_request_verification", {
        sessionId: SESSION_ID,
        kind: "typecheck",
      }),
    );
    const response = await postProducerTurn(current.port);
    expectSucceededToolOutcome(response, "editor_request_verification", "completed");
    expect(current.verificationRunner.calls).toBe(1);
  });

  // Issue #2713 — the #2704 shard exposed this test file failing with `{ ok: false }` because TWO
  // budgets bound one navigateSymbol dispatch and the wrong one was smaller: the producer's tool
  // host armed the shared 2s client default while the server was still inside a cold TypeScript
  // project bootstrap. Whenever the client budget is the smaller of the two, the client aborts
  // mid-analysis and the caller sees an opaque transport error instead of the server's governed
  // verdict -- so the ordering, not either number on its own, is the invariant worth pinning here.
  it("keeps the server's analysis deadline under the producer's client budget", () => {
    expect(PRODUCER_LANGUAGE_DEADLINE_MS).toBeLessThan(DEFAULT_EDITOR_AGENT_LANGUAGE_TIMEOUT_MS);
    expect(DEFAULT_EDITOR_AGENT_LANGUAGE_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_LANGUAGE_SERVICE_LIMITS.deadlineMs,
    );
  });

  it("404s before/without the producer route for an unknown pattern (route existence sanity)", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const response = await fetch(
      `http://${UI_HOST}:${String(current.port)}/api/editor/agent/producer/does-not-exist`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(404);
  });
});

// Coverage: the four validation/error branches handleEditorAgentProducerTurn fails closed on
// before ever building a tool host or starting a harness turn. None of the reachability tests
// above exercise these -- they all POST a well-formed body against a registered session, a
// configured model, and a valid authority reference.
describe("editor-agent producer turn error paths (#2489 coverage)", () => {
  it("400s on a malformed request body before any dispatch (INVALID_REQUEST)", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const response = await postProducerTurn(current.port, { goal: "" });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("INVALID_REQUEST");
  });

  it("404s for a sessionId with no registered snapshot (SESSION_NOT_FOUND)", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const response = await postProducerTurn(current.port, { sessionId: "unknown-session" });
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe("SESSION_NOT_FOUND");
  });

  it("503s when no model is configured for the requested modelId (MODEL_UNAVAILABLE)", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const response = await postProducerTurn(current.port, { modelId: "unconfigured-model" });
    expect(response.status).toBe(503);
    expect(response.body.error?.code).toBe("MODEL_UNAVAILABLE");
  });

  it("400s on an authorityRef that fails downstream validation (AUTHORITY_INVALID)", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const response = await postProducerTurn(current.port, {
      authorityRef: { runId: "", envelopeDigest: "" },
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("AUTHORITY_INVALID");
  });
});

// Security hardening (found by /security-review on this PR): the model's tool_call.name is
// untrusted (ADR-0004 — model output is never executed as an instruction) and is NOT constrained
// to what listTools() advertised. Before this fix, scopedProducerToolPort.execute() forwarded ANY
// toolName straight to the real EditorAgentToolHost regardless of PRODUCER_TOOL_NAMES, so a
// prompt-injected turn could reach a review-gated mutation tool (editor_propose_edit /
// editor_propose_changeset) the producer deliberately does not advertise. This proves the
// allowlist is now enforced at dispatch, not only at advertisement: the out-of-scope call is
// rejected before it ever reaches the tool host, so the mutation action never reaches
// agentRoutes.ts (asserted via the empty audit ledger for the session).
describe("editor-agent producer tool-scope enforcement (#2489 security hardening)", () => {
  it("rejects a tool call outside the advertised producer surface before it reaches the host", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    current.setModel(
      toolCallThenStop("editor_propose_edit", {
        sessionId: SESSION_ID,
        idempotencyKey: "idem-out-of-scope-1",
        type: "applyTextEdits",
        file: "src/a.ts",
        textEdits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "// injected\n",
          },
        ],
      }),
    );
    const response = await postProducerTurn(current.port);
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe("completed");
    expect(response.body.toolCallCount).toBe(1);
    // #2713 strengthens this pin rather than relaxing it: the rejection must still be a FAILURE, and
    // it must now also identify itself as a PRE-DISPATCH refusal ("invalid-arguments"), never a
    // route/transport kind — which would mean the call had actually reached a downstream route. The
    // audit-ledger assertion below stays the decisive proof; this only narrows what may precede it.
    expect(response.body.toolOutcomes).toEqual([
      { toolName: "editor_propose_edit", ok: false, failureKind: "invalid-arguments" },
    ]);
    // The decisive proof: a real applyTextEdits dispatch would have reached agentRoutes.ts and
    // been audited (queued for browser-bridge review or denied) — zero audit entries proves the
    // request never left the producer's own scope check.
    expect(listEditorAgentActionAudit(SESSION_ID)).toHaveLength(0);
  });
});

function toolOutput(result: { readonly output: string }): EditorAgentToolOutput {
  return JSON.parse(result.output) as EditorAgentToolOutput;
}

// Issue #2713 — `failureKind` is only admissible because it can never carry content: it is echoed
// only when it is one of the tool output's own six failure literals, and dropped otherwise. No real
// dispatch can produce an unknown kind (every output the producer parses is built in-process by
// EditorAgentToolHost), so the degraded arms are unreachable through the route and are proven here
// against the pure parser instead. Without this, the fail-closed claim is prose with no test.
describe("producer tool outcome failure discrimination (#2713)", () => {
  it.each([
    ["a transport abort", { kind: "transport", code: "TIMED_OUT" }, "transport"],
    ["a route rejection", { kind: "route", code: "DENIED" }, "route"],
    ["a host failure", { kind: "host", code: "HOST_FAILURE" }, "host"],
  ])("names %s by its own kind", (_case, error, expected) => {
    expect(_producerToolOutcomeForTests("tool", JSON.stringify({ ok: false, error }))).toEqual({
      toolName: "tool",
      ok: false,
      failureKind: expected,
    });
  });

  it.each([
    ["an unknown kind", { ok: false, error: { kind: "exfiltrate", code: "X" } }],
    ["a kind carrying content instead of an enum", { ok: false, error: { kind: "/etc/passwd" } }],
    ["a non-string kind", { ok: false, error: { kind: 7 } }],
    ["a non-record error", { ok: false, error: "boom" }],
    ["no error at all", { ok: false }],
    ["a non-record payload", [1, 2, 3]],
  ])("drops %s rather than echoing it", (_case, payload) => {
    expect(_producerToolOutcomeForTests("tool", JSON.stringify(payload))).toEqual({
      toolName: "tool",
      ok: false,
    });
  });

  it("stays content-free when the output is not JSON at all", () => {
    expect(_producerToolOutcomeForTests("tool", "not json")).toEqual({
      toolName: "tool",
      ok: false,
    });
  });
});

describe("editor_search_workspace wholeWord/regex parity (#2489 Finding 3)", () => {
  it("accepts wholeWord against real production dispatch", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const host = new EditorAgentToolHost({
      client: new EditorAgentHttpClient({
        baseUrl: `http://${UI_HOST}:${String(current.port)}`,
        transport: createFetchEditorAgentHttpTransport(),
      }),
      authorityRef: current.authorityRef,
      nextActionId: (): string => "action-parity-1",
    });
    const result = await host.execute({
      toolCallId: "call-parity-1",
      toolName: "editor_search_workspace",
      arguments: {
        sessionId: SESSION_ID,
        idempotencyKey: "idem-parity-wholeword",
        query: "needle",
        mode: "text",
        wholeWord: true,
        maxResults: 5,
      },
      signal: new AbortController().signal,
    });
    const output = toolOutput(result);
    expect(output.ok).toBe(true);
    if (output.ok && output.kind === "action-result") {
      expect(output.result.status).toBe("succeeded");
    }
  });

  // A query with regex metacharacters that has no literal occurrence in the fixture but DOES match
  // the fixture's NEEDLE.md content as a pattern — proves "regex" genuinely switches the search
  // semantics end to end (agentRoutes.ts's runSearchWorkspaceAction -> handleEditorWorkspaceSearch),
  // not just that the extra enum value is accepted and silently ignored.
  it("accepts regex mode and applies real regex semantics through production dispatch", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const host = new EditorAgentToolHost({
      client: new EditorAgentHttpClient({
        baseUrl: `http://${UI_HOST}:${String(current.port)}`,
        transport: createFetchEditorAgentHttpTransport(),
      }),
      authorityRef: current.authorityRef,
      nextActionId: (): string => "action-parity-2",
    });
    const result = await host.execute({
      toolCallId: "call-parity-2",
      toolName: "editor_search_workspace",
      arguments: {
        sessionId: SESSION_ID,
        idempotencyKey: "idem-parity-regex",
        query: "produc.r-.*-needle",
        mode: "regex",
        maxResults: 5,
      },
      signal: new AbortController().signal,
    });
    const output = toolOutput(result);
    expect(output.ok).toBe(true);
    if (output.ok && output.kind === "action-result" && output.result.status === "succeeded") {
      const data = output.result.data as { readonly results?: readonly unknown[] } | undefined;
      expect(data?.results?.length ?? 0).toBeGreaterThan(0);
    } else {
      throw new Error(`expected a succeeded regex search, got ${JSON.stringify(output)}`);
    }
  });

  // "symbol" mode routes through a wholly different handler (symbolSearchContext ->
  // handleEditorWorkspaceSymbols) than "text"/"regex" (textSearchContext ->
  // handleEditorWorkspaceSearch); neither path is exercised by the other two tests above.
  it("accepts symbol mode and dispatches to the workspace-symbols handler", async () => {
    const current = fixture;
    if (current === undefined) throw new Error("fixture missing");
    const host = new EditorAgentToolHost({
      client: new EditorAgentHttpClient({
        baseUrl: `http://${UI_HOST}:${String(current.port)}`,
        transport: createFetchEditorAgentHttpTransport(),
      }),
      authorityRef: current.authorityRef,
      nextActionId: (): string => "action-parity-3",
    });
    const result = await host.execute({
      toolCallId: "call-parity-3",
      toolName: "editor_search_workspace",
      arguments: {
        sessionId: SESSION_ID,
        idempotencyKey: "idem-parity-symbol",
        query: "target",
        mode: "symbol",
        maxResults: 5,
      },
      signal: new AbortController().signal,
    });
    const output = toolOutput(result);
    expect(output.ok).toBe(true);
    if (output.ok && output.kind === "action-result") {
      expect(output.result.status).toBe("succeeded");
    }
  });
});
