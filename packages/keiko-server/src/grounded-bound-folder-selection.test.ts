import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type ContextExcerpt,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  parseGatewayConfig,
  type RerankOutcome,
  type LiteLLMRerankRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { buildRedactor, createRunRegistry } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { rerankAndSelect, withModelRerankScore, type RerankInput } from "./grounded-rerank.js";
import { rerankSelection } from "./grounded-rerank-facade.js";
import {
  buildAnswerCitations,
  fittedGroundedGatewayPrompt,
  withPromptExcerptBudget,
  modelInputPromptByteLimit,
  promptByteLength,
} from "./grounded-qa.js";
import { fittedMultiSourcePrompt } from "./grounded-qa-multi-source.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const stores: UiStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  resetServerLogger();
});

function candidate(index: number, required = false, text = "ordinary"): RerankInput<string> {
  return {
    kind: "folder",
    redactedText: text,
    engineScore: 100 - index,
    sourceLabel: "folder",
    tieKey: String(index),
    payload: String(index),
    ...(required ? { continuityReferenceKey: `source:window:${String(index)}` } : {}),
  };
}

function depsFor(requests: LiteLLMRerankRequest[], configured = true): UiHandlerDeps {
  const config = parseGatewayConfig({
    providers: [
      { modelId: "fixture-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" },
    ],
    ...(configured
      ? {
          reranker: {
            modelId: "fixture-reranker",
            baseUrl: "https://fixture.invalid/v1",
            apiKey: "fixture",
          },
        }
      : {}),
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  return {
    config,
    configPresent: true,
    env: {},
    redactor: buildRedactor({}, config),
    store,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    rerankRequest: (request): Promise<RerankOutcome> => {
      requests.push(request);
      return Promise.resolve({
        ok: true,
        value: {
          modelId: "fixture-reranker",
          results: [{ index: 0, relevanceScore: 0.9 }, { index: 1 }],
        },
      });
    },
  };
}

function excerpt(id: string, line: number, score: number, content: string): ContextExcerpt {
  return {
    atom: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: id,
      scopePath: "src/Novel.ts",
      lineRange: { startLine: line, endLine: line },
      score,
      provenance: { kind: "excerpt-read", tool: "repo.readFile", queryFingerprint: "query" },
      redactionState: "redacted",
      emittedAtMs: 1,
      ledgerRef: undefined,
    },
    content,
    contentBytes: Buffer.byteLength(content),
  };
}

const BASE_PACK: ConnectedContextPack = {
  schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
  stableId: "pack",
  scope: {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope",
    workspaceRoot: "/fixture",
    kind: "workspace-root",
    relativePaths: [],
    conversationId: "chat",
    connectedAtMs: 1,
  },
  query: {
    kind: "natural-language",
    text: "Explain that.",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1,
  },
  budget: { ...DEFAULT_EXPLORATION_BUDGET, modelInputTokensMax: 32768 },
  usage: {
    searchCalls: 1,
    filesRead: 1,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 1,
    rerankCalls: 0,
  },
  files: [],
  omitted: [],
  uncertainty: [],
  emittedAtMs: 1,
  ledgerRef: undefined,
};

function pack(excerpts: readonly ContextExcerpt[]): ConnectedContextPack {
  return {
    ...BASE_PACK,
    files: [
      {
        scopePath: "src/Novel.ts",
        role: "read-only",
        selectionReason: "ranked",
        excerpts,
      },
    ],
  };
}

const REQUIRED = excerpt("late-window", 61, 0.1, "export const currentValue = 83;");
const EARLY = excerpt("early-window", 1, 0.9, "early material ".repeat(200));
const redactor = buildRedactor({});

function minimumInputBudget(
  messages: Parameters<typeof countGatewayPromptTokens>[0]["messages"],
): number {
  let tokens = countGatewayPromptTokens({ messages });
  while (modelInputPromptByteLimit(tokens) < promptByteLength(messages)) tokens += 1;
  return tokens;
}

describe("bound folder windows at existing shared selection fences", () => {
  it.each(["count", "bytes"] as const)(
    "retains the read hint at the provisional %s limit without changing native rank",
    (limit) => {
      const inputs = [candidate(0), candidate(1), candidate(2, true)];
      const full = rerankAndSelect(inputs, { maxCandidates: 100, maxExcerptBytes: 4096 });
      const selected = rerankAndSelect(inputs, {
        maxCandidates: limit === "count" ? 1 : 100,
        maxExcerptBytes: limit === "bytes" ? Buffer.byteLength("ordinary") : 4096,
      });
      expect(selected).toHaveLength(1);
      expect(selected[0]?.payload).toBe("2");
      expect(selected[0]?.engineRank).toBe(full.find((item) => item.payload === "2")?.engineRank);
      expect(selected[0]?.fusedScore).toBe(full.find((item) => item.payload === "2")?.fusedScore);
      expect(selected[0]?.marker).toBe(1);
    },
  );

  it("does not let an oversized required window bypass the provisional byte limit", () => {
    const inputs = [candidate(0), candidate(1, true, "oversized".repeat(100))];
    const selected = rerankAndSelect(inputs, { maxCandidates: 2, maxExcerptBytes: 16 });
    expect(selected.map((item) => item.payload)).toEqual(["0"]);
    expect(selected.reduce((sum, item) => sum + item.bytes, 0)).toBeLessThanOrEqual(16);
  });

  it("keeps the complete provisional provider batch before retaining the actual hint at topN", async () => {
    const candidates = rerankAndSelect([candidate(0), candidate(1), candidate(2)], {
      maxCandidates: 3,
      maxExcerptBytes: 4096,
    });
    const required = candidates[2];
    if (required === undefined) throw new TypeError("Required candidate unavailable");
    const annotated = candidates.map((item) =>
      item === required ? { ...item, continuityReferenceKey: "source:window:2" } : item,
    );
    const requests: LiteLLMRerankRequest[] = [];
    const result = await rerankSelection({
      deps: depsFor(requests),
      query: "Explain that.",
      candidates: annotated,
      documentFor: (item) => item.redactedText,
      topN: 2,
      fallbackMode: "slice-topN",
      requiredCandidateKey: (item) => item.continuityReferenceKey,
      applyScore: withModelRerankScore,
    });
    expect(requests[0]?.documents).toEqual(annotated.map((item) => item.redactedText));
    expect(result.selected.map((item) => item.payload)).toEqual(["2", "0"]);
    expect(result.selected[1]?.rerankerScore).toBe(0.9);
    expect(result.diagnostics).toMatchObject({ candidateCount: 3, documentCount: 3, keptCount: 2 });
  });

  it("honors topN below the number of retained hints and preserves the no-hint fallback", async () => {
    const candidates = rerankAndSelect([candidate(0, true), candidate(1, true)], {
      maxCandidates: 2,
      maxExcerptBytes: 4096,
    });
    const input = {
      deps: depsFor([], false),
      query: "Explain that.",
      candidates,
      documentFor: (item: (typeof candidates)[number]): string => item.redactedText,
      topN: 1,
      fallbackMode: "slice-topN" as const,
      requiredCandidateKey: (item: (typeof candidates)[number]): string | undefined =>
        item.continuityReferenceKey,
    };
    expect((await rerankSelection(input)).selected).toHaveLength(1);
    expect((await rerankSelection({ ...input, topN: 0 })).selected).toEqual([]);
    const ordinary = rerankAndSelect([candidate(0), candidate(1)], {
      maxCandidates: 2,
      maxExcerptBytes: 4096,
    });
    expect((await rerankSelection({ ...input, candidates: ordinary })).selected).toEqual([
      ordinary[0],
    ]);
  });

  it("retains the actual late window at the single-folder model fit without authenticating trimmed lines", () => {
    const minimum = fittedGroundedGatewayPrompt("Explain that.", pack([REQUIRED]), redactor);
    const options = {
      modelInputTokensMax: minimumInputBudget(minimum.messages),
      requiredEvidenceAtomIds: [REQUIRED.atom.stableId],
    };
    const fitted = fittedGroundedGatewayPrompt(
      "Explain that.",
      pack([EARLY, REQUIRED]),
      redactor,
      options,
    );
    expect(fitted.messages.at(-1)?.content).toContain(REQUIRED.content);
    expect(countGatewayPromptTokens({ messages: fitted.messages })).toBeLessThanOrEqual(
      options.modelInputTokensMax,
    );
    const trimmed = withPromptExcerptBudget(
      pack([
        {
          ...REQUIRED,
          atom: { ...REQUIRED.atom, lineRange: { startLine: 60, endLine: 61 } },
          content: "first\nsecond",
        },
      ]),
      2,
      undefined,
      [REQUIRED.atom.stableId],
    );
    expect(buildAnswerCitations(trimmed, "[src/Novel.ts:61]", (value) => value)).toEqual([]);
  });

  it("uses the same actual-window priority under the unchanged plural source byte share", () => {
    const minimum = fittedMultiSourcePrompt(
      "Explain that.",
      [
        {
          label: "folder",
          pack: pack([
            REQUIRED,
            {
              ...EARLY,
              content: "ordinary header",
              contentBytes: Buffer.byteLength("ordinary header"),
            },
          ]),
        },
      ],
      redactor,
    );
    const modelInputTokensMax = minimumInputBudget(minimum.messages);
    const labeled = [
      {
        label: "folder",
        pack: pack([EARLY, REQUIRED]),
        requiredEvidenceAtomIds: [REQUIRED.atom.stableId],
      },
    ];
    const fitted = fittedMultiSourcePrompt("Explain that.", labeled, redactor, {
      modelInputTokensMax,
    });
    expect(fitted.messages.at(-1)?.content).toContain(REQUIRED.content);
    expect(fitted.packs[0]?.pack.files[0]?.excerpts[0]?.atom.lineRange).toEqual(
      REQUIRED.atom.lineRange,
    );
    expect(countGatewayPromptTokens({ messages: fitted.messages })).toBeLessThanOrEqual(
      modelInputTokensMax,
    );
  });
});
