import { createHash } from "node:crypto";

import type { GatewayConfig, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import { buildRedactor, type UiHandlerDeps } from "../../deps.js";
import { createInMemoryUiStore } from "../../store/index.js";
import type { VerificationRunnerManager } from "../../editor/verificationRunner.js";
import type { CodingRuntimeControlPlane } from "../codingRuntimeControlPlane.js";
import type {
  FunctionalPortableOpenCodeRuntime,
  ProductionOpenCodeFunctionalHarness,
} from "../productionOpenCodeRuntimeResolver.js";
import { createFunctionalSupervisor } from "../opencodeFunctionalHarness/_support.js";

export interface ScriptState {
  mode: "productive" | "out-of-scope";
  calls: number;
  readonly old: string;
  readonly next: string;
}

export function functionalHarness(
  portable: FunctionalPortableOpenCodeRuntime,
): ProductionOpenCodeFunctionalHarness {
  return {
    evidenceClass: "functional-not-platform-qualified" as const,
    portable,
    createSupervisor: () => createFunctionalSupervisor(portable),
  };
}

export function bffDeps(
  control: CodingRuntimeControlPlane,
  verification: Pick<VerificationRunnerManager, "runToReport"> & {
    readonly evidence: UiHandlerDeps["evidenceStore"];
  },
  script: ScriptState,
): UiHandlerDeps {
  const config = gatewayConfig();
  const chat = (): Promise<NormalizedResponse> => Promise.resolve(scriptedResponse(script));
  return {
    config,
    configPresent: true,
    env: {},
    redactor: buildRedactor({}, config),
    registry: { get: () => undefined },
    store: createInMemoryUiStore(),
    evidenceStore: verification.evidence,
    modelPortFactory: () => undefined,
    codingSidecarGatewayChatFactory: () => chat,
    codingSidecarGatewayChatStreamFactory: () =>
      async function* () {
        yield { type: "done" as const, response: await chat() };
      },
    codingRuntimeOrchestrator: control.orchestrator,
    codingRuntimeEventHub: control.eventHub,
    codingRuntimeQuestionPort: control.questionPort,
    codingRuntimeHostQualified: true,
    runtimeCapabilityAuthenticator: control.runtimeCapabilityAuthenticator,
    openCodeGatewayReadinessRegistry: control.openCodeGatewayReadinessRegistry,
  } as unknown as UiHandlerDeps;
}

function scriptedResponse(script: ScriptState): NormalizedResponse {
  const step = script.calls++;
  if (script.mode === "out-of-scope") {
    return step === 0
      ? tool("keiko_changeset_edit", {
          changeset: {
            patch:
              "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-OUTSIDE_SECRET_2258\n+owned\n",
            files: [{ file: "../outside.txt", expectedContentHash: "0".repeat(64) }],
          },
        })
      : normal();
  }
  if (step === 0) return tool("keiko_workspace_read", { relativePath: "src/example.ts" });
  if (step === 1) return tool("question", question());
  if (step === 2) return tool("keiko_changeset_edit", edit(script));
  return step === 3 ? tool("keiko_verification", { verifierId: "typecheck" }) : normal();
}

function question(): Record<string, unknown> {
  return {
    questions: [
      {
        question: "Approve?",
        header: "Approval",
        options: [{ label: "Approve", description: "Continue" }],
      },
    ],
  };
}

function edit(script: ScriptState): Record<string, unknown> {
  return {
    changeset: {
      patch: `--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-${script.old}+${script.next}`,
      files: [{ file: "src/example.ts", expectedContentHash: digest(script.old) }],
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normal(): NormalizedResponse {
  return {
    modelId: "functional-model",
    content: "",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "functional",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      costClass: "low",
    },
  };
}

function tool(
  name: "keiko_workspace_read" | "keiko_changeset_edit" | "keiko_verification" | "question",
  args: Record<string, unknown>,
): NormalizedResponse {
  return {
    ...normal(),
    finishReason: "tool_calls",
    toolCalls: [{ id: `tool-${name}`, name, arguments: args }],
  };
}

function gatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: "functional-model",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "functional-provider-secret",
        apiKeyHeaderName: "api-key",
        endpointStyle: "azure-openai-deployment",
        apiVersion: "2024-06-01",
        timeoutMs: 1_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: "functional-model",
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "low",
        latencyClass: "standard",
        throughputHint: "functional",
        preferredUseCases: ["Coding"],
        knownLimitations: [],
      },
    ],
  };
}
