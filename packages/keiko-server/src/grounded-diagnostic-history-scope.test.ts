import { describe, expect, it, vi } from "vitest";
import type { EvidenceAtom, SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import { symbolGraphAdapter, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { ContextPackValidationError } from "@oscharko-dev/keiko-workflows";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const ROOT = "/diagnostic-history-scope-fixture";
const TARGET = "selected/main.ts";
const OUTSIDE = "other/escape.ts";
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "fixture",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function atom(path: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `diagnostic-history-scope-${path}`,
    scopePath: path,
    lineRange: { startLine: 1, endLine: 1 },
    score: 1,
    provenance: { kind: "structural", tool: "symbol-graph", queryFingerprint: "fixture" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function scope(kind: "directory" | "files"): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "diagnostic-history-scope",
    workspaceRoot: ROOT,
    kind,
    relativePaths: [kind === "directory" ? "selected" : TARGET],
    explicitConnection: true,
    conversationId: undefined,
    connectedAtMs: 0,
  };
}

describe("diagnostic history preserves selected membership", () => {
  it.each(["directory", "files"] as const)(
    "does not promote an injected outside atom into the %s history scope",
    async (kind) => {
      const injected = vi.spyOn(symbolGraphAdapter, "lookup").mockResolvedValue([atom(OUTSIDE)]);
      const historyScopes: (readonly string[])[] = [];
      const log = createBufferedServerLogSink();
      try {
        const outcome = retrieveConnectedContextPack(
          {
            workspaceRoot: ROOT,
            scope: scope(kind),
            query: {
              kind: "natural-language",
              text: `Why does this assertion fail?\n    at history (${TARGET}:1:1)`,
              caseSensitive: false,
              maxResults: 20,
              emittedAtMs: 0,
            },
          },
          {
            correlationId: "diagnostic-history-scope",
            activityLog: log,
            fs: memFs(ROOT, {
              ".git": "Fixture marker for the injected history provider.\n",
              [TARGET]: "export function history(): number { return 37; }\n",
              [OUTSIDE]: "export const outsideScopeFact = 211;\n",
            }),
            nowMs: () => 0,
            detectWorkspace: () => WORKSPACE,
            gitFileHistoryEvidence: ({ searchScope }) => {
              historyScopes.push(searchScope.relativePaths);
              return Promise.resolve([]);
            },
            answerer: { answer: () => Promise.reject(new Error("Retrieval must not answer")) },
          },
        );
        // The invalid advisory atom remains rejected by the existing final pack validator;
        // it must not broaden the earlier history provider's source membership either.
        await expect(outcome).rejects.toBeInstanceOf(ContextPackValidationError);
        expect(injected).toHaveBeenCalled();
        expect(historyScopes).toHaveLength(1);
        expect(historyScopes[0]).toEqual([TARGET]);
        expect(JSON.stringify(log.events)).not.toContain(OUTSIDE);
      } finally {
        injected.mockRestore();
      }
    },
  );
});
