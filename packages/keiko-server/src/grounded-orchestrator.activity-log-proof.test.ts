import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
// Activity Log proofs for connected-context retrieval (#3532).
//
// `retrieveConnectedContextPack` is the real, exported orchestrator entry point that drives
// `createConnectedContextActivity` (grounded-orchestrator.ts) through its started / completed /
// completion-details / failed lifecycle. These tests capture the REAL events that function emits
// through an injected in-memory sink and feed them to `formatActivityLogProofLine`, which
// revalidates them through the production file-sink formatter before `expectActivityLogProof`
// accepts them — so each resolved proof id is backed by the actual producer, never a hand-built
// event (AGENTS.md §7).

import { describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type EvidenceAtom,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";

import type { GitFileHistoryEvidenceProvider } from "./grounded-git-history-evidence.js";
import {
  retrieveConnectedContextPack,
  type GroundedAnswerer,
  type OrchestratorDeps,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const FIXTURE_NOW_MS = 1_700_000_000_000;
const FIXTURE_ROOT = "/private/customer/connected-context-proof-fixture";
const FIXTURE_QUERY_TEXT = "Trace ConnectedContextProofHandler implementation";
const CORRELATION_ID = "connected-context-proof-correlation-0001";
const SCOPE_PATH = "proof-source";
const SCOPE_FILE = `${SCOPE_PATH}/connected-context-proof-handler.ts`;

const ANSWERER_NOT_USED: GroundedAnswerer = {
  answer: (): Promise<string> => Promise.resolve("answerer must not run"),
};

const NO_GIT_HISTORY: GitFileHistoryEvidenceProvider = (): Promise<readonly EvidenceAtom[]> =>
  Promise.resolve([]);

function fixtureScope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "connected-context-proof-scope",
    workspaceRoot: FIXTURE_ROOT,
    kind: "files",
    relativePaths: [SCOPE_FILE],
    conversationId: undefined,
    connectedAtMs: FIXTURE_NOW_MS,
    explicitConnection: false,
  };
}

function fixtureQuery(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: FIXTURE_QUERY_TEXT,
    caseSensitive: false,
    maxResults: 20,
    emittedAtMs: FIXTURE_NOW_MS,
  };
}

function fixtureInput(): OrchestratorInput {
  return {
    scope: fixtureScope(),
    query: fixtureQuery(),
    workspaceRoot: FIXTURE_ROOT,
  };
}

function fixtureWorkspace(): WorkspaceInfo {
  return {
    root: FIXTURE_ROOT,
    selectedRoot: FIXTURE_ROOT,
    name: "connected-context-proof-fixture",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: [SCOPE_PATH],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function fixtureDeps(activityLog: BufferedServerLogSink): OrchestratorDeps {
  return {
    answerer: ANSWERER_NOT_USED,
    correlationId: CORRELATION_ID,
    activityLog,
    nowMs: () => FIXTURE_NOW_MS,
    fs: memFs(FIXTURE_ROOT, {
      [SCOPE_FILE]: "export function ConnectedContextProofHandler(): string { return 'ok'; }\n",
    }),
    detectWorkspace: fixtureWorkspace,
    gitFileHistoryEvidence: NO_GIT_HISTORY,
  };
}

describe("retrieveConnectedContextPack Activity Log proofs", () => {
  it("resolves the started, completion-details and completed proofs from one real retrieval", async () => {
    const activityLog = createBufferedServerLogSink();

    const output = await retrieveConnectedContextPack(fixtureInput(), fixtureDeps(activityLog));

    expect(activityLog.events).toHaveLength(3);
    const [started, details, completed] = activityLog.events;

    const startedProof = expectActivityLogProof(
      "search.connected-context.started.line",
      formatActivityLogProofLine(started ?? {}),
    );
    expect(startedProof).toMatchObject({
      correlationId: CORRELATION_ID,
      scopeKind: "files",
      relativePathCount: 1,
      explicitConnection: false,
      queryKind: "natural-language",
      inputStatus: "valid",
      completeness: "complete",
      loss: "none",
    });

    const detailsProof = expectActivityLogProof(
      "search.connected-context.completion-details.line",
      formatActivityLogProofLine(details ?? {}),
    );
    expect(detailsProof).toMatchObject({
      correlationId: CORRELATION_ID,
      activityDetailStatus: "complete",
      completeness: "complete",
      loss: "none",
    });
    expect(detailsProof.scopeIdentitySha256).toBe(startedProof.scopeIdentitySha256);
    expect(detailsProof.queryIdentitySha256).toBe(startedProof.queryIdentitySha256);

    const completedProof = expectActivityLogProof(
      "search.connected-context.completed.line",
      formatActivityLogProofLine(completed ?? {}),
    );
    expect(completedProof).toMatchObject({
      correlationId: CORRELATION_ID,
      activityDetailStatus: "complete",
      selectedFileCount: output.pack.files.length,
      completeness: "complete",
      loss: "none",
    });
    expect(completedProof.scopeIdentitySha256).toBe(startedProof.scopeIdentitySha256);
    expect(completedProof.queryIdentitySha256).toBe(startedProof.queryIdentitySha256);
  });

  it("resolves the failed proof from a real workspace-detection failure", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput();
    const failure = new TypeError(`workspace unavailable: ${FIXTURE_ROOT}`);

    await expect(
      retrieveConnectedContextPack(input, {
        ...fixtureDeps(activityLog),
        detectWorkspace: (): never => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(activityLog.events).toHaveLength(2);
    const [, failed] = activityLog.events;

    const failedProof = expectActivityLogProof(
      "search.connected-context.failed.line",
      formatActivityLogProofLine(failed ?? {}),
    );
    expect(failedProof).toMatchObject({
      correlationId: CORRELATION_ID,
      outcome: "failed",
      retrievalPhase: "workspace-detection",
      errorKind: "internal",
      activityDetailStatus: "complete",
      completeness: "complete",
      loss: "none",
    });
  });
});
