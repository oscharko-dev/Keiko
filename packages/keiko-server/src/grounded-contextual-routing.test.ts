import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  ConnectedContextPack,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { SemanticSearchProvider } from "@oscharko-dev/keiko-workspace";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-contextual-routing-"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source/worker.ts"), "export function RetryWorker() { return 0; }\n");
  writeFileSync(join(root, "source/failure.ts"), 'throw new Error("BUILD_ERR_17");\n');
  writeFileSync(
    join(root, "source/context.ts"),
    'export function SmartMode() { return "three attempts after a temporary interruption"; }\n',
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function retrieve(
  text: string,
  kind: RetrievalQuery["kind"] = "natural-language",
): Promise<{
  pack: ConnectedContextPack;
  queries: readonly RetrievalQuery[];
  events: ReturnType<typeof createBufferedServerLogSink>["events"];
}> {
  const activityLog = createBufferedServerLogSink();
  const queries: RetrievalQuery[] = [];
  const provider: SemanticSearchProvider = {
    name: "deterministic contextual fixture",
    search: (input) => {
      queries.push(input.query);
      return Promise.resolve([{ scopePath: "source/context.ts", line: 1, score: 0.99 }]);
    },
  };
  const result = await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "contextual-routing",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: undefined,
        connectedAtMs: 0,
      },
      query: { kind, text, caseSensitive: false, maxResults: 20, emittedAtMs: 0 },
    },
    {
      correlationId: "contextual-routing",
      nowMs: () => 0,
      activityLog,
      repoSemanticSearchProvider: provider,
      answerer: { answer: () => Promise.reject(new TypeError("No model call allowed")) },
    },
  );
  return { pack: result.pack, queries, events: activityLog.events };
}

it.each([
  "Why does implementation of RetryWorker fail?",
  "Why does the declaration of RetryWorker cause an exception?",
  'Find out exactly why RetryWorker failed with "BUILD_ERR_17".',
  'Search for why RetryWorker fails with the exact error "BUILD_ERR_17".',
  'What does "Smart Mode" do?',
  'Explain "Smart Mode" in this folder.',
  "What does 'Smart Mode' do if it doesn't connect?",
  "Explain why RetryWorker doesn't complete.",
  'Explain "Smart Mode',
  "Warum scheitert die Implementierung von RetryWorker?",
  'Was bedeutet "Smart Mode" in diesem Ordner?',
])("keeps the full contextual query and semantic evidence: %s", async (question) => {
  const { pack, queries, events } = await retrieve(question);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({ kind: "natural-language", text: question });
  expect(pack.files.map((file) => file.scopePath)).toContain("source/context.ts");
  const completion = events.find((event) => event.op === "search.connected-context.completed");
  expect(completion?.extra?.augmentationSkipReason).not.toBe("complete-exact-lookup");
  expect(completion?.extra?.augmentationSkipReason).not.toBe("literal-absence");
});

it.each([
  'Find the exact literal "Missing failure".',
  'Find the exact literal "why failed implementation".',
  'What value is documented for "Missing label"?',
  'What value is documented for "Missing failure"?',
])(
  "preserves strict literal absence without interpreting quoted contents: %s",
  async (question) => {
    const { pack, queries } = await retrieve(question);
    expect(queries).toHaveLength(0);
    expect(pack.files).toEqual([]);
    expect(pack.usage.searchCalls).toBe(1);
  },
);

it("preserves a typed exact-symbol lookup", async () => {
  const { pack, queries } = await retrieve("RetryWorker", "exact-symbol");
  expect(queries).toHaveLength(0);
  expect(pack.files.map((file) => file.scopePath)).toEqual(["source/worker.ts"]);
  expect(pack.usage.searchCalls).toBe(1);
});
