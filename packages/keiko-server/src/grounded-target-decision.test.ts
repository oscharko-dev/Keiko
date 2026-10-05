import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workspace from "@oscharko-dev/keiko-workspace";
import * as workflows from "@oscharko-dev/keiko-workflows";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import * as codeIntelligence from "@oscharko-dev/keiko-workspace/code-intelligence";
import type {
  ConnectedContextPack,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { retrieveConnectedContextPack, scanFirstSymbolLine } from "./grounded-orchestrator.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-request-target-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function retrieve(
  text: string,
  extension: "txt" | "ts",
  unreadable = false,
  workerContent = "const retry_count = 3;\n",
): Promise<{
  readonly pack: ConnectedContextPack;
  readonly queries: readonly RetrievalQuery[];
  readonly completion: Readonly<Record<string, unknown>> | undefined;
}> {
  seedContextFiles(extension, unreadable, workerContent);
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

function seedContextFiles(
  extension: "txt" | "ts",
  unreadable: boolean,
  workerContent: string,
): void {
  writeFileSync(join(root, `worker.${extension}`), workerContent);
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

it("preserves related semantic context for a contextual definition request", async () => {
  const question = "Where is `retry_count` defined? Explain its documented context.";
  const { pack, queries } = await retrieve(question, "ts");
  expect(queries[0]?.text).toBe(question);
  expect(pack.files.map((file) => file.scopePath)).toContain("worker.ts");
  const context = pack.files.find((file) => file.scopePath === "context.ts");
  expect(context?.excerpts.some((excerpt) => excerpt.content.includes("SmartMode"))).toBe(true);
  expect(
    context?.excerpts.some((excerpt) =>
      excerpt.atom.provenance.tool.startsWith("repo.semanticSearch:"),
    ),
  ).toBe(true);
});

it.each([
  "Where are `retry_count` and AbsentWorkerProbe defined? Explain their context.",
  "Where is `retry_count` defined, and which functions invoke it?",
  "Why does the implementation of `retry_count` fail?",
  "Where was `retry_count` historically defined?",
])("does not certify optional graph work as unnecessary: %s", async (question) => {
  const { pack, queries, completion } = await retrieve(question, "ts");
  expect(queries[0]?.text).toBe(question);
  expect(pack.files.map((file) => file.scopePath)).toContain("context.ts");
  expect(completion?.executedRingKinds).toContain("structural");
  expect(completion?.ringSkipReasons ?? []).not.toContain("verified-target-context");
});

it.each([
  "// const retry_count = 3;\n",
  "/*\nconst retry_count = 3;\n*/\n",
  'const example = "const retry_count = 3;";\n',
  "const example = `\nconst retry_count = 3;\n`;\n",
  "export function OtherWorker(){ return retry_count(); }\n",
])("cannot certify a declaration from comment, string, or call data: %s", async (workerContent) => {
  const { pack, completion } = await retrieve(
    "Where is `retry_count` defined? Explain its documented context.",
    "ts",
    false,
    workerContent,
  );
  expect(pack.files.map((file) => file.scopePath)).toContain("worker.ts");
  expect(completion?.ringSkipReasons ?? []).not.toContain("verified-target-context");
  expect(
    pack.files
      .flatMap((file) => file.excerpts)
      .some((excerpt) => excerpt.atom.provenance.tool === "discovered-symbol-definition"),
  ).toBe(false);
});

it("cannot certify a declaration from unsupported document syntax", async () => {
  const { completion } = await retrieve(
    "Where is `retry_count` defined? Explain its documented context.",
    "txt",
  );
  expect(completion?.ringSkipReasons ?? []).not.toContain("verified-target-context");
});

it("cannot certify complete target context when a ninth requested technical target is absent", async () => {
  const present = Array.from(
    { length: 8 },
    (_, index) => `BoundaryTarget${String.fromCharCode(65 + index)}`,
  );
  const { completion } = await retrieve(
    `Where are ${present.join(" and ")} and ZMissingTargetProbe defined? Explain their context.`,
    "ts",
    false,
    present.map((name) => `export function ${name}(){ return 3; }\n`).join(""),
  );
  expect(completion?.executedRingKinds).toContain("structural");
  expect(completion?.ringSkipReasons ?? []).not.toContain("verified-target-context");
});

it("cannot certify a quoted target omitted by an explicit planner intake limit", async () => {
  const plan = workflows.planAndGovern;
  const planner = vi
    .spyOn(workflows, "planAndGovern")
    .mockImplementation((input, deps): ReturnType<typeof plan> =>
      plan({ ...input, maxAnchors: 1 }, deps),
    );
  const { pack, completion } = await retrieve(
    'Where are "AFirstPresentProbe" and "zzmissing" defined? Explain their context.',
    "ts",
    false,
    "export function AFirstPresentProbe(){ return 3; }\n",
  );
  expect(planner).toHaveBeenCalledTimes(1);
  expect(pack.files.some((file) => file.scopePath === "worker.ts")).toBe(true);
  expect(completion?.ringSkipReasons ?? []).not.toContain("verified-target-context");
});

it("prefers a parsed declaration over an earlier lexical mention without certifying unparsed text", () => {
  const text = "// retry_count example\nconst unrelated = 0;\nconst retry_count = 3;\n";
  const control = {
    signal: undefined,
    nowMs: (): number => 0,
    deadlineMs: Number.POSITIVE_INFINITY,
  };
  expect(scanFirstSymbolLine(text, "retry_count", control)).toEqual({
    lineNumber: 1,
    deadlineReached: false,
  });
  expect(
    scanFirstSymbolLine(
      text,
      "retry_count",
      control,
      codeIntelligence.repositorySourceLines(text, "worker.ts"),
    ),
  ).toEqual({ lineNumber: 3, deadlineReached: false, definitionMatch: true });
});

it("does not certify definitions when incomplete coverage has no known stop reason", async () => {
  const search = workspace.searchText;
  vi.spyOn(workspace, "searchText").mockImplementation(
    async (...args): ReturnType<typeof search> => {
      const result = await search(...args);
      return { ...result, coverage: { ...result.coverage, incomplete: true, reasons: [] } };
    },
  );
  const { completion } = await retrieve(
    "Where is `retry_count` defined? Explain its documented context.",
    "ts",
  );
  expect(completion?.executedRingKinds).toContain("structural");
  expect(completion?.ringSkipReasons ?? []).not.toContain("verified-target-context");
});

it("shares the guarded source decode across requested declaration targets", async () => {
  seedContextFiles(
    "ts",
    false,
    "export function FirstWorkerProbe(){ return 3; }\n" +
      "export function SecondWorkerProbe(){ return 7; }\n",
  );
  const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
  if (read === undefined) throw new TypeError("The production guarded UTF-8 reader is required.");
  let sourceDecodes = 0;
  const { pack } = await retrieveConnectedContextPack(
    retrievalInput(
      "Where are FirstWorkerProbe and SecondWorkerProbe defined? Explain their context.",
    ),
    {
      correlationId: "shared-declaration-decode",
      nowMs: () => 0,
      fs: {
        ...nodeWorkspaceFs,
        readFileUtf8SameDescriptor: (...args): ReturnType<typeof read> => {
          if (args[0].endsWith("/worker.ts")) sourceDecodes += 1;
          return read(...args);
        },
      },
      answerer: { answer: () => Promise.reject(new TypeError("No model calls")) },
    },
  );
  expect(sourceDecodes).toBe(1);
  const definitions = pack.files.flatMap((file) => file.excerpts);
  expect(definitions.some((excerpt) => excerpt.content.includes("return 3;"))).toBe(true);
  expect(definitions.some((excerpt) => excerpt.content.includes("return 7;"))).toBe(true);
});

it("does not start declaration classification after the guarded read observes cancellation", async () => {
  seedContextFiles("ts", false, "export function CancelWorkerProbe(){ return 3; }\n");
  const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
  if (read === undefined) throw new TypeError("The production guarded UTF-8 reader is required.");
  const controller = new AbortController();
  const classify = vi.spyOn(codeIntelligence, "repositorySourceLines");
  const retrieval = retrieveConnectedContextPack(
    retrievalInput("Where is CancelWorkerProbe defined? Explain its context."),
    {
      correlationId: "cancel-declaration-classification",
      nowMs: (): number => 0,
      signal: controller.signal,
      fs: {
        ...nodeWorkspaceFs,
        readFileUtf8SameDescriptor: (...args): ReturnType<typeof read> => {
          const result = read(...args);
          if (args[0].endsWith("/worker.ts")) controller.abort();
          return result;
        },
      },
      answerer: { answer: () => Promise.reject(new TypeError("No model calls")) },
    },
  );
  await expect(retrieval).rejects.toMatchObject({ name: "CancelledError" });
  expect(controller.signal.aborted).toBe(true);
  expect(classify).not.toHaveBeenCalled();
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
