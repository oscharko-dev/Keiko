import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGatewayConfig, type ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import type { RouteContext } from "../../routes.js";
import {
  handleGetQiModelPolicy,
  handlePutQiModelPolicy,
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

function ctx(req: IncomingMessage = reqFromJson({})): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/quality-intelligence/model-policy"),
  };
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

  it("persists a valid policy with an updatedAt timestamp", async () => {
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
});
