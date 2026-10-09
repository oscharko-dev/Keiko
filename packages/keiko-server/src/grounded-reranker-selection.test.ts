import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import type { RerankerSeam } from "@oscharko-dev/keiko-workflows";
import type { SemanticSearchProvider } from "@oscharko-dev/keiko-workspace";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";
import { retrieveConnectedContextPack, type RetrievalOnlyOutput } from "./grounded-orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureScope(): SelectedScope {
  const root = mkdtempSync(join(tmpdir(), "keiko-preselection-rerank-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src/primary.ts"),
    "export const invoice = 1;\n" + "// Bounded unrelated padding.\n".repeat(5_000),
  );
  writeFileSync(
    join(root, "src/secondary.ts"),
    "export const account = 2;\n" + "// Bounded unrelated padding.\n".repeat(5_000),
  );
  return {
    schemaVersion: "1",
    scopeId: "reranker-selection",
    workspaceRoot: root,
    kind: "workspace-root",
    relativePaths: [],
    connectedAtMs: 1,
    conversationId: undefined,
    explicitConnection: true,
  };
}

function retrieve(reranker?: RerankerSeam, primaryScore = 0.99): Promise<RetrievalOnlyOutput> {
  const scope = fixtureScope();
  const provider: SemanticSearchProvider = {
    name: "bounded fixture",
    search: () =>
      Promise.resolve([
        { scopePath: "src/primary.ts", score: primaryScore, line: 1 },
        { scopePath: "src/secondary.ts", score: 0.001, line: 1 },
      ]),
  };
  return retrieveConnectedContextPack(
    {
      scope,
      workspaceRoot: scope.workspaceRoot,
      query: {
        kind: "natural-language",
        text: "How do we calculate charges for billing events?",
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: 1,
      },
    },
    {
      answerer: { answer: () => Promise.resolve("") },
      nowMs: () => 1,
      contextPackReranker: reranker,
      repoSemanticSearchProvider: provider,
    },
  );
}

describe("production reranking precedes relevance selection", () => {
  it("surfaces an ordinary keep-one fallback in the prompt and wire summary", async () => {
    const { pack } = await retrieve({
      name: "no confident relevance",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: (candidates) =>
        Promise.resolve(candidates.map((candidate) => ({ ...candidate, score: 0.001 }))),
    });
    expect(pack.files.length).toBeGreaterThan(0);
    expect(pack.diagnostics?.selection).toMatchObject({
      keepOneFallbackApplied: true,
      selectionConfidence: "low",
    });
    expect(pack.uncertainty.map((marker) => marker.kind)).toContain("low-confidence-selection");
    const messages = buildGroundedGatewayMessages("Explain billing events", pack, (text) => text);
    expect(messages.map((message) => message.content).join("\n")).toContain(
      "The supplied evidence may be unrelated to the question.",
    );
    expect(buildGroundedAnswerContextPackSummary(pack, 0, 0).selectionConfidence).toBe("low");
  });

  it("makes the weak pre-floor candidate available to a metadata reranker", async () => {
    let seen: readonly string[] = [];
    const result = await retrieve({
      name: "rescues secondary",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: (candidates) => {
        seen = candidates.map((candidate) => candidate.scopePath);
        return Promise.resolve(
          candidates.map((candidate) => ({
            ...candidate,
            score: candidate.scopePath === "src/secondary.ts" ? 0.99 : 0.1,
          })),
        );
      },
    });
    expect(seen).toContain("src/secondary.ts");
    expect(result.pack.files.map((file) => file.scopePath)).toContain("src/secondary.ts");
    expect(result.pack.diagnostics).toMatchObject({
      selection: { rerankerDisposition: "applied", reranked: true },
    });
  });

  it("keeps evidence on a thrown reranker failure and counts no applied rerank", async () => {
    const result = await retrieve({
      name: "failed provider",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: () => Promise.reject(new Error("synthetic reranker failure")),
    });
    expect(result.pack.files.length).toBeGreaterThan(0);
    expect(result.pack.usage.rerankCalls).toBe(1);
    expect(result.pack.diagnostics).toMatchObject({
      selection: { rerankerDisposition: "failed", reranked: false, rerankFailedCalls: 1 },
    });
  });
});
