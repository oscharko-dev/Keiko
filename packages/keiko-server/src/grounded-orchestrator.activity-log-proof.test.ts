import { CODE_REDACTION_REVISION } from "@oscharko-dev/keiko-security/redaction";
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
  DEFAULT_EXPLORATION_BUDGET,
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
  it("records independent compound-source selection on the existing body-free completion", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput();
    const targets = ["src/backend/RefundPolicy.java", "src/frontend/RefundSummary.tsx"];
    const files = Object.fromEntries(targets.map((path) => [path, "// Maple partner refunds.\n"]));
    for (let index = 0; index < 40; index += 1) {
      files[`src/backend/Catalog${String(index)}.java`] = "// Other partner refunds.\n".repeat(100);
    }
    const output = await retrieveConnectedContextPack(
      {
        ...input,
        budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 2, excerptBytesMax: 4096 },
        scope: {
          ...input.scope,
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
        },
        query: { ...input.query, text: "Maple-Partner" },
      },
      { ...fixtureDeps(activityLog), fs: memFs(FIXTURE_ROOT, files) },
    );
    expect(output.pack.files.map((file) => file.scopePath).sort()).toEqual(targets);
    const completed = activityLog.events.find(
      (event) => event.op === "search.connected-context.completed",
    );
    const proof = expectActivityLogProof(
      "search.connected-context.completed.line",
      formatActivityLogProofLine(completed ?? {}),
    );
    expect(proof.selectedFileCount).toBe(2);
    expect(proof.usageFilesRead).toBe(output.pack.usage.filesRead);
    expect(proof.usageExcerptBytes).toBe(output.pack.usage.excerptBytes);
    const serialized = activityLog.lines().join("\n");
    expect(serialized).not.toContain("Maple");
    for (const path of targets) expect(serialized).not.toContain(path);
  });

  it("records citation-only subject normalization without query or source bodies", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput();
    const query = {
      ...input.query,
      text: `${FIXTURE_QUERY_TEXT}. Cite implementation files and lines.`,
    };
    await retrieveConnectedContextPack({ ...input, query }, fixtureDeps(activityLog));
    const details = activityLog.events.find(
      (event) => event.op === "search.connected-context.completion-details",
    );
    const proof = expectActivityLogProof(
      "search.connected-context.completion-details.line",
      formatActivityLogProofLine(details ?? {}),
    );
    expect(proof.searchCitationDirectiveClauseCount).toBeGreaterThan(0);
    const serialized = activityLog.lines().join("\n");
    expect(serialized).not.toContain(FIXTURE_QUERY_TEXT);
    expect(serialized).not.toContain("Cite implementation files and lines");
    expect(serialized).not.toContain(SCOPE_FILE);
  });

  it("resolves started, completion, source, selection and evidence siblings from one retrieval", async () => {
    const activityLog = createBufferedServerLogSink();

    const output = await retrieveConnectedContextPack(fixtureInput(), fixtureDeps(activityLog));

    expect(activityLog.events).toHaveLength(6);
    const [started, details, sourceDetails, selectionDetails, evidenceDetails, completed] =
      activityLog.events;

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

    const sourceProof = expectActivityLogProof(
      "search.connected-context.source-details.line",
      formatActivityLogProofLine(sourceDetails ?? {}),
    );
    expect(sourceProof).toMatchObject({
      correlationId: CORRELATION_ID,
      activityDetailStatus: "complete",
      scopeIdentitySha256: startedProof.scopeIdentitySha256,
      queryIdentitySha256: startedProof.queryIdentitySha256,
      completeness: "complete",
      loss: "none",
    });

    const selectionProof = expectActivityLogProof(
      "search.connected-context.selection-details.line",
      formatActivityLogProofLine(selectionDetails ?? {}),
    );
    expect(selectionProof).toMatchObject({
      correlationId: CORRELATION_ID,
      scopeIdentitySha256: startedProof.scopeIdentitySha256,
      queryIdentitySha256: startedProof.queryIdentitySha256,
      completeness: "complete",
      loss: "none",
    });

    const evidenceProof = expectActivityLogProof(
      "search.connected-context.evidence-details.line",
      formatActivityLogProofLine(evidenceDetails ?? {}),
    );
    expect(evidenceProof).toMatchObject({
      codeRedactionRevision: CODE_REDACTION_REVISION,
      correlationId: CORRELATION_ID,
      scopeIdentitySha256: startedProof.scopeIdentitySha256,
      queryIdentitySha256: startedProof.queryIdentitySha256,
      activityDetailStatus: "complete",
      sourceDescriptorPathCount: 0,
      completeness: "complete",
      loss: "none",
    });
    expect(sourceProof).not.toHaveProperty("_truncatedFieldCount");

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
