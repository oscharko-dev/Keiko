import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import type { ChatMessage } from "./store/index.js";
import { probeVerifiedGatewayConfig } from "./_support.js";
import { chatModelSupportsTools, mintAndBoundChatTurn } from "./chat-tool-turn.js";
import {
  ConversationModelNotReadyError,
  mappedConversationReadinessError,
} from "./conversation-readiness-admission.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

const MODEL = "synthetic-tool-readiness";
const CORRELATION = "tool-readiness-proof";
const provider = {
  modelId: MODEL,
  baseUrl: "https://readiness.example.invalid/v1",
  apiKey: "synthetic-unused",
  timeoutMs: 1000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

function depsFor(
  state: "fresh" | "stale" | "unsupported" | "unverified" | "configuration-changed",
): { readonly gatewayConfig: ReturnType<typeof probeVerifiedGatewayConfig> } {
  return {
    gatewayConfig: probeVerifiedGatewayConfig(
      parseGatewayConfig({
        providers: [provider],
        capabilities: [
          {
            ...createDefaultChatCapability(MODEL),
            toolCalling: state !== "unsupported",
            ...(state === "unverified"
              ? {}
              : {
                  toolCallingVerification: {
                    status: "verified",
                    checkedAt: new Date(
                      Date.now() - (state === "stale" ? 25 * 60 * 60 * 1000 : 0),
                    ).toISOString(),
                    probe: "gateway-tool-calling-v1",
                    configurationFingerprint:
                      state === "configuration-changed"
                        ? "a".repeat(64)
                        : toolCallingConfigurationFingerprint(provider),
                  },
                }),
          },
        ],
      }),
    ),
  };
}

const message: ChatMessage = {
  id: "readiness-user-message",
  chatId: "readiness-chat",
  role: "user",
  content: "Create the saved draft.",
  timestamp: 1,
  runId: undefined,
  workflowId: undefined,
  workflowStatus: undefined,
  shortResult: undefined,
  taskType: undefined,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
});
afterEach(() => {
  resetServerLogger();
  vi.useRealTimers();
});

describe("closed tool-readiness admission reasons (#4321 Golden 3)", () => {
  it.each(["stale", "unsupported", "unverified", "configuration-changed"] as const)(
    "refuses %s before minting and retains the cause through the registered formatter",
    (reason) => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const mint = vi.fn(() => {
        throw new TypeError("A refused model must never mint authority");
      });
      let failure: unknown;
      try {
        mintAndBoundChatTurn(depsFor(reason), MODEL, message, CORRELATION, mint, []);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConversationModelNotReadyError);
      expect(failure).toMatchObject({ requiredCapability: "tool-calling", reason });
      expect(mint).not.toHaveBeenCalled();
      const result = mappedConversationReadinessError(failure);
      expect(result).toMatchObject({
        status: 400,
        body: {
          error: {
            code:
              reason === "unsupported"
                ? "CONVERSATION_UNAVAILABLE_MODEL"
                : "CONVERSATION_MODEL_NOT_READY",
          },
        },
      });
      const rendered = JSON.stringify(result);
      expect(rendered).toContain(reason === "unsupported" ? "Choose a model" : "Settings > Models");
      const event = sink.events.find((entry) => entry.op === "gateway.conversation.admission");
      if (event === undefined) throw new TypeError("Missing readiness admission evidence");
      const line = formatActivityLogProofLine(event);
      expect(expectActivityLogProof("gateway.conversation.admission.line", line)).toMatchObject({
        correlationId: CORRELATION,
        reason,
        disposition: "observation-unavailable",
      });
      expect(line).not.toContain(provider.baseUrl);
      expect(line).not.toContain(provider.apiKey);
      expect(line).not.toContain(MODEL);
    },
  );

  it("continues to admit a fresh configuration-bound tool proof", () => {
    expect(chatModelSupportsTools(depsFor("fresh"), MODEL)).toBe(true);
  });
});
