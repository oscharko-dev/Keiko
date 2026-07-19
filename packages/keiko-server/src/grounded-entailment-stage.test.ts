// Tests for the grounded entailment STAGE (Issue #2563): policy gating, active flagging, fail-closed
// degradation, and the body-free operator diagnostic. All model calls hit a fake ModelPort.

import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  type ConnectedContextPack,
  type KnowledgeCapsule,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "./deps.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createEntailmentStage } from "./grounded-entailment-stage.js";

const MODEL_ID = "test-chat-model";
const NOW = 1_700_000_000_000;

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function portReturning(content: string | Error): ModelPort {
  return {
    call: (_request: GatewayRequest): Promise<NormalizedResponse> =>
      content instanceof Error
        ? Promise.reject(content)
        : Promise.resolve({
            content,
            modelId: MODEL_ID,
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "req",
              promptTokens: 1,
              completionTokens: 1,
              latencyMs: 1,
              costClass: "medium",
            },
          }),
  };
}

function configWithChatModel(): ReturnType<typeof parseGatewayConfig> {
  const capability: ModelCapability = {
    id: MODEL_ID,
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
  };
  return parseGatewayConfig(
    {
      providers: [
        { modelId: MODEL_ID, baseUrl: "https://fake.example.com/v1", apiKey: "k", capability },
      ],
    },
    {},
  );
}

function depsWith(
  port: ModelPort,
  diagnostics?: (r: ServerDiagnosticRecord) => void,
): UiHandlerDeps {
  return {
    config: configWithChatModel(),
    configPresent: true,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): ModelPort => port,
    store: createInMemoryUiStore(),
    ...(diagnostics === undefined ? {} : { diagnostics: { record: diagnostics } }),
  };
}

function packWithExcerpt(scopePath: string, content: string): ConnectedContextPack {
  return {
    files: [
      {
        scopePath,
        excerpts: [
          {
            atom: { scopePath, lineRange: { startLine: 1, endLine: 8 } },
            content,
            contentBytes: content.length,
          },
        ],
      },
    ],
    uncertainty: [],
  } as unknown as ConnectedContextPack;
}

function denyingCapsule(): KnowledgeCapsule {
  return {
    modelUsePolicy: {
      schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
      mode: "custom",
      operations: {
        externalEmbeddings: "inherit",
        localEmbeddings: "inherit",
        externalReranking: "inherit",
        localReranking: "inherit",
        answerSynthesis: "deny",
        rawContentRelease: "inherit",
        evidencePersistence: "inherit",
      },
    },
  } as unknown as KnowledgeCapsule;
}

describe("createEntailmentStage — inertness", () => {
  it("is inert (undefined) when no compatible judge model is configured", () => {
    const config = configWithChatModel();
    const deps: UiHandlerDeps = { ...depsWith(portReturning("{}")), config };
    expect(createEntailmentStage(deps, [], "unconfigured-model")).toBeUndefined();
  });

  it("is inert (undefined) when a capsule policy denies answerSynthesis", () => {
    const stage = createEntailmentStage(
      depsWith(portReturning('{"verdict":"unsupported"}')),
      [denyingCapsule()],
      MODEL_ID,
    );
    expect(stage).toBeUndefined();
  });
});

describe("createEntailmentStage — active flagging", () => {
  it("flags a claim whose in-pack excerpt does not support it, leaving supported claims clean", async () => {
    const stage = createEntailmentStage(
      depsWith(portReturning('{"verdict":"unsupported"}')),
      [],
      MODEL_ID,
    );
    expect(stage).toBeDefined();
    const markers = await stage?.evaluate(
      "Retention is ten years [src/policy.ts:1-8].",
      [packWithExcerpt("src/policy.ts", "retention: 30 days")],
      NOW,
    );
    expect(markers?.map((m) => m.kind)).toContain("unsupported-claim");
  });

  it("produces no markers when the judge supports the claim (byte-identical uncertainty)", async () => {
    const stage = createEntailmentStage(
      depsWith(portReturning('{"verdict":"supported"}')),
      [],
      MODEL_ID,
    );
    const markers = await stage?.evaluate(
      "Retention is 30 days [src/policy.ts:1-8].",
      [packWithExcerpt("src/policy.ts", "retention: 30 days")],
      NOW,
    );
    expect(markers).toEqual([]);
  });
});

describe("createEntailmentStage — fail-closed degradation", () => {
  it("degrades to a WARN marker + body-free diagnostic when the judge throws", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const deps = depsWith(portReturning(new Error("gateway down")), (r) => records.push(r));
    const stage = createEntailmentStage(deps, [], MODEL_ID, {
      diagnostics: deps.diagnostics,
      correlationId: "corr-123",
    });
    const markers = await stage?.evaluate(
      "Encryption uses AES-256 [src/crypto.ts:1-8].",
      [packWithExcerpt("src/crypto.ts", "cipher configuration")],
      NOW,
    );
    expect(markers?.map((m) => m.kind)).toEqual(["entailment-unavailable"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.correlationId).toBe("corr-123");
    expect(records[0]?.source).toBe("grounded.entailment-stage");
    // Body-free: the diagnostic carries counts/classes only, never claim or excerpt text.
    const serialised = JSON.stringify(records[0]);
    expect(serialised).not.toContain("AES-256");
    expect(serialised).not.toContain("cipher configuration");
  });

  it("never throws and never blocks the answer when the judge is unavailable", async () => {
    const stage = createEntailmentStage(depsWith(portReturning(new Error("boom"))), [], MODEL_ID);
    await expect(
      stage?.evaluate("A [src/a.ts:1-8].", [packWithExcerpt("src/a.ts", "x")], NOW),
    ).resolves.toEqual([expect.objectContaining({ kind: "entailment-unavailable" })]);
  });
});
