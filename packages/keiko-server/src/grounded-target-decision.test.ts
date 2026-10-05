import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  ConnectedContextPack,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-request-target-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function retrieve(
  text: string,
  extension: "txt" | "ts",
  unreadable = false,
): Promise<{
  readonly pack: ConnectedContextPack;
  readonly queries: readonly RetrievalQuery[];
  readonly completion: Readonly<Record<string, unknown>> | undefined;
}> {
  seedContextFiles(extension, unreadable);
  const queries: RetrievalQuery[] = [];
  const activityLog = createBufferedServerLogSink();
  const result = await retrieveConnectedContextPack(retrievalInput(text), {
    correlationId: "request-target",
    nowMs: () => 0,
    activityLog,
    repoSemanticSearchProvider: {
      name: "deterministic request context",
      search: (input) => {
        queries.push(input.query);
        return Promise.resolve([{ scopePath: `context.${extension}`, line: 1, score: 0.99 }]);
      },
    },
    answerer: { answer: () => Promise.reject(new TypeError("No model calls")) },
  });
  return {
    ...result,
    queries,
    completion: activityLog.events.find(
      (event) => event.op === "search.connected-context.completed",
    )?.extra,
  };
}

function seedContextFiles(extension: "txt" | "ts", unreadable: boolean): void {
  writeFileSync(join(root, `worker.${extension}`), "const retry_count = 3;\n");
  writeFileSync(
    join(root, `context.${extension}`),
    "SmartMode allows three attempts after a temporary interruption.\n",
  );
  if (unreadable)
    writeFileSync(join(root, "unreadable.html"), '<meta charset="keiko-unavailable-codec">\n');
}

function retrievalInput(text: string): Parameters<typeof retrieveConnectedContextPack>[0] {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "request-target",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
      conversationId: undefined,
      connectedAtMs: 0,
    },
    query: {
      kind: "natural-language",
      text,
      maxResults: 40,
      caseSensitive: false,
      emittedAtMs: 0,
    },
  };
}

const contextualQuestions = [
  "What exactly does `retry_count` do?",
  'Describe "Smart Mode".',
  'Tell me about "Smart Mode".',
  "I'd like context for `retry_count`; don't assume its purpose.",
  'Décris "Smart Mode" dans ce dossier.',
  "「Smart Mode」の動作をこのフォルダーから説明してください。",
  'Beschreibe "Smart Mode" in diesem Ordner.',
  'What exactly does "Smart Mode" NOT do?',
  "Search for why `retry_count` is necessary.",
  'Describe "Smart Mode',
  "What value should `retry_count` have to avoid interruptions?",
  "What is the safest value of `retry_count`?",
  "What is the recommended value of `retry_count`?",
  "What value is documented for `retry_count` to avoid interruptions?",
  "Find `retry_count` and explain its purpose.",
  'Search for "retry_count" and describe its operation.',
  "Don't just find `retry_count`; give its context.",
  "Find `retry_count`. Why is it necessary?",
];

it.each(
  contextualQuestions.flatMap((question) => [
    { question, extension: "txt" as const },
    { question, extension: "ts" as const },
  ]),
)(
  "preserves original contextual evidence for $extension: $question",
  async ({ question, extension }) => {
    const { pack, queries } = await retrieve(question, extension);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ kind: "natural-language", text: question });
    expect(pack.files.map((file) => file.scopePath)).toContain(`context.${extension}`);
    if (question.includes("retry_count"))
      expect(pack.files.map((file) => file.scopePath)).toContain(`worker.${extension}`);
  },
);

it.each([
  'Find the exact literal "Missing failure".',
  "Find the exact literal 'why failed implementation'.",
  'Search recursively for "Missing value".',
  'Find the exact literal "not failure".',
])("preserves clear literal absence: %s", async (question) => {
  const { pack, queries } = await retrieve(question, "txt");
  expect(queries).toEqual([]);
  expect(pack.files).toEqual([]);
  expect(pack.usage.searchCalls).toBe(1);
});

it("preserves a literal numeric search without treating requested row counts as targets", async () => {
  const { pack, queries } = await retrieve("Search for 256", "txt");
  expect(queries).toEqual([]);
  expect(pack.files).toEqual([]);
  expect(pack.diagnostics?.coverage?.matchesReturned).toBe(0);
});

it("projects semantic-only context without claiming the missing named definition was matched", async () => {
  const question = "Wo ist AbsentHandlerProbe definiert? Erfinde nichts.";
  const { pack, queries } = await retrieve(question, "txt");
  expect(queries[0]?.text).toBe(question);
  const excerpts = pack.files.flatMap((file) => file.excerpts);
  expect(excerpts.length).toBeGreaterThan(0);
  expect(
    excerpts.every((excerpt) => excerpt.atom.provenance.tool.startsWith("repo.semanticSearch:")),
  ).toBe(true);
  const messages = buildGroundedGatewayMessages(question, pack, (value) => value);
  expect(messages[1]?.content).toContain(
    "Related semantic context (not verified as an exact literal match)",
  );
  expect(messages[1]?.content).toContain("repo.semanticSearch:");
});

it("keeps contextual semantic evidence after optional graph work is avoided", async () => {
  const question = "Describe `retry_count` in this folder.";
  const { pack, queries, completion } = await retrieve(question, "ts");
  expect(queries[0]?.text).toBe(question);
  expect(pack.files.map((file) => file.scopePath).sort()).toEqual(["context.ts", "worker.ts"]);
  expect(completion?.ringSkipReasons).toContain("verified-target-context");
  expect(completion?.ringSkipReasons ?? []).not.toContain("complete-exact-lookup");
  expect(pack.usage.searchCalls).toBe(1);
});

it.each([false, true])(
  "cannot certify semantic-only or incomplete target context (unreadable=%s)",
  async (unreadable) => {
    const question = unreadable ? "Describe `retry_count`." : 'Describe "Smart Mode".';
    const { pack, completion } = await retrieve(question, "txt", unreadable);
    expect(pack.files.map((file) => file.scopePath)).toContain("context.txt");
    expect(completion?.activityDetailStatus).toBe("complete");
    expect(completion?.ringSkipReasons ?? []).not.toContain("verified-target-context");
    expect(completion?.ringSkipReasons ?? []).not.toContain("complete-exact-lookup");
    if (unreadable)
      expect(pack.diagnostics?.coverage).toMatchObject({ incomplete: true, reasons: ["io-error"] });
  },
);
