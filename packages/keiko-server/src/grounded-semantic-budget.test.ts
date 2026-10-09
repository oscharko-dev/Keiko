import { describe, expect, it } from "vitest";
import type { ExplorationBudget } from "@oscharko-dev/keiko-contracts/connected-context";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import type { SemanticSearchProvider, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import {
  retrieveConnectedContextPack,
  runGroundedExploration,
  type OrchestratorDeps,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";
import type { GroundedSemanticRequest } from "./grounded-semantic-request.js";
import { captureActivityLog } from "./activityLogCapture.test-support.js";

const ROOT = "/semantic-budget-fixture";
const PATH = "related.ts";
const BODY = "export const authentication = 'module session renewal';\n";
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: undefined,
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function input(budget: ExplorationBudget = DEFAULT_EXPLORATION_BUDGET): OrchestratorInput {
  return {
    workspaceRoot: ROOT,
    scope: {
      schemaVersion: "1",
      scopeId: "semantic-budget",
      workspaceRoot: ROOT,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "How is the authentication module structured?",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: 0,
    },
    budget,
  };
}

function deps(factory: (request: GroundedSemanticRequest) => void): OrchestratorDeps {
  return {
    correlationId: "semantic-budget",
    nowMs: () => 0,
    fs: memFs(ROOT, { [PATH]: BODY }),
    detectWorkspace: () => WORKSPACE,
    answerer: { answer: () => Promise.resolve("Authentication renews sessions [related.ts:1].") },
    repoSemanticSearchProviderFor: (request) => ({
      name: "budgeted semantic fixture",
      search: (): ReturnType<SemanticSearchProvider["search"]> => {
        factory(request);
        return Promise.resolve([{ scopePath: PATH, line: 1, score: 1 }]);
      },
    }),
  };
}

describe("actual semantic refresh governor admission", () => {
  it("charges new live reads and embedding tokens to the same original grant", async () => {
    let attempts = 0;
    const output = await retrieveConnectedContextPack(
      input(),
      deps((request) => {
        attempts += 1;
        expect(
          request.tryReserveRefreshUsage({ filesRead: 1, excerptBytes: 8, modelInputTokens: 7 }),
        ).toBe(true);
        expect(
          request.tryReserveRefreshUsage({
            modelInputTokens: DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax,
          }),
        ).toBe(false);
      }),
    );
    expect(attempts).toBe(1);
    expect(output.pack.usage.filesRead).toBe(2);
    expect(output.pack.usage.excerptBytes).toBeGreaterThanOrEqual(8);
    expect(output.pack.usage.modelInputTokens).toBe(7);
  });

  it("refuses an embedding with no remaining token grant without charging a rejected attempt", async () => {
    let granted: boolean | undefined;
    const output = await retrieveConnectedContextPack(
      input({ ...DEFAULT_EXPLORATION_BUDGET, modelInputTokensMax: 0 }),
      deps((request) => {
        granted = request.tryReserveRefreshUsage({ modelInputTokens: 1 });
      }),
    );
    expect(granted).toBe(false);
    expect(output.pack.usage.modelInputTokens).toBe(0);
  });

  it("opens no semantic lease when the original read grant is zero", async () => {
    let attempts = 0;
    const output = await retrieveConnectedContextPack(
      input({ ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0 }),
      deps(() => {
        attempts += 1;
      }),
    );
    expect(attempts).toBe(0);
    expect(output.pack.files).toEqual([]);
  });

  it("retains actual lexical evidence and records stale-semantic fallback without path logs", async () => {
    const log = captureActivityLog();
    const output = await retrieveConnectedContextPack(input(), {
      ...deps((request) => {
        request.observeSemanticFreshness({
          stalePaths: [PATH],
          refreshedPaths: [],
          unavailableFileCount: 0,
        });
      }),
      activityLog: log.sink,
    });
    expect(output.pack.files.map((file) => file.scopePath)).toContain(PATH);
    expect(
      output.pack.uncertainty.some(
        (marker) => marker.kind === "stale-evidence" && marker.claim.startsWith("stale-semantic:"),
      ),
    ).toBe(true);
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({ semanticStaleFallbackCount: 1, semanticRefreshedFileCount: 0 });
    expect(JSON.stringify(log.events)).not.toContain(PATH);
    expect(JSON.stringify(log.events)).not.toContain(BODY);
  });

  it("subtracts actual refresh tokens before the first synthesis call", async () => {
    let inputCap: number | undefined;
    await runGroundedExploration(input(), {
      ...deps((request) => {
        expect(request.tryReserveRefreshUsage({ modelInputTokens: 7 })).toBe(true);
      }),
      answerer: {
        answer: (_question, _pack, options) => {
          inputCap = options?.modelInputTokensMax;
          return Promise.resolve("Authentication renews sessions [related.ts:1].");
        },
      },
    });
    expect(inputCap).toBe(DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax - 7);
  });
});
