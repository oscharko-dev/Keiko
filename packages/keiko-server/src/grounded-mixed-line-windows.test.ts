import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { captureActivityLog } from "./activityLogCapture.test-support.js";
import { runGroundedExploration } from "./grounded-orchestrator.js";

const ROOT = "/mixed-line-window-fixture";
const PATH = "src/validation.ts";
const FACT = "export const ValidationFact301 = 81327;";
const body = Array.from({ length: 500 }, (_unused, index) =>
  index === 300 ? FACT : `// source filler ${String(index + 1)}`,
).join("\n");

function scope(kind: SelectedScope["kind"], paths: readonly string[]): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "mixed-lines",
    workspaceRoot: ROOT,
    kind,
    relativePaths: paths,
    conversationId: undefined,
    connectedAtMs: 0,
    explicitConnection: true,
  };
}

async function askLocations(
  selected: SelectedScope,
  locations: readonly number[],
): Promise<{
  readonly seen: string;
  readonly output: Awaited<ReturnType<typeof runGroundedExploration>>;
  readonly log: ReturnType<typeof captureActivityLog>;
}> {
  let seen = "";
  const log = captureActivityLog();
  const output = await runGroundedExploration(
    {
      workspaceRoot: ROOT,
      scope: selected,
      query: {
        kind: "natural-language",
        caseSensitive: false,
        maxResults: 20,
        emittedAtMs: 0,
        text: `Why does validation fail?\n${locations
          .map((line) => `    at validate (${PATH}:${String(line)}:5)`)
          .join("\n")}`,
      },
      budget: { ...DEFAULT_EXPLORATION_BUDGET, modelInputTokensMax: 32768 },
    },
    {
      activityLog: log.sink,
      fs: memFs(ROOT, { [PATH]: body }),
      nowMs: () => 0,
      detectWorkspace: () => ({
        root: ROOT,
        selectedRoot: ROOT,
        name: undefined,
        version: undefined,
        testFramework: "unknown",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      }),
      answerer: {
        answer: async (_question, pack) => {
          await Promise.resolve();
          seen = pack.files
            .flatMap((file) => file.excerpts.map((excerpt) => excerpt.content))
            .join("\n");
          return "The fact is 81327 [src/validation.ts:301].";
        },
      },
    },
  );
  return { seen, output, log };
}

describe("mixed current and stale source locations", () => {
  it.each([
    { kind: "directory" as const, paths: ["src"] },
    { kind: "files" as const, paths: [PATH] },
  ])("preserves valid line301 for $kind with either trace-frame order", async ({ kind, paths }) => {
    for (const locations of [
      [301, 999],
      [999, 301],
    ]) {
      const { seen, output, log } = await askLocations(scope(kind, paths), locations);
      expect(seen).toContain(FACT);
      expect(output.assistantContent).toContain("81327");
      expect(
        output.pack.files
          .flatMap((file) => file.excerpts)
          .some(
            (excerpt) =>
              (excerpt.atom.lineRange?.startLine ?? 999) <= 301 &&
              (excerpt.atom.lineRange?.endLine ?? 0) >= 301,
          ),
      ).toBe(true);
      expect(log.withOp("search.connected-context.completion-details")[0]?.extra).toMatchObject({
        excerptOmittedRangeCount: 1,
      });
      expect(JSON.stringify(log.events)).not.toContain(FACT);
    }
  });
});
