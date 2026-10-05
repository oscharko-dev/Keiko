import { describe, expect, it, vi } from "vitest";
import * as workspace from "@oscharko-dev/keiko-workspace";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const ROOT = "/case-sensitive-scope";
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "case-sensitive",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

interface CaseProbe {
  readonly name: string;
  readonly text: string;
  readonly target: string;
  readonly kind?: RetrievalQuery["kind"];
  readonly caseSensitive?: boolean;
  readonly expected: readonly string[];
}

async function retrieveFixture(example: CaseProbe): Promise<{
  readonly output: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const log = createBufferedServerLogSink();
  const result = await retrieveConnectedContextPack(
    {
      workspaceRoot: ROOT,
      scope: {
        schemaVersion: "1",
        scopeId: "case-sensitive",
        workspaceRoot: ROOT,
        kind: "workspace-root",
        relativePaths: [],
        conversationId: undefined,
        connectedAtMs: 1,
        explicitConnection: true,
      },
      query: {
        kind: example.kind ?? "natural-language",
        text: example.text,
        caseSensitive: example.caseSensitive ?? true,
        maxResults: 50,
        emittedAtMs: 1,
      },
    },
    {
      correlationId: "case-sensitive-review-0001",
      activityLog: log,
      fs: memFs(ROOT, {
        "correct.ts": `export const ${example.target} = 7;\n`,
        "lower.ts": `export const ${example.target.toLowerCase()} = 8;\n`,
      }),
      nowMs: () => 1,
      detectWorkspace: () => WORKSPACE,
      answerer: { answer: () => Promise.resolve("") },
    },
  );
  return { output: result, log };
}

describe("case-sensitive target spelling through connected retrieval", () => {
  it.each<CaseProbe>([
    {
      name: "quoted identifier",
      text: 'Find exact identifier "BinaryProbeNeedle".',
      target: "BinaryProbeNeedle",
      expected: ["correct.ts"],
    },
    {
      name: "backtick identifier",
      text: "Find `BinaryProbeNeedle`.",
      target: "BinaryProbeNeedle",
      expected: ["correct.ts"],
    },
    {
      name: "quoted phrase",
      text: 'Find exact phrase "Value X".',
      target: "Value X",
      expected: ["correct.ts"],
    },
    {
      name: "Unicode quoted spelling",
      text: 'Find "İzinProbe".',
      target: "İzinProbe",
      expected: ["correct.ts"],
    },
    {
      name: "both requested spellings",
      text: 'Find "BinaryProbeNeedle" and "binaryprobeneedle".',
      target: "BinaryProbeNeedle",
      expected: ["correct.ts", "lower.ts"],
    },
    {
      name: "mixed quote case variants",
      text: 'Find "BinaryProbeNeedle" and `binaryprobeneedle`.',
      target: "BinaryProbeNeedle",
      expected: ["correct.ts", "lower.ts"],
    },
    {
      name: "two definition spellings",
      text: "Where are BinaryProbeNeedle and binaryprobeneedle defined?",
      target: "BinaryProbeNeedle",
      expected: ["correct.ts", "lower.ts"],
    },
    {
      name: "definition symbol",
      text: "Where is BinaryProbeNeedle defined?",
      target: "BinaryProbeNeedle",
      expected: ["correct.ts"],
    },
    {
      name: "direct symbol control",
      text: "BinaryProbeNeedle",
      target: "BinaryProbeNeedle",
      kind: "exact-symbol",
      expected: ["correct.ts"],
    },
    {
      name: "case-insensitive control",
      text: 'Find "BinaryProbeNeedle".',
      target: "BinaryProbeNeedle",
      caseSensitive: false,
      expected: ["correct.ts", "lower.ts"],
    },
    {
      name: "lowercase exact control",
      text: 'Find "binaryprobeneedle".',
      target: "BinaryProbeNeedle",
      expected: ["lower.ts"],
    },
  ])("preserves $name", async (example) => {
    const { output } = await retrieveFixture(example);
    expect(output.pack.files.map((file) => file.scopePath).sort()).toEqual(example.expected);
  });
});

describe("case-sensitive lexical boundary controls", () => {
  it("leaves the caller's regular expression and case mode unchanged at the real producer", async () => {
    const search = vi.spyOn(workspace, "searchText");
    try {
      await retrieveFixture({
        name: "regex control",
        text: "BinaryProbeNeedle",
        target: "BinaryProbeNeedle",
        kind: "regex",
        expected: ["correct.ts"],
      });
      const callIndex = search.mock.calls.findIndex((call) => call[1].kind === "regex");
      expect(callIndex).toBeGreaterThanOrEqual(0);
      expect(search.mock.calls[callIndex]?.[1]).toMatchObject({
        kind: "regex",
        text: "BinaryProbeNeedle",
        caseSensitive: true,
      });
      expect(search.mock.calls[callIndex]?.[3]).not.toHaveProperty("queryInterpretation");
      const returned = search.mock.results[callIndex];
      if (returned?.type !== "return") throw new TypeError("Expected the actual search result");
      const result = await returned.value;
      expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["correct.ts"]);
    } finally {
      search.mockRestore();
    }
  });

  it("records the actual case mode and resulting evidence without target contents", async () => {
    const { output, log } = await retrieveFixture({
      name: "evidence control",
      text: 'Find "BinaryProbeNeedle".',
      target: "BinaryProbeNeedle",
      expected: ["correct.ts"],
    });
    expect(output.pack.files.map((file) => file.scopePath)).toEqual(["correct.ts"]);
    const started = log.events.find((event) => event.op === "search.connected-context.started");
    const completed = log.events.find((event) => event.op === "search.connected-context.completed");
    expect(started?.extra).toMatchObject({ caseSensitive: true, queryKind: "natural-language" });
    expect(started?.correlationId).toBe("case-sensitive-review-0001");
    expect(completed?.correlationId).toBe(started?.correlationId);
    expect(completed?.extra).toMatchObject({
      coverageStatus: "complete",
      coverageFilesScanned: output.pack.diagnostics?.coverage?.filesScanned,
      selectedFileCount: output.pack.files.length,
    });
    expect(JSON.stringify(log.events)).not.toContain("BinaryProbeNeedle");
    expect(JSON.stringify(log.events)).not.toContain(ROOT);
    expectActivityLogProof(
      "search.connected-context.started.line",
      formatActivityLogProofLine(started ?? {}),
    );
    expectActivityLogProof(
      "search.connected-context.completed.line",
      formatActivityLogProofLine(completed ?? {}),
    );
  });
});
