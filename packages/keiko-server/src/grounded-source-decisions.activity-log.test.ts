import { describe, expect, it } from "vitest";
import type { SemanticSearchProvider, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  formatActivityLogProofLine,
  expectActivityLogProof,
} from "../../../tests/support/activity-log-proof.js";

const ROOT = "/private/customer/source-decisions";
const CORRELATION = "source-decision-review-0001";
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

interface DecisionCase {
  readonly name: string;
  readonly text: string;
  readonly configured: boolean;
  readonly files: Readonly<Record<string, string>>;
  readonly disposition: string;
  readonly calls: number;
  readonly rejected: number;
  readonly primary: number;
  readonly blocked?: boolean;
}

async function assertDecision(test: DecisionCase): Promise<void> {
  const log = createBufferedServerLogSink();
  let providerCalls = 0;
  const provider: SemanticSearchProvider = {
    name: "private provider",
    search: ({ documents }) => {
      providerCalls += 1;
      return Promise.resolve(
        documents
          .filter((file) => file.scopePath === "related.ts")
          .map((file) => ({ scopePath: file.scopePath, score: 1, line: 1 })),
      );
    },
  };
  const output = await retrieveConnectedContextPack(
    {
      workspaceRoot: ROOT,
      scope: {
        schemaVersion: "1",
        scopeId: "private-scope",
        workspaceRoot: ROOT,
        kind: "workspace-root",
        relativePaths: [],
        conversationId: undefined,
        connectedAtMs: 0,
        explicitConnection: true,
      },
      query: {
        kind: "natural-language",
        text: test.text,
        maxResults: 50,
        caseSensitive: false,
        emittedAtMs: 0,
      },
      ...(test.blocked === true
        ? { budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0 } }
        : {}),
    },
    {
      correlationId: CORRELATION,
      activityLog: log,
      fs: memFs(ROOT, test.files),
      nowMs: () => 0,
      detectWorkspace: () => WORKSPACE,
      answerer: { answer: () => Promise.resolve("unused") },
      ...(test.configured ? { repoSemanticSearchProvider: provider } : {}),
    },
  );
  expect(providerCalls).toBe(test.calls);
  if (test.rejected > 0) expect(output.pack.files).toEqual([]);
  const event = log.events.find(
    (event) => event.op === "search.connected-context.completion-details",
  );
  expect(event?.extra).toMatchObject({
    semanticProviderDisposition: test.disposition,
    semanticProviderCallCount: test.calls,
    semanticRejectedAtomCount: test.rejected,
    primaryContentPathCount: test.primary,
  });
  const line = expectActivityLogProof(
    "search.connected-context.completion-details.line",
    formatActivityLogProofLine(event ?? {}),
  );
  expect(line).toHaveProperty("correlationId", CORRELATION);
  const raw = log.lines().join("\n");
  for (const secret of [ROOT, test.text, "private provider", "related.ts"])
    expect(raw).not.toContain(secret);
}

describe("connected source selection evidence", () => {
  it.each<DecisionCase>([
    {
      name: "literal suppression",
      text: 'Find exact identifier "AbsentBusinessMetric".',
      configured: true,
      files: { "related.ts": "export const approximate = 1;" },
      disposition: "suppressed",
      calls: 0,
      rejected: 0,
      primary: 0,
    },
    {
      name: "fetched semantic substitution rejection",
      text: "What value is documented for AbsentBusinessMetric?",
      configured: true,
      files: { "related.ts": "export const approximate = 1;" },
      disposition: "rejected",
      calls: 1,
      rejected: 1,
      primary: 0,
    },
    {
      name: "actual contextual provider use",
      text: "Investigate CheckoutMismatch purchase sum",
      configured: true,
      files: {
        "README.md": "CheckoutMismatch reports the wrong purchase sum.",
        "related.ts": "export const deriveCharge = (amount: number) => amount;",
      },
      disposition: "used",
      calls: 1,
      rejected: 0,
      primary: 1,
    },
    {
      name: "certified primary paths with no provider",
      text: 'Find exact identifier "ExistingProbe".',
      configured: false,
      files: {
        "a.ts": "export const ExistingProbe = 1;",
        "b.ts": "export const ExistingProbe = 2;",
      },
      disposition: "unavailable",
      calls: 0,
      rejected: 0,
      primary: 2,
    },
    {
      name: "eligible provider without candidate invocation",
      text: "What value is documented for AbsentBusinessMetric?",
      configured: true,
      files: {},
      disposition: "not-used",
      calls: 0,
      rejected: 0,
      primary: 0,
    },
    {
      name: "initial blocked budget",
      text: 'Find exact identifier "ExistingProbe".',
      configured: true,
      files: { "a.ts": "export const ExistingProbe = 1;" },
      disposition: "not-evaluated",
      calls: 0,
      rejected: 0,
      primary: 0,
      blocked: true,
    },
  ])("records $name from actual decisions", async (test) => {
    await assertDecision(test);
  });
});
