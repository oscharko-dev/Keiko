import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  EditorM7SettingId,
  EditorM7SettingValue,
  EditorM7SettingsSnapshot,
  EditorAgentSessionSnapshot,
  EditorTestGenerationWireResponse,
  EvidenceStore,
  GatewayVerificationState,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  resolveEditorM7Settings,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { probeVerifiedGatewayConfig } from "../_support.js";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "../diagnostics-log.js";
import type { UiStore } from "../store/index.js";
import {
  handleEditorTestGeneration,
  isTestGenerationEnabledByPolicy,
  isTestGenerationExecutionEnabledByPolicy,
  type EditorTestGenerationRouteOptions,
} from "./testGenerationRoutes.js";
import type { TestGenerationRunner } from "./testGenerationRunner.js";
import type { AssuredPreFilterPort } from "./assuredPreFilterRunner.js";
import type { EditorTestGenerationFunnel } from "@oscharko-dev/keiko-contracts";
import { editorAgentRegistry } from "./agentSessionRegistry.js";

let root: string;
let store: UiStore;

function postContext(body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    correlationId: undefined,
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/test-generation"),
  };
}

function rawPostContext(body: string): RouteContext {
  const req = Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    correlationId: undefined,
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/test-generation"),
  };
}

// A configured, credentialed chat gateway. The generation runner is injected in every test, so the
// config exists only to make the deployment the AI-assist projection sees a real one (F-01).
function chatGatewayConfig(): GatewayConfig {
  return {
    providers: [{ modelId: "test-generation-model", baseUrl: "http://localhost", apiKey: "x" }],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [],
  } as unknown as GatewayConfig;
}

// F-01: test generation is admitted only while AI-assist activation is active, and activation now
// requires a probe-confirmed gateway rather than a configured one. This suite is about the generation
// and verification seam behind that gate, so it runs against a gateway whose last readiness probe
// passed; the gate itself is pinned in editor/aiAssistActivation.test.ts.
function deps(
  input: {
    env?: Record<string, string | undefined>;
    evidenceStore?: EvidenceStore;
    aiSettings?: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined;
    gatewayVerification?: GatewayVerificationState;
    diagnostics?: ServerDiagnosticSink | undefined;
  } = {},
): UiHandlerDeps {
  const aiSettings = input.aiSettings ?? { testGeneration: true };
  const config = chatGatewayConfig();
  const gatewayConfig = probeVerifiedGatewayConfig(config);
  if (input.gatewayVerification !== undefined) {
    gatewayConfig.recordVerification(input.gatewayVerification);
  }
  return {
    store,
    redactor: buildRedactor(input.env ?? {}, undefined),
    evidenceStore: input.evidenceStore ?? createInMemoryEvidenceStore(),
    env: input.env ?? {},
    editorSettingsControl: editorSettingsControl(aiSettings),
    config,
    gatewayConfig,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  } as unknown as UiHandlerDeps;
}

// Capturing operator-diagnostic sink (never the default stderr sink) for the observability pin below.
function capturingDiagnostics(): {
  readonly sink: ServerDiagnosticSink;
  readonly records: ServerDiagnosticRecord[];
} {
  const records: ServerDiagnosticRecord[] = [];
  return {
    records,
    sink: {
      record: (entry: ServerDiagnosticRecord): void => {
        records.push(entry);
      },
    },
  };
}

function editorSettingsSnapshot(
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>,
): EditorM7SettingsSnapshot {
  const userValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  const workspaceValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  if (values.inlineCompletion !== undefined) {
    userValues.inlineCompletion = values.inlineCompletion;
  }
  if (values.testGeneration !== undefined) {
    workspaceValues.testGeneration = values.testGeneration;
  }
  if (values.patchApply !== undefined) {
    workspaceValues.patchApply = values.patchApply;
  }
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 1,
    revision: 1_000_002,
    etag: '"edm7-test-test-generation"',
    root,
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM7Settings({
      user: { scope: "user", values: userValues },
      workspace: { scope: "workspace", values: workspaceValues },
    }),
    eventSequence: 1,
  };
}

function editorSettingsControl(
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>,
): { readonly read: (realRoot: string) => Promise<EditorM7SettingsSnapshot> } {
  return { read: () => Promise.resolve(editorSettingsSnapshot(values)) };
}

function fileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    root,
    target: {
      kind: "file",
      document: { path: "src/a.ts", languageId: "typescript", text: "export const a = 1;\n" },
    },
    contextBudgetBytes: 4_096,
    ...overrides,
  };
}

function editorSnapshot(): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "editor-session-1",
    windowId: "window-1",
    workspaceRoot: root,
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1_000,
  };
}

const ENABLED = { KEIKO_EDITOR_TEST_GENERATION: "on" };
const EXECUTION = {
  KEIKO_EDITOR_TEST_GENERATION: "on",
  KEIKO_EDITOR_TEST_GENERATION_EXECUTION: "on",
};

function wire(result: { status: number; body: unknown }): EditorTestGenerationWireResponse {
  return result.body as EditorTestGenerationWireResponse;
}

const candidateRunner: TestGenerationRunner = () =>
  Promise.resolve({
    patch: {
      patchId: "p1",
      files: [
        {
          path: "src/a.test.ts",
          changeKind: "added",
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "it('adds', () => {});\n",
            },
          ],
        },
      ],
    },
    provenance: { modelId: "m", gatewayPolicyVersion: "v", promptHash: "h", producedAt: 1 },
    funnel: {
      executionEnabled: false,
      candidatesGenerated: 1,
      candidatesSurfaced: 1,
      stabilityRunsRequired: 5,
      build: "not-run",
      pass: "not-run",
      stability: "not-run",
      coverage: "not-run",
      mutation: "not-run",
      antiTautology: "not-run",
    },
    verification: "vitest",
    proposedDiff: "--- /dev/null\n+++ b/src/a.test.ts\n@@ -0,0 +1,1 @@\n+it('adds', () => {});\n",
  });

const playwrightCandidateRunner: TestGenerationRunner = async (args) => {
  const candidate = await candidateRunner(args);
  return candidate === undefined ? undefined : { ...candidate, verification: "playwright" };
};

const unsupportedCandidateRunner: TestGenerationRunner = async (args) => {
  const candidate = await candidateRunner(args);
  if (candidate === undefined) {
    return undefined;
  }
  const { verification: _verification, ...rest } = candidate;
  void _verification;
  return {
    ...rest,
    unsupportedVerificationReason:
      "The generated candidate uses a test runner that is not supported by the assured pre-filter.",
  };
};

const PASSED_FUNNEL: EditorTestGenerationFunnel = {
  executionEnabled: true,
  candidatesGenerated: 1,
  candidatesSurfaced: 1,
  stabilityRunsRequired: 5,
  build: "passed",
  pass: "passed",
  stability: "passed",
  coverage: "passed",
  mutation: "passed",
  antiTautology: "passed",
  coverageLineDelta: 4,
  coverageBranchDelta: 1,
  mutantsKilled: 3,
  mutantsTotal: 4,
};

// A pre-filter that surfaces the candidate as assured (all gates passed).
const assuredPreFilter: AssuredPreFilterPort = () =>
  Promise.resolve({ funnel: PASSED_FUNNEL, assurance: "assured", surfaced: true });

// A pre-filter that rejects the candidate (e.g. coverage did not increase) → untrusted evidence only.
const rejectingPreFilter: AssuredPreFilterPort = () =>
  Promise.resolve({
    funnel: {
      ...PASSED_FUNNEL,
      candidatesSurfaced: 0,
      coverage: "failed",
      mutation: "not-run",
      antiTautology: "not-run",
      coverageLineDelta: 0,
      coverageBranchDelta: 0,
      mutantsKilled: undefined,
      mutantsTotal: undefined,
    },
    assurance: "unverified",
    surfaced: false,
    rejectionReason: "The generated candidate does not increase coverage.",
  });

function execOptions(
  runner: TestGenerationRunner = candidateRunner,
  preFilter: AssuredPreFilterPort = assuredPreFilter,
): EditorTestGenerationRouteOptions {
  return { runner, preFilter, now: () => 1_000 };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-testgen-route-")));
  await mkdir(join(root, "src"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  editorAgentRegistry.reset();
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("test-generation policy gates", () => {
  it("disables the feature by default and enables only on an explicit token", () => {
    expect(isTestGenerationEnabledByPolicy(undefined)).toBe(false);
    expect(isTestGenerationEnabledByPolicy({})).toBe(false);
    expect(isTestGenerationEnabledByPolicy(ENABLED)).toBe(true);
  });

  it("gates execution behind BOTH the feature flag and the execution flag", () => {
    expect(isTestGenerationExecutionEnabledByPolicy(ENABLED)).toBe(false);
    expect(
      isTestGenerationExecutionEnabledByPolicy({ KEIKO_EDITOR_TEST_GENERATION_EXECUTION: "on" }),
    ).toBe(false);
    expect(isTestGenerationExecutionEnabledByPolicy(EXECUTION)).toBe(true);
  });
});

describe("POST /api/editor/test-generation — switched off (v1 default)", () => {
  it("returns `disabled` with no retrieval, model, or context when the flag is off", async () => {
    const result = await handleEditorTestGeneration(postContext(fileBody()), deps());
    expect(result.status).toBe(200);
    const body = wire(result);
    expect(body.status).toBe("disabled");
    expect(body.context).toBeUndefined();
    expect(body.patch).toBeUndefined();
    expect(body.funnel.executionEnabled).toBe(false);
  });

  it("does not parse the editor buffer when the feature is disabled", async () => {
    const result = await handleEditorTestGeneration(rawPostContext("{not-json"), deps());
    expect(result.status).toBe(200);
    expect(wire(result).status).toBe("disabled");
  });

  it("rejects a malformed request with 400", async () => {
    const result = await handleEditorTestGeneration(postContext({ root }), deps({ env: ENABLED }));
    expect(result.status).toBe(400);
  });

  it("rejects a target document path that escapes the workspace", async () => {
    const result = await handleEditorTestGeneration(
      postContext(
        fileBody({
          target: {
            kind: "file",
            document: { path: "../escape.ts", languageId: "typescript", text: "x" },
          },
        }),
      ),
      deps({ env: ENABLED }),
    );
    // A non-relative path is rejected at the shape check (400); a contained symlink escape would 403.
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("keeps legacy env enablement as a ceiling until workspace activation explicitly opts in", async () => {
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: ENABLED, aiSettings: { testGeneration: false } }),
    );
    expect(result.status).toBe(200);
    const response = wire(result);
    expect(response.status).toBe("disabled");
    expect(response.context).toBeUndefined();
    expect(response.patch).toBeUndefined();
  });

  // F-01: opting in and enabling the flag are operator decisions; neither is evidence that the
  // gateway answers. A failed readiness probe therefore keeps the feature disabled, and an
  // unprobed gateway does too — the projection reports PROVIDER_UNVERIFIED rather than active.
  it("stays disabled when the gateway has no passing probe outcome", async () => {
    for (const gatewayVerification of ["failed", "unverified"] as const) {
      const result = await handleEditorTestGeneration(
        postContext(fileBody()),
        deps({ env: ENABLED, gatewayVerification }),
      );
      expect(result.status).toBe(200);
      const response = wire(result);
      expect(response.status).toBe("disabled");
      expect(response.patch).toBeUndefined();
    }
  });
});

describe("POST /api/editor/test-generation — enabled, egress not enforced (deferred)", () => {
  it("runs governed #1211 discovery for provenance but makes NO model call", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: ENABLED, evidenceStore }),
    );
    expect(result.status).toBe(200);
    const body = wire(result);
    expect(body.status).toBe("deferred");
    expect(body.patch).toBeUndefined();
    // Reuse of the governed retrieval substrate (#1211) is proven by the content-free context pack.
    expect(body.context?.purpose).toBe("test-generation");
    expect(body.funnel.executionEnabled).toBe(false);
  });

  it("threads a same-root editor session into the existing context collector", async () => {
    editorAgentRegistry.registerSnapshot(editorSnapshot());
    editorAgentRegistry.connect("editor-session-1", () => undefined);
    const result = await handleEditorTestGeneration(
      postContext(fileBody({ editorSessionId: "editor-session-1" })),
      deps({ env: ENABLED }),
    );
    expect(result.status).toBe(200);
    expect(wire(result).context?.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceKind: "editor-state" })]),
    );
  });

  it("omits embedding-backed providers while deferred before the egress boundary", async () => {
    const result = await handleEditorTestGeneration(
      postContext(fileBody({ context: { queryText: "edge cases", capsuleId: "cap-1" } })),
      deps({ env: ENABLED }),
    );
    expect(result.status).toBe(200);
    const omissions = new Map(
      wire(result).context?.omissions.map((omission) => [omission.sourceKind, omission.reason]),
    );
    expect(omissions.get("local-knowledge")).toBe("too-expensive");
    expect(omissions.get("memory")).toBe("too-expensive");
  });
});

describe("POST /api/editor/test-generation — execution enabled (wave-2 seam)", () => {
  it("surfaces an assured, apply-ready candidate when the assured pre-filter passes", async () => {
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: EXECUTION }),
      execOptions(),
    );
    const body = wire(result);
    expect(body.status).toBe("generated");
    expect(body.assurance).toBe("assured");
    expect(body.funnel.coverage).toBe("passed");
    expect(body.funnel.mutation).toBe("passed");
    expect(body.patch?.files[0]?.path).toBe("src/a.test.ts");
    expect(body.context?.purpose).toBe("test-generation");
  });

  it("discards the outcome if activation is revoked while the generation call is in flight", async () => {
    let reads = 0;
    const revokingDeps = {
      ...deps({ env: EXECUTION }),
      editorSettingsControl: {
        read: () => {
          reads += 1;
          return Promise.resolve(editorSettingsSnapshot({ testGeneration: reads === 1 }));
        },
      },
    } as unknown as UiHandlerDeps;
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      revokingDeps,
      execOptions(),
    );
    const body = wire(result);
    expect(body.status).toBe("disabled");
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("forwards Playwright verification to the assured pre-filter", async () => {
    let verification: unknown;
    const preFilter: AssuredPreFilterPort = (args) => {
      verification = args.verification;
      return assuredPreFilter(args);
    };
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: EXECUTION }),
      execOptions(playwrightCandidateRunner, preFilter),
    );
    expect(wire(result).status).toBe("generated");
    expect(verification).toBe("playwright");
  });

  it("surfaces a rejected candidate as unverified with a reason (untrusted evidence only)", async () => {
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: EXECUTION }),
      execOptions(candidateRunner, rejectingPreFilter),
    );
    const body = wire(result);
    expect(body.status).toBe("generated");
    expect(body.assurance).toBe("unverified");
    expect(body.funnel.coverage).toBe("failed");
    expect(body.reason).toContain("coverage");
    // The patch is still returned for review, but it is not apply-ready.
    expect(body.patch?.files[0]?.path).toBe("src/a.test.ts");
  });

  it("surfaces unsupported verification candidates as unverified without running the pre-filter", async () => {
    let called = false;
    const preFilter: AssuredPreFilterPort = () => {
      called = true;
      return Promise.resolve({ funnel: PASSED_FUNNEL, assurance: "assured", surfaced: true });
    };
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: EXECUTION }),
      execOptions(unsupportedCandidateRunner, preFilter),
    );
    const body = wire(result);
    expect(called).toBe(false);
    expect(body.status).toBe("generated");
    expect(body.assurance).toBe("unverified");
    expect(body.reason).toContain("not supported by the assured pre-filter");
    expect(body.patch?.files[0]?.path).toBe("src/a.test.ts");
  });

  it("falls back to `deferred` when the runner produces no candidate", async () => {
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: EXECUTION }),
      execOptions(() => Promise.resolve(undefined)),
    );
    expect(wire(result).status).toBe("deferred");
  });

  it("maps a runner failure to a content-free `failed` outcome (editor stays usable)", async () => {
    const result = await handleEditorTestGeneration(
      postContext(fileBody()),
      deps({ env: EXECUTION }),
      execOptions(() => Promise.reject(new Error("/secret/path leaked"))),
    );
    const body = wire(result);
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("/secret/path");
  });

  // 0.3.0 audit: `failed` is also what an unproducible candidate yields, so a swallowed runner error
  // left an operator with no way to tell an outage from a decline. The wire body stays content-free;
  // only the redacted cause is added.
  it("emits a redacted, correlation-keyed diagnostic when the runner throws", async () => {
    const captured = capturingDiagnostics();
    const ctx: RouteContext = {
      ...postContext(fileBody()),
      correlationId: "testgen-correlation-0001",
    };
    const result = await handleEditorTestGeneration(
      ctx,
      deps({ env: EXECUTION, diagnostics: captured.sink }),
      execOptions(() =>
        Promise.reject(
          Object.assign(new Error("/secret/path leaked sk-ABCDEFGHIJKLMNOPQRSTUV"), {
            code: "RUNNER_UNAVAILABLE",
          }),
        ),
      ),
    );

    expect(wire(result).status).toBe("failed");
    expect(captured.records).toHaveLength(1);
    const record = captured.records[0];
    expect(record?.correlationId).toBe("testgen-correlation-0001");
    expect(record?.operation).toBe("editor.testGeneration");
    expect(record?.source).toBe("editor.testGenerationRoutes");
    expect(record?.code).toBe("RUNNER_UNAVAILABLE");
    expect(JSON.stringify(record)).not.toContain("/secret/path");
    expect(JSON.stringify(record)).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
  });
});
