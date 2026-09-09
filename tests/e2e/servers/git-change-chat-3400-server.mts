import { join } from "node:path";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { functionalGatewayConfig } from "../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";
import { runCodingRuntimeJourneyServer } from "./coding-runtime-server-shared.mjs";

const stateDir = process.env.KEIKO_STATE_DIR;
const modelPort = Number(process.env.KEIKO_E2E_MODEL_PORT ?? "32210");
if (stateDir === undefined || stateDir.length === 0) {
  throw new Error("KEIKO_STATE_DIR is required");
}

function messageText(request: GatewayRequest): string {
  return request.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

function descriptionResponse(request: GatewayRequest): NormalizedResponse {
  const text = messageText(request);
  const evidenceId = /"evidenceId":"([a-f0-9]{64})"/u.exec(text)?.[1];
  if (evidenceId === undefined) throw new Error("description evidence id missing");
  const refinement = text.includes("Second connected refinement")
    ? "Second connected refinement is visible in the exact held pull-request body."
    : "First connected refinement is retained for the next Chat turn.";
  return {
    modelId: "functional-model",
    content: JSON.stringify({
      summary: [{ text: refinement, evidenceIds: [evidenceId] }],
      keyChanges: [
        { text: "The connected pull request description was refined.", evidenceIds: [evidenceId] },
      ],
      risks: [],
      reviewerFocus: [],
    }),
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "git-change-chat-3400",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 0,
      costClass: "low",
    },
  };
}

await runCodingRuntimeJourneyServer({
  fixtureId: "git-change-chat-3400",
  fixtureLabel: "Git change Chat 3400",
  runtime: "scripted",
  includeQuestion: false,
  defaultPort: 32_211,
  originalContent: "export const before = true;\n",
  editedContent: "export const after = true;\n",
  targetRelativePath: "src/example.ts",
  stateDir: () => stateDir,
  repositoryRoot: (root) => join(root, "runtime-repository"),
  managedRoot: (root) => join(root, "managed-workspaces"),
  chatResponse: descriptionResponse,
  gatewayConfig: {
    ...functionalGatewayConfig(),
    providers: functionalGatewayConfig().providers.map((provider) => ({
      ...provider,
      baseUrl: `http://127.0.0.1:${String(modelPort)}/v1`,
    })),
  },
});
