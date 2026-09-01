import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { PathDeniedError, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import {
  retrieveConnectedContextPack,
  type GroundedAnswerer,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "./observability/index.js";

const NOW = 1_700_000_000_000;
const CORRELATION_ID = "denied-root-correlation-0001";

const ANSWERER_NOT_USED: GroundedAnswerer = {
  answer: (): Promise<string> => Promise.reject(new Error("answerer must not run")),
};

describe("grounded orchestrator denied-root activity", () => {
  let fixtureRoot: string | undefined;

  afterEach(() => {
    if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("logs a correlated body-free event when a workspace root relocates a denied locus", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-denied-root-log-"));
    const deniedTarget = join(fixtureRoot, ".aws", "workspace");
    const linkedRoot = join(fixtureRoot, "node_modules", "workspace");
    mkdirSync(deniedTarget, { recursive: true });
    mkdirSync(dirname(linkedRoot), { recursive: true });
    writeFileSync(join(deniedTarget, "secret.ts"), "private customer content\n");
    symlinkSync(deniedTarget, linkedRoot);
    const input = fixtureInput(linkedRoot);
    const activityLog = createBufferedServerLogSink();
    let detectCalls = 0;

    await expect(
      retrieveConnectedContextPack(input, {
        answerer: ANSWERER_NOT_USED,
        activityLog,
        correlationId: CORRELATION_ID,
        nowMs: () => NOW,
        detectWorkspace: (): WorkspaceInfo => {
          detectCalls += 1;
          return fixtureWorkspace(linkedRoot);
        },
        gitFileHistoryEvidence: (): Promise<readonly []> => Promise.resolve([]),
      }),
    ).rejects.toBeInstanceOf(PathDeniedError);

    expect(detectCalls).toBe(0);
    expect(activityLog.events).toEqual([
      expect.objectContaining({
        level: "warn",
        category: "security",
        op: "workspace.root-relocation.denied",
        correlationId: CORRELATION_ID,
        errorKind: "WORKSPACE_PATH_DENIED",
        extra: { decision: "denied", reason: "relocated-denied-locus" },
      }),
    ]);
    expect(JSON.stringify(activityLog.events)).not.toContain(fixtureRoot);
    expect(JSON.stringify(activityLog.events)).not.toContain("private customer content");
  });
});

function fixtureScope(root: string): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "denied-root-scope",
    workspaceRoot: root,
    kind: "files",
    relativePaths: ["secret.ts"],
    conversationId: undefined,
    connectedAtMs: NOW,
    explicitConnection: true,
  };
}

function fixtureQuery(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "find secret",
    caseSensitive: false,
    maxResults: 5,
    emittedAtMs: NOW,
  };
}

function fixtureInput(root: string): OrchestratorInput {
  return { scope: fixtureScope(root), query: fixtureQuery(), workspaceRoot: root };
}

function fixtureWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    name: "denied-root-fixture",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}
