import { EventEmitter } from "node:events";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { createInMemoryEvidenceStore, loadEvidence } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import { buildRedactor, createRunRegistry } from "./index.js";
import type { UiHandlerDeps } from "./deps.js";
import { handleGroundedWorkflowHandoff } from "./grounded-handoff.js";
import {
  clearAllGroundedTurns,
  rememberGroundedTurn,
} from "./grounded-turn-registry.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "..", "tests", "fixtures", "unit-tests", "target-project");
const NOW = 1_700_000_000_000;
const DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,6 @@\n" +
  "+import { describe, expect, it } from 'vitest';\n" +
  "+import { add } from '../src/add';\n" +
  "+describe('add', () => {\n" +
  "+  it('adds', () => expect(add(1, 2)).toBe(3));\n" +
  "+});\n";

let workspaceRoot: string;
let store: UiStore;
let deps: UiHandlerDeps;

function fakeReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function fakeRes(): RouteContext["res"] {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return res;
}

function ctx(body: string): RouteContext {
  return {
    req: fakeReq(body),
    res: fakeRes(),
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded/handoff"),
  };
}

function fakeModel(): ModelPort {
  return {
    call: (): Promise<NormalizedResponse> =>
      Promise.resolve({
        modelId: "test-model",
        content: ["```diff", DIFF.trimEnd(), "```"].join("\n"),
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "req-1",
          promptTokens: 11,
          completionTokens: 7,
          latencyMs: 3,
          costClass: "low",
        },
      }),
  };
}

function groundedPack(root: string): ConnectedContextPack {
  const excerpt = "export function add(a: number, b: number) { return a + b; }";
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pl-0123456789abcdef",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "cs-grounded",
      workspaceRoot: root,
      kind: "directory",
      relativePaths: ["src"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "Generate tests for add",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: { ...DEFAULT_EXPLORATION_BUDGET },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: excerpt.length,
      modelInputTokens: 5,
      modelOutputTokens: 2,
      elapsedMs: 9,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: "src/add.ts",
        role: "read-only",
        selectionReason: "ranked",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "atom-add-1",
              scopePath: "src/add.ts",
              lineRange: { startLine: 1, endLine: 2 },
              score: 0.9,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp-add",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content: excerpt,
            contentBytes: new TextEncoder().encode(excerpt).length,
          },
        ],
      },
    ],
    omitted: [],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

async function waitForTerminal(runId: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const record = deps.registry.get(runId);
    if (record !== undefined && record.status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not terminate");
}

function handoffRequest(assistantMessageId: string): string {
  return JSON.stringify({
    assistantMessageId,
    modelId: "test-model",
    workflowKind: "unit-test-generation",
    input: {
      target: { kind: "file", filePath: "src/add.ts" },
    },
    editablePaths: ["tests/add.test.ts"],
    requestedAtMs: NOW,
  });
}

function expectGovernedArtifacts(runId: string): void {
  const record = deps.registry.get(runId);
  expect(record?.status).toBe("completed");
  expect(record?.appliable?.governedHandoff).toMatchObject({
    workflowKind: "unit-test-generation",
    patchScope: {
      editablePaths: ["tests/add.test.ts"],
      readOnlyPaths: ["src/add.ts"],
      evidenceAtomIds: ["atom-add-1"],
      expectedChecks: ["tests"],
    },
  });

  const manifest = loadEvidence(deps.evidenceStore, runId);
  expect(manifest?.governedHandoff).toMatchObject({
    sourceGroundedRunId: "grounded-run-1",
    workflowKind: "unit-test-generation",
    editablePathCount: 1,
    readOnlyPathCount: 1,
    evidenceAtomCount: 1,
    expectedChecks: ["tests"],
  });
}

beforeEach((): void => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-grounded-handoff-"));
  cpSync(FIXTURE, workspaceRoot, { recursive: true });
  store = createInMemoryUiStore();
  const project = store.createProject(workspaceRoot, "fixture");
  const chat = store.createChat(project.path, "Grounded handoff", "test-model");
  rememberGroundedTurn({
    assistantMessageId: "assistant-1",
    chatId: chat.id,
    workspaceRoot,
    evidenceRunId: "grounded-run-1",
    packs: [groundedPack(workspaceRoot)],
  });
  const evidenceStore = createInMemoryEvidenceStore();
  deps = {
    config: undefined,
    configPresent: false,
    evidenceStore,
    env: {},
    redactor: buildRedactor({}, undefined),
    registry: createRunRegistry(),
    modelPortFactory: (): ModelPort => fakeModel(),
    store,
  };
});

afterEach((): void => {
  clearAllGroundedTurns();
  store.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("handleGroundedWorkflowHandoff", () => {
  it("starts a governed unit-test run from remembered grounded context and persists provenance", async () => {
    const result = await handleGroundedWorkflowHandoff(ctx(handoffRequest("assistant-1")), deps);

    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const body = result.body as {
      run: { runId: string; fingerprint: string };
      messages: readonly { id: string; role: string; content: string }[];
    };
    expect(body.run.runId).toMatch(/[0-9a-f-]{36}/u);
    expect(body.messages).toHaveLength(2);

    await waitForTerminal(body.run.runId);
    expectGovernedArtifacts(body.run.runId);
  });

  it("returns NOT_FOUND when the grounded turn registry no longer has the answer context", async () => {
    const result = await handleGroundedWorkflowHandoff(ctx(handoffRequest("missing-answer")), deps);

    expect(result.status).toBe(404);
  });
});
