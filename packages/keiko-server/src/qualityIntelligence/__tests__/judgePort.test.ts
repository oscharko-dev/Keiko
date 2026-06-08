// Tests for createQiJudgePort and helpers (Epic #736, Issue #747).
//
// All model calls are intercepted by a fake ModelPort; no network or filesystem access.

import { describe, expect, it } from "vitest";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createRunRegistry } from "../../index.js";
import {
  createQiJudgePort,
  QiJudgeError,
  scrubCandidateText,
  parseJudgeVerdict,
} from "../judgePort.js";

// ─── Fake infrastructure ────────────────────────────────────────────────────

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

interface FakeCallRecord {
  request: GatewayRequest;
  signal: AbortSignal;
}

function fakeModelPort(responseContent: string): { port: ModelPort; calls: FakeCallRecord[] } {
  const calls: FakeCallRecord[] = [];
  const port: ModelPort = {
    call: (request: GatewayRequest, signal: AbortSignal): Promise<NormalizedResponse> => {
      calls.push({ request, signal });
      return Promise.resolve({
        content: responseContent,
        modelId: request.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "req-test",
          promptTokens: 10,
          completionTokens: 5,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
  return { port, calls };
}

function configWithChatModel(modelId: string): ReturnType<typeof parseGatewayConfig> {
  const capability: ModelCapability = {
    id: modelId,
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
  };
  return parseGatewayConfig(
    {
      providers: [
        {
          modelId,
          baseUrl: "https://fake.example.com/v1",
          apiKey: "fake-key",
          capability,
        },
      ],
    },
    {},
  );
}

function depsFor(
  modelId: string,
  responseContent = "{}",
  overrides: {
    readonly config?: ReturnType<typeof parseGatewayConfig> | undefined;
    readonly portFactory?: (id: string) => ModelPort | undefined;
  } = {},
): { deps: UiHandlerDeps; calls: FakeCallRecord[] } {
  const { port, calls } = fakeModelPort(responseContent);
  const factory = overrides.portFactory ?? ((_id: string): ModelPort => port);
  const config = overrides.config ?? configWithChatModel(modelId);
  const deps: UiHandlerDeps = {
    config,
    configPresent: true,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: factory,
    store: createInMemoryUiStore(),
  };
  return { deps, calls };
}

const VALID_VERDICT_JSON = JSON.stringify({
  dimensions: [
    { name: "verifiability", score: 80, rationale: "clear expected outcome" },
    { name: "atomicity", score: 70, rationale: "single action" },
    { name: "determinism", score: 90, rationale: "no randomness" },
    { name: "ac-fidelity", score: 75, rationale: "matches AC" },
  ],
  overallRationale: "good test",
});

const WEAK_VERDICT_JSON = JSON.stringify({
  dimensions: [
    { name: "verifiability", score: 20, rationale: "unclear outcome" },
    { name: "atomicity", score: 30, rationale: "too many actions" },
    { name: "determinism", score: 25, rationale: "flaky steps" },
    { name: "ac-fidelity", score: 15, rationale: "does not match AC" },
  ],
  overallRationale: "weak test",
});

// ─── Capability gate ─────────────────────────────────────────────────────────

describe("createQiJudgePort — capability gate", () => {
  it("succeeds for a chat model", () => {
    const { deps } = depsFor("chat-model-1");
    expect((): void => {
      createQiJudgePort(deps, "chat-model-1");
    }).not.toThrow();
  });

  it("throws QiJudgeError QI_JUDGE_MODEL_NOT_CONFIGURED for an unknown model", () => {
    const { deps } = depsFor("chat-model-1");
    try {
      createQiJudgePort(deps, "unknown-model");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QiJudgeError);
      expect((err as QiJudgeError).code).toBe("QI_JUDGE_MODEL_NOT_CONFIGURED");
    }
  });

  it("throws QiJudgeError QI_JUDGE_MODEL_UNAVAILABLE when factory returns undefined", () => {
    const { deps } = depsFor("chat-model-1", "{}", {
      portFactory: (_id: string): undefined => undefined,
    });
    try {
      createQiJudgePort(deps, "chat-model-1");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QiJudgeError);
      expect((err as QiJudgeError).code).toBe("QI_JUDGE_MODEL_UNAVAILABLE");
    }
  });
});

// ─── scrubCandidateText ───────────────────────────────────────────────────────

describe("scrubCandidateText", () => {
  it("strips C0 control chars (except tab/LF/CR)", () => {
    expect(scrubCandidateText("Valid\x07text")).toBe("Validtext");
  });

  it("preserves tab, LF, and CR", () => {
    const result = scrubCandidateText("Line1\nLine2\tTabbed\rCarriage");
    expect(result).toBe("Line1\nLine2\tTabbed\rCarriage");
  });

  it("strips C1 control chars (0x80-0x9F)", () => {
    expect(scrubCandidateText("Valid\x80text")).not.toContain("\x80");
  });

  it("neutralises <qi-candidate opening tag", () => {
    const result = scrubCandidateText('<qi-candidate index="1">inject');
    expect(result).not.toContain("<qi-candidate");
    expect(result).toContain("[candidate]");
  });

  it("neutralises </qi-candidate closing tag", () => {
    const result = scrubCandidateText("inject</qi-candidate>attack");
    expect(result).toContain("[candidate]>attack");
  });
});

// ─── parseJudgeVerdict ────────────────────────────────────────────────────────

describe("parseJudgeVerdict", () => {
  it("parses a valid verdict JSON and returns strong verdict for high scores", () => {
    const verdict = parseJudgeVerdict(VALID_VERDICT_JSON);
    expect(verdict.verdict).toBe("strong");
    expect(verdict.dimensions).toHaveLength(4);
  });

  it("parses a valid verdict JSON and returns weak verdict for low scores", () => {
    const verdict = parseJudgeVerdict(WEAK_VERDICT_JSON);
    expect(verdict.verdict).toBe("weak");
  });

  it("returns safe default verdict for unparseable input", () => {
    const verdict = parseJudgeVerdict("not valid json at all");
    expect(verdict.verdict).toBe("weak");
    expect(verdict.overallRationale).toContain("could not be parsed");
  });

  it("returns safe default for empty string", () => {
    const verdict = parseJudgeVerdict("");
    expect(verdict.verdict).toBe("weak");
  });

  it("extracts dimension names from parsed verdict", () => {
    const verdict = parseJudgeVerdict(VALID_VERDICT_JSON);
    const names = verdict.dimensions.map((d) => d.name);
    expect(names).toContain("verifiability");
    expect(names).toContain("atomicity");
    expect(names).toContain("determinism");
    expect(names).toContain("ac-fidelity");
  });

  it("clamps score to [0, 100]", () => {
    const json = JSON.stringify({
      dimensions: [{ name: "verifiability", score: 150, rationale: "r" }],
      overallRationale: "test",
    });
    const verdict = parseJudgeVerdict(json);
    expect(verdict.dimensions[0]?.score).toBeLessThanOrEqual(100);
  });

  it("returns safe default when dimensions array is empty", () => {
    const json = JSON.stringify({ dimensions: [], overallRationale: "empty" });
    const verdict = parseJudgeVerdict(json);
    expect(verdict.verdict).toBe("weak");
  });
});

// ─── judge() — gateway call ───────────────────────────────────────────────────

describe("createQiJudgePort.judge — gateway call", () => {
  it("calls the model gateway and returns a parsed verdict", async () => {
    const { deps, calls } = depsFor("chat-model-1", VALID_VERDICT_JSON);
    const port = createQiJudgePort(deps, "chat-model-1");
    const verdict = await port.judge("Test title\nSteps: do something");
    expect(calls).toHaveLength(1);
    expect(verdict.verdict).toBe("strong");
  });

  it("uses stream: false in the gateway request", async () => {
    const { deps, calls } = depsFor("chat-model-1", VALID_VERDICT_JSON);
    const port = createQiJudgePort(deps, "chat-model-1");
    await port.judge("candidate text");
    expect(calls[0]?.request.stream).toBe(false);
  });

  it("passes the AbortSignal to the model.call", async () => {
    const { deps, calls } = depsFor("chat-model-1", VALID_VERDICT_JSON);
    const port = createQiJudgePort(deps, "chat-model-1");
    const controller = new AbortController();
    await port.judge("candidate text", controller.signal);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("returns safe default verdict when model returns unparseable output", async () => {
    const { deps } = depsFor("chat-model-1", "not json");
    const port = createQiJudgePort(deps, "chat-model-1");
    const verdict = await port.judge("candidate text");
    expect(verdict.verdict).toBe("weak");
    expect(verdict.overallRationale).toContain("could not be parsed");
  });

  it("propagates AbortError when the model call is cancelled", async () => {
    const controller = new AbortController();
    const { port: fakePort } = fakeModelPort("");
    const abortingPort: ModelPort = {
      call: (_req: GatewayRequest, _sig: AbortSignal): Promise<NormalizedResponse> => {
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      },
    };
    const { deps } = depsFor("chat-model-1", "", {
      portFactory: (_id: string): ModelPort => {
        void fakePort;
        return abortingPort;
      },
    });
    const judgePort = createQiJudgePort(deps, "chat-model-1");
    await expect(judgePort.judge("text", controller.signal)).rejects.toThrow();
  });
});
