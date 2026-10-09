import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConnectedContextPack,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { extractRetrievalChannels } from "@oscharko-dev/keiko-workflows";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-diagnostic-routing-"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "failure.ts"), 'throw new Error("BUILD_ERR_17");\n');
  writeFileSync(join(root, "source", "policy.ts"), "const retry_count = 3;\n");
  writeFileSync(join(root, "source", "related.ts"), "const recoveredEnvironment = 81327;\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface RoutingResult {
  readonly pack: ConnectedContextPack;
  readonly semanticCalls: number;
  readonly semanticQueries: readonly string[];
  readonly completion: Readonly<Record<string, unknown>> | undefined;
  readonly logLines: readonly string[];
}

async function retrieve(
  text: string,
  kind: RetrievalQuery["kind"] = "natural-language",
): Promise<RoutingResult> {
  const activityLog = createBufferedServerLogSink();
  const semanticQueries: string[] = [];
  const search = vi.fn((request: { readonly query: RetrievalQuery }) => {
    semanticQueries.push(request.query.text);
    return Promise.resolve([{ scopePath: "source/related.ts", line: 1, score: 0.99 }]);
  });
  const result = await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "diagnostic-routing",
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
      correlationId: "diagnostic-routing",
      nowMs: () => 0,
      activityLog,
      repoSemanticSearchProvider: { name: "diagnostic fixture", search },
      answerer: { answer: () => Promise.reject(new TypeError("No model expected")) },
    },
  );
  const completion = activityLog.events.find(
    (event) => event.op === "search.connected-context.completion-details",
  );
  return {
    pack: result.pack,
    semanticCalls: search.mock.calls.length,
    semanticQueries,
    completion: completion?.extra,
    logLines: activityLog.lines(),
  };
}

it.each([
  "Why exactly does the build fail with BUILD_ERR_17?",
  'Why does the build fail with "BUILD_ERR_17"?',
])("retains diagnostic augmentation for %s", async (question) => {
  const { pack, semanticCalls, completion, logLines } = await retrieve(question);
  expect(semanticCalls).toBe(1);
  expect(pack.files.map((file) => file.scopePath)).toContain("source/related.ts");
  expect(JSON.stringify(buildGroundedGatewayMessages(question, pack, (value) => value))).toContain(
    "recoveredEnvironment",
  );
  expect(completion?.augmentationSkipReason).not.toBe("complete-exact-lookup");
  expect(logLines.join("\n")).not.toContain("BUILD_ERR_17");
});

it("searches the independent diagnostic question while preserving the original trace as model context", async () => {
  const question =
    "Why does the build fail with BUILD_ERR_17?\n" +
    "    at execute (node_modules/vitest/runner.js:10:3)";
  const { pack, semanticQueries, logLines } = await retrieve(question);
  expect(semanticQueries).toEqual([extractRetrievalChannels(question, 8).questionText]);
  const prompt = JSON.stringify(buildGroundedGatewayMessages(question, pack, (value) => value));
  expect(prompt).toContain("node_modules/vitest/runner.js:10:3");
  expect(logLines.join("\n")).not.toContain("node_modules/vitest");
});

it.each(["source/missing.ts", ".env"])(
  "does not search raw frames when a questionless diagnostic target is unadmitted: %s",
  async (path) => {
    const trace =
      `AssertionError: expected 1 to be 2\n    at Object.get (${path}:1:1)\n` +
      "    at execute (node_modules/vitest/runner.js:10:3)";
    const { pack, semanticQueries, logLines } = await retrieve(trace);
    expect(pack.query.text).toBe(trace);
    expect(pack.files.map((file) => file.scopePath)).not.toContain(path);
    expect(
      pack.files.flatMap((file) => file.excerpts.map((excerpt) => excerpt.atom.provenance.kind)),
    ).not.toContain("lexical-search");
    expect(semanticQueries).toEqual([]);
    expect(logLines.join("\n")).not.toContain("node_modules/vitest");
  },
);

it.each([
  "    at Object.get (source/failure.ts:1:1)",
  "AssertionError: expected 1 to be 2\n    at Object.get (source/failure.ts:1:1)",
  "AssertionError: expected 1 to be 2\n    at Object.get (source/failure.ts:1:1)\n" +
    "    at execute (node_modules/vitest/runner.js:10:3)",
])("retains admitted source evidence for a questionless diagnostic paste: %s", async (trace) => {
  const { pack, semanticQueries, logLines } = await retrieve(trace);
  expect(pack.query.text).toBe(trace);
  expect(pack.files.map((file) => file.scopePath)).toContain("source/failure.ts");
  expect(pack.files.map((file) => file.scopePath)).not.toContain("package.json");
  expect(semanticQueries).toEqual(["source/failure.ts"]);
  expect(JSON.stringify(buildGroundedGatewayMessages(trace, pack, (value) => value))).toContain(
    "BUILD_ERR_17",
  );
  expect(logLines.join("\n")).not.toContain("source/failure.ts");
  expect(logLines.join("\n")).not.toContain("node_modules/vitest");
});

it.each([
  "How exactly does `retry_count` get applied by the scheduler?",
  "What exactly does `retry_count` do?",
])("does not infer exact-query completion from explanatory wording: %s", async (question) => {
  const { completion } = await retrieve(question);
  expect(completion?.augmentationSkipReason).not.toBe("complete-exact-lookup");
});

it("retains the exact-symbol fast path for an explicitly typed literal lookup", async () => {
  const { pack, semanticCalls, completion } = await retrieve("BUILD_ERR_17", "exact-symbol");
  expect(semanticCalls).toBe(0);
  expect(pack.files.map((file) => file.scopePath)).toEqual(["source/failure.ts"]);
  expect(completion?.augmentationSkipReason).toBe("complete-exact-lookup");
});

it("does not turn an explicit missing error-literal lookup into diagnostic similarity", async () => {
  const { pack, semanticCalls } = await retrieve('Find the exact literal "Missing failure".');
  expect(semanticCalls).toBe(0);
  expect(pack.files).toEqual([]);
});
