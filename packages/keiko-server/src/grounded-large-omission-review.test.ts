import { describe, expect, it } from "vitest";
import {
  connectedContextOmittedCounts,
  DEFAULT_EXPLORATION_BUDGET,
  MAX_OMITTED_CONTEXT_ENTRIES,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { buildQuery } from "./grounded-qa.js";

const ROOT = "/synthetic/large-omission-review";

describe("large ordinary-folder omission accumulation", () => {
  it("retains exact exclusion totals without spreading 150000 arguments", async (): Promise<void> => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 150_000; index += 1)
      files[`images/image-${String(index)}.png`] = "x";
    let bodyReads = 0;
    const unexpectedRead = (): never => {
      bodyReads += 1;
      throw new Error("Unexpected image body read");
    };
    const fs = {
      ...memFs(ROOT, files),
      readFileUtf8: unexpectedRead,
      readFileBytes: unexpectedRead,
      readFileUtf8SameDescriptor: unexpectedRead,
      readFileUtf8WithinRootSameDescriptor: unexpectedRead,
      readFileUtf8Prefix: unexpectedRead,
      readFileRange: unexpectedRead,
      openFileReader: unexpectedRead,
    };
    const { pack } = await retrieveConnectedContextPack(
      {
        workspaceRoot: ROOT,
        budget: {
          ...DEFAULT_EXPLORATION_BUDGET,
          excerptBytesMax: 1_048_576,
          modelInputTokensMax: 200_000,
        },
        scope: {
          schemaVersion: "1",
          scopeId: "large-omissions",
          workspaceRoot: ROOT,
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
          conversationId: "chat",
          connectedAtMs: 1,
        },
        query: { ...buildQuery('Find "AbsentImageEvidenceProbe".', () => 1), maxResults: 150_000 },
      },
      {
        fs,
        nowMs: () => 1,
        correlationId: undefined,
        detectWorkspace: () => ({
          root: ROOT,
          selectedRoot: ROOT,
          name: "synthetic",
          version: "0.0.0",
          testFramework: "unknown",
          sourceDirs: [],
          testDirs: [],
          languages: [],
          ignoreLines: [],
        }),
        answerer: { answer: () => Promise.reject(new Error("Unexpected model call")) },
      },
    );
    expect(pack.files).toEqual([]);
    expect(pack.diagnostics?.coverage?.filesDiscovered).toBe(150_000);
    expect(connectedContextOmittedCounts(pack).binary).toBe(150_000);
    expect(pack.omitted.length).toBeLessThanOrEqual(MAX_OMITTED_CONTEXT_ENTRIES);
    expect(bodyReads).toBe(0);
  }, 20_000);
});
