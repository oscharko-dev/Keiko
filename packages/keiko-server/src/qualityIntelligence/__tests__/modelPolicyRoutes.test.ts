import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGatewayConfig, type ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import type { RouteContext } from "../../routes.js";
import {
  buildQiModelRouting,
  buildQiModelRoutingForRun,
  handleGetQiModelPolicy,
  handlePreflightQiModelPolicy,
  handlePutQiModelPolicy,
  QiModelPolicyError,
  resolveQiPolicyPath,
} from "../modelPolicyRoutes.js";

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function capability(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsResponseFormat: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
    ...overrides,
  };
}

function depsWith(args: {
  readonly evidenceDir: string;
  readonly capabilities: readonly ModelCapability[];
}): UiHandlerDeps {
  const config = parseGatewayConfig(
    {
      providers: args.capabilities.map((model) => ({
        modelId: model.id,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret-key",
        capability: model,
      })),
    },
    {},
  );
  return {
    config,
    configPresent: true,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    evidenceDir: args.evidenceDir,
  };
}

function reqFromJson(body: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
}

function reqFromText(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
}

function ctx(req: IncomingMessage = reqFromJson({})): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/quality-intelligence/model-policy"),
  };
}

const VALID_PREFLIGHT_JUDGE_JSON = JSON.stringify({
  dimensions: [
    { name: "verifiability", score: 80, rationale: "klar beobachtbar" },
    { name: "atomicity", score: 80, rationale: "ein Prüfziel" },
    { name: "determinism", score: 80, rationale: "stabil" },
    { name: "ac-fidelity", score: 80, rationale: "passt zur Quelle" },
  ],
  overallRationale: "valider Preflight",
});

function stubSuccessfulPreflight(fetchCalls: string[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      fetchCalls.push(body);
      const content = body.includes("response_format") ? VALID_PREFLIGHT_JUDGE_JSON : "ok";
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

describe("QI model-policy routes", () => {
  let tempDir: string;
  let evidenceDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keiko-qi-policy-"));
    evidenceDir = join(tempDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("repairs a stale stored policy on GET and returns only browser-safe model metadata", () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [capability("current-json", { supportsResponseFormat: true })],
    });
    const policyPath = resolveQiPolicyPath(evidenceDir);
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(
      policyPath,
      JSON.stringify({
        policyVersion: 1,
        testDesignModelId: "removed-generation",
        judgeModelId: "removed-judge",
      }),
      "utf8",
    );

    const result = handleGetQiModelPolicy(ctx(), deps);

    expect(result.status).toBe(200);
    const body = result.body as {
      readonly policy: Record<string, unknown>;
      readonly models: readonly Record<string, unknown>[];
      readonly repaired: boolean;
    };
    expect(body.repaired).toBe(true);
    expect(body.policy).toMatchObject({
      policyVersion: 1,
      testDesignModelId: "current-json",
      judgeModelId: "current-json",
    });
    expect(JSON.stringify(body.models)).not.toContain("provider.invalid");
    expect(JSON.stringify(body.models)).not.toContain("secret-key");
    expect(JSON.parse(readFileSync(policyPath, "utf8"))).toMatchObject(body.policy);
  });

  it("rejects a judge model that lacks structured output", async () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [capability("chat-only", { structuredOutput: false })],
    });

    const result = await handlePutQiModelPolicy(
      ctx(
        reqFromJson({
          modelPolicy: {
            policyVersion: 1,
            testDesignModelId: "chat-only",
            judgeModelId: "chat-only",
          },
        }),
      ),
      deps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "QI_BAD_MODEL_POLICY",
        message: "The selected Quality Intelligence model policy is invalid.",
      },
    });
  });

  it("rejects writes when the evidence directory is not configured", async () => {
    const deps = {
      ...depsWith({
        evidenceDir,
        capabilities: [capability("judge-json", { structuredOutput: true })],
      }),
      evidenceDir: undefined,
    };

    const result = await handlePutQiModelPolicy(
      ctx(
        reqFromJson({
          modelPolicy: {
            policyVersion: 1,
            testDesignModelId: "judge-json",
            judgeModelId: "judge-json",
          },
        }),
      ),
      deps,
    );

    expect(result).toEqual({
      status: 500,
      body: {
        error: {
          code: "QI_NO_EVIDENCE_DIR",
          message: "The evidence directory is not configured.",
        },
      },
    });
  });

  it("maps malformed PUT bodies to safe bad-policy responses", async () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [capability("judge-json", { structuredOutput: true })],
    });

    await expect(handlePutQiModelPolicy(ctx(reqFromText("{")), deps)).resolves.toEqual({
      status: 400,
      body: { error: { code: "QI_BAD_MODEL_POLICY", message: "Body is not valid JSON." } },
    });
    await expect(handlePutQiModelPolicy(ctx(reqFromText("[]")), deps)).resolves.toEqual({
      status: 400,
      body: { error: { code: "QI_BAD_MODEL_POLICY", message: "Body must be JSON." } },
    });
    await expect(
      handlePutQiModelPolicy(ctx(reqFromText("x".repeat(64 * 1024 + 1))), deps),
    ).resolves.toEqual({
      status: 413,
      body: { error: { code: "QI_BAD_MODEL_POLICY", message: "Request body is too large." } },
    });
    await expect(
      handlePutQiModelPolicy(ctx(reqFromJson({ modelPolicy: { policyVersion: 2 } })), deps),
    ).resolves.toEqual({
      status: 400,
      body: {
        error: {
          code: "QI_BAD_MODEL_POLICY",
          message: "The Quality Intelligence model policy is malformed.",
        },
      },
    });
  });

  it("persists a valid policy with an updatedAt timestamp", async () => {
    stubSuccessfulPreflight();
    const deps = depsWith({
      evidenceDir,
      capabilities: [
        capability("generate-chat", { structuredOutput: false }),
        capability("judge-json", { structuredOutput: true }),
      ],
    });

    const result = await handlePutQiModelPolicy(
      ctx(
        reqFromJson({
          modelPolicy: {
            policyVersion: 1,
            testDesignModelId: "generate-chat",
            judgeModelId: "judge-json",
          },
        }),
      ),
      deps,
    );

    expect(result.status).toBe(200);
    const stored = JSON.parse(readFileSync(resolveQiPolicyPath(evidenceDir), "utf8")) as {
      readonly testDesignModelId?: string;
      readonly judgeModelId?: string;
      readonly updatedAt?: string;
    };
    expect(stored.testDesignModelId).toBe("generate-chat");
    expect(stored.judgeModelId).toBe("judge-json");
    expect(stored.updatedAt).toEqual(expect.any(String));
  });

  it("does not persist a PUT policy when model preflight fails", async () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [
        capability("generate-chat", { structuredOutput: false }),
        capability("judge-json", { structuredOutput: true }),
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(JSON.stringify({ error: { code: "forbidden", message: "secret-key" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await handlePutQiModelPolicy(
      ctx(
        reqFromJson({
          modelPolicy: {
            policyVersion: 1,
            testDesignModelId: "generate-chat",
            judgeModelId: "judge-json",
          },
        }),
      ),
      deps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "QI_MODEL_PREFLIGHT_FAILED" },
    });
    expect(() => readFileSync(resolveQiPolicyPath(evidenceDir), "utf8")).toThrow();
  });

  it("accepts policy payload aliases and repairs invalid stored JSON without evidenceDir writes", async () => {
    stubSuccessfulPreflight();
    const deps = depsWith({
      evidenceDir,
      capabilities: [
        capability("generate-chat", { structuredOutput: false }),
        capability("judge-json", { structuredOutput: true }),
      ],
    });

    const aliased = await handlePutQiModelPolicy(
      ctx(
        reqFromJson({
          policy: {
            policyVersion: 1,
            testDesignModelId: "generate-chat",
            judgeModelId: "judge-json",
          },
        }),
      ),
      deps,
    );

    expect(aliased.status).toBe(200);
    expect(JSON.parse(readFileSync(resolveQiPolicyPath(evidenceDir), "utf8"))).toMatchObject({
      testDesignModelId: "generate-chat",
      judgeModelId: "judge-json",
    });

    const depsWithoutEvidence = {
      ...depsWith({
        evidenceDir,
        capabilities: [capability("recommended-json", { structuredOutput: true })],
      }),
      evidenceDir: undefined,
    };
    const response = handleGetQiModelPolicy(ctx(), depsWithoutEvidence);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      policy: {
        policyVersion: 1,
        testDesignModelId: "recommended-json",
        judgeModelId: "recommended-json",
      },
      repaired: false,
    });
  });

  it("preflights unavailable routing without config and reports malformed model policies", async () => {
    const deps = {
      ...depsWith({ evidenceDir, capabilities: [capability("unused-chat")] }),
      config: undefined,
    };

    const unavailable = await handlePreflightQiModelPolicy(ctx(reqFromJson({})), deps);

    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toMatchObject({
      modelRouting: {
        resolved: { judgeUnavailableReason: "no-compatible-model" },
        preflight: {
          status: "unavailable",
          generation: {
            stage: "generate",
            status: "unavailable",
            category: "unavailable",
          },
          judge: {
            stage: "judge",
            status: "unavailable",
            category: "unavailable",
          },
        },
      },
    });

    await expect(
      handlePreflightQiModelPolicy(ctx(reqFromJson({ modelPolicy: { policyVersion: 2 } })), deps),
    ).resolves.toMatchObject({
      status: 400,
      body: {
        error: {
          code: "QI_BAD_MODEL_POLICY",
          message: "The Quality Intelligence model policy is malformed.",
        },
      },
    });
  });

  it("preflights configured models through the gateway without leaking provider details", async () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [
        capability("generate-chat", { structuredOutput: false }),
        capability("judge-json", { supportsResponseFormat: true, structuredOutput: true }),
      ],
    });
    const fetchCalls: string[] = [];
    stubSuccessfulPreflight(fetchCalls);

    const result = await handlePreflightQiModelPolicy(
      ctx(
        reqFromJson({
          modelPolicy: {
            policyVersion: 1,
            testDesignModelId: "generate-chat",
            judgeModelId: "judge-json",
          },
        }),
      ),
      deps,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      modelRouting: {
        preflight: {
          status: "passed",
          generation: { stage: "generate", modelId: "generate-chat", status: "passed" },
          judge: { stage: "judge", modelId: "judge-json", status: "passed" },
        },
      },
    });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).not.toContain("response_format");
    expect(fetchCalls[1]).toContain("response_format");
    expect(fetchCalls[1]).toContain("Du bist ein test-quality judge");
    expect(fetchCalls[1]).toContain("Pflichtfeld Betrag");
    expect(fetchCalls[1]).toContain("quality_intelligence_test_quality_judge");
    expect(JSON.stringify(result.body)).not.toContain("provider.invalid");
    expect(JSON.stringify(result.body)).not.toContain("secret-key");
  });

  it("fails judge preflight when the provider returns only the old ok schema", async () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [
        capability("generate-chat", { structuredOutput: false }),
        capability("judge-json", { supportsResponseFormat: true, structuredOutput: true }),
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : "";
        const content = body.includes("response_format") ? JSON.stringify({ ok: true }) : "ok";
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await handlePreflightQiModelPolicy(
      ctx(
        reqFromJson({
          modelPolicy: {
            policyVersion: 1,
            testDesignModelId: "generate-chat",
            judgeModelId: "judge-json",
          },
        }),
      ),
      deps,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      modelRouting: {
        preflight: {
          status: "failed",
          judge: { status: "failed", category: "schema" },
        },
      },
    });
  });

  it("classifies gateway preflight failures into safe categories", async () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [
        capability("generate-chat", { structuredOutput: false }),
        capability("judge-json", { structuredOutput: true }),
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: "unauthorized",
                message: "raw provider credential failure carrying secret-key",
              },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const result = await handlePreflightQiModelPolicy(
      ctx(
        reqFromJson({
          modelPolicy: {
            policyVersion: 1,
            testDesignModelId: "generate-chat",
            judgeModelId: "judge-json",
          },
        }),
      ),
      deps,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      modelRouting: {
        preflight: {
          status: "failed",
          generation: { status: "failed", category: "auth" },
          judge: { status: "failed", category: "auth" },
        },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("secret-key");
    expect(JSON.stringify(result.body)).not.toContain("upstream");
  });

  it("rejects incompatible explicit policies before preflight and fails runs on unavailable models", async () => {
    const deps = depsWith({
      evidenceDir,
      capabilities: [capability("embed-only", { kind: "embedding", workflowEligible: false })],
    });

    await expect(
      buildQiModelRouting(deps, {
        modelPolicy: {
          policyVersion: 1,
          testDesignModelId: "embed-only",
          judgeModelId: "embed-only",
        },
      }),
    ).rejects.toMatchObject({
      code: "QI_BAD_MODEL_POLICY",
      message: "The selected Quality Intelligence model policy is invalid.",
    });

    const failingDeps = depsWith({
      evidenceDir,
      capabilities: [capability("generate-chat", { structuredOutput: true })],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(JSON.stringify({ error: { code: "forbidden" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      buildQiModelRoutingForRun(failingDeps, {
        modelPolicy: {
          policyVersion: 1,
          testDesignModelId: "generate-chat",
          judgeModelId: "generate-chat",
        },
      }),
    ).rejects.toBeInstanceOf(QiModelPolicyError);
    await expect(
      buildQiModelRoutingForRun(failingDeps, {
        modelPolicy: {
          policyVersion: 1,
          testDesignModelId: "generate-chat",
          judgeModelId: "generate-chat",
        },
      }),
    ).rejects.toMatchObject({
      code: "QI_MODEL_PREFLIGHT_FAILED",
    });
  });
});
