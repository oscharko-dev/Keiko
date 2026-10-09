import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  createDefaultEmbeddingCapability,
  parseGatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { SemanticSearchProvider } from "@oscharko-dev/keiko-workspace";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createRunRegistry } from "./runs.js";
import type { OrchestratorInput } from "./grounded-orchestrator.js";
import { defaultRetriever } from "./grounded-qa-multi-source.js";
import * as semantic from "./grounded-repo-semantic-search.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const stores: ReturnType<typeof createInMemoryUiStore>[] = [];
let sequence = 0;
afterEach(() => {
  vi.restoreAllMocks();
  resetServerLogger();
  for (const store of stores.splice(0)) store.close();
});

function runtime(): UiHandlerDeps {
  const store = createInMemoryUiStore();
  stores.push(store);
  const config = parseGatewayConfig({
    providers: [
      {
        modelId: "embedding-fixture",
        baseUrl: "https://embedding.example.invalid",
        apiKey: "fixture",
      },
    ],
    capabilities: [createDefaultEmbeddingCapability("embedding-fixture")],
  });
  return {
    config,
    configPresent: true,
    evidenceStore: createInMemoryEvidenceStore(),
    env: {},
    store,
    registry: createRunRegistry(),
    redactor: buildRedactor({}, config),
    modelPortFactory: () => undefined,
  };
}

function input(
  kind: "files" | "workspace-root",
  filesReadMax: number,
  elapsedMsMax: number | null = null,
): OrchestratorInput {
  const root = `/plural-semantic-${String(sequence++)}`;
  return {
    workspaceRoot: root,
    workspaceFs: memFs(root, {
      "related.ts": "export const authentication = 'module session renewal';\n",
    }),
    scope: {
      schemaVersion: "1",
      scopeId: root,
      workspaceRoot: root,
      kind,
      relativePaths: kind === "files" ? ["related.ts"] : [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "How is the authentication module structured?",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: Date.now(),
    },
    budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax, elapsedMsMax },
  };
}

describe("plural production semantic admission", () => {
  it.each([
    { kind: "workspace-root" as const, filesReadMax: 0, elapsedMsMax: null },
    { kind: "workspace-root" as const, filesReadMax: 2, elapsedMsMax: 0 },
  ])(
    "does not lease a provider with read grant $filesReadMax and time grant $elapsedMsMax",
    async ({ kind, filesReadMax, elapsedMsMax }) => {
      const lease = vi.spyOn(semantic, "configuredRepoSemanticSearchProviderLeaseFor");
      const output = await defaultRetriever(
        new AbortController().signal,
        runtime(),
      )(input(kind, filesReadMax, elapsedMsMax));
      expect(lease).not.toHaveBeenCalled();
      expect(output.pack.files).toEqual([]);
    },
  );

  it("passes the actual request governor to an admitted semantic provider and closes its lease", async () => {
    const close = vi.fn();
    const signal = new AbortController().signal;
    const original = input("workspace-root", 4);
    let admitted: semantic.ConfiguredRepoSemanticSearchOptions | undefined;
    const lease = vi
      .spyOn(semantic, "configuredRepoSemanticSearchProviderLeaseFor")
      .mockImplementation((_deps, _signal, _root, options) => {
        admitted = options;
        const provider: SemanticSearchProvider = {
          name: "admitted semantic fixture",
          search: () => {
            expect(options?.tryReserveRefreshUsage?.({ modelInputTokens: 1 })).toBe(true);
            return Promise.resolve([{ scopePath: "related.ts", line: 1, score: 1 }]);
          },
        };
        return { provider, close };
      });
    const output = await defaultRetriever(signal, runtime(), "plural-semantic-governor")(original);
    expect(lease).toHaveBeenCalledOnce();
    expect(admitted).toMatchObject({ correlationId: "plural-semantic-governor", signal });
    expect(admitted?.fs).toBeDefined();
    expect(admitted?.nowMs).toBeTypeOf("function");
    expect(admitted?.deadlineAtMs).toBeGreaterThan(original.query.emittedAtMs);
    expect(output.pack.usage.modelInputTokens).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });
});
