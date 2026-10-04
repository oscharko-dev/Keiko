import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SemanticSearchProvider } from "@oscharko-dev/keiko-workspace";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { buildQuery } from "./grounded-qa.js";

let root = "";
beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-retention-review-"));
});
afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

async function retrieve(
  content: string,
  provider?: SemanticSearchProvider,
): Promise<Awaited<ReturnType<typeof retrieveConnectedContextPack>>> {
  return retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "retention-review",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: "chat",
        connectedAtMs: 1,
      },
      query: { ...buildQuery(content, () => 1), maxResults: 2 },
    },
    {
      nowMs: () => 1,
      correlationId: undefined,
      ...(provider === undefined ? {} : { repoSemanticSearchProvider: provider }),
      answerer: {
        answer: (): Promise<string> => Promise.reject(new Error("Unexpected model call")),
      },
    },
  );
}

describe("retained evidence review regressions", () => {
  it("distinguishes limited retained results from intentionally denied files", async (): Promise<void> => {
    mkdirSync(join(root, "facts"));
    for (let index = 0; index < 5; index += 1)
      writeFileSync(join(root, `facts/item-${String(index)}.txt`), "PolicyLimitProbe valuealpha\n");
    writeFileSync(join(root, ".env"), "unrelated synthetic configuration\n");
    const { pack } = await retrieve('Suche nach "PolicyLimitProbe".');
    expect(pack.diagnostics?.coverage?.filesScanned).toBe(5);
    expect(pack.diagnostics?.coverage?.filesAfterPolicy).toBe(5);
    expect(pack.diagnostics?.coverage?.deniedByDiscovery).toBeGreaterThan(0);
    expect(pack.diagnostics?.coverage?.reasons).toEqual(["match-cap"]);
    expect(pack.uncertainty.some((marker) => marker.kind === "budget-clipped")).toBe(true);
    expect(pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(false);
  });

  it("does not expose rejected semantic-only candidates as current ranking evidence", async (): Promise<void> => {
    writeFileSync(join(root, "related.txt"), "DifferentPolicyProbe valuealpha\n");
    const { pack } = await retrieve("Which values does AbsentPolicyProbe document?", {
      name: "synthetic",
      search: () => Promise.resolve([{ scopePath: "related.txt", line: 1, score: 0.99 }]),
    });
    expect(pack.files).toEqual([]);
    expect(pack.diagnostics?.rankedCandidates).toEqual([]);
  });
});
