import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  PathDeniedError,
  WorkspaceNotFoundError,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import {
  retrieveConnectedContextPack,
  ClarificationNeededError,
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
    const linkedRoot = join(fixtureRoot, "selected", "workspace");
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
    expect(activityLog.events).toHaveLength(1);
    expect(activityLog.events[0]).toMatchObject({
      level: "warn",
      category: "security",
      op: "workspace.root-relocation.denied",
      correlationId: CORRELATION_ID,
      errorKind: "WORKSPACE_PATH_DENIED",
    });
    expect(activityLog.events[0]?.extra).toMatchObject({
      decision: "denied",
      reason: "relocated-denied-locus",
    });
    expect(JSON.stringify(activityLog.events)).not.toContain(fixtureRoot);
    expect(JSON.stringify(activityLog.events)).not.toContain("private customer content");
  });

  it("admits the root before the zero-read-budget fast path", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-denied-root-zero-budget-"));
    const deniedTarget = join(fixtureRoot, ".aws", "workspace");
    const linkedRoot = join(fixtureRoot, "selected");
    mkdirSync(deniedTarget, { recursive: true });
    symlinkSync(deniedTarget, linkedRoot);
    const activityLog = createBufferedServerLogSink();
    const input: OrchestratorInput = {
      ...fixtureInput(linkedRoot),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0, excerptBytesMax: 0 },
    };
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
      }),
    ).rejects.toBeInstanceOf(PathDeniedError);

    expect(detectCalls).toBe(0);
    expect(activityLog.events).toEqual([
      expect.objectContaining({
        op: "workspace.root-relocation.denied",
        correlationId: CORRELATION_ID,
        errorKind: "WORKSPACE_PATH_DENIED",
      }),
    ]);
    expect(JSON.stringify(activityLog.events)).not.toContain(fixtureRoot);
  });

  it.each([
    ["empty", ""],
    ["relative", "relative-root"],
    ["NUL-containing", "/workspace\u0000root"],
  ])("fails closed for an %s selected root before detection", async (_label, selectedRoot) => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-malformed-root-log-"));
    const activityLog = createBufferedServerLogSink();
    let detectCalls = 0;
    let realPathCalls = 0;
    const fs = {
      ...nodeWorkspaceFs,
      realPath: (): string => {
        realPathCalls += 1;
        throw new Error("invalid roots must not reach filesystem resolution");
      },
    };

    await expect(
      retrieveConnectedContextPack(fixtureInput(selectedRoot), {
        answerer: ANSWERER_NOT_USED,
        activityLog,
        correlationId: CORRELATION_ID,
        fs,
        detectWorkspace: (): WorkspaceInfo => {
          detectCalls += 1;
          return fixtureWorkspace(fixtureRoot ?? "");
        },
      }),
    ).rejects.toBeInstanceOf(ClarificationNeededError);

    expect(detectCalls).toBe(0);
    expect(realPathCalls).toBe(0);
    expect(activityLog.events).toEqual([]);
  });

  it("fails closed before detection when exact root admission cannot resolve the root", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-missing-root-log-"));
    const missingRoot = join(fixtureRoot, "missing");
    const activityLog = createBufferedServerLogSink();
    let detectCalls = 0;
    let realPathCalls = 0;
    const fs = {
      ...nodeWorkspaceFs,
      realPath: (): string => {
        realPathCalls += 1;
        throw new Error("root resolution failed");
      },
    };

    await expect(
      retrieveConnectedContextPack(fixtureInput(missingRoot), {
        answerer: ANSWERER_NOT_USED,
        activityLog,
        correlationId: CORRELATION_ID,
        fs,
        detectWorkspace: (): WorkspaceInfo => {
          detectCalls += 1;
          return fixtureWorkspace(missingRoot);
        },
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);

    expect(realPathCalls).toBe(1);
    expect(detectCalls).toBe(0);
    expect(activityLog.events).toEqual([]);
  });

  it("normalizes dot segments before classifying the selected root", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-dot-root-log-"));
    const deniedIntermediate = join(fixtureRoot, ".aws");
    const safeRoot = join(fixtureRoot, "safe");
    mkdirSync(deniedIntermediate);
    mkdirSync(safeRoot);
    const rawRoot = `${deniedIntermediate}${sep}..${sep}safe`;
    const detectionFailure = new Error("workspace detection failure");
    const activityLog = createBufferedServerLogSink();
    let detectedRoot: string | undefined;

    const input = { ...fixtureInput(safeRoot), workspaceRoot: rawRoot };
    await expect(
      retrieveConnectedContextPack(input, {
        answerer: ANSWERER_NOT_USED,
        activityLog,
        correlationId: CORRELATION_ID,
        detectWorkspace: (root): WorkspaceInfo => {
          detectedRoot = root;
          throw detectionFailure;
        },
      }),
    ).rejects.toBe(detectionFailure);

    expect(detectedRoot).toBe(realpathSync(safeRoot));
    expect(activityLog.events).toEqual([]);
  });

  it("hands detection the admitted canonical root if the selected alias changes later", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-checked-grounded-root-"));
    const safeRoot = join(fixtureRoot, "safe");
    const deniedRoot = join(fixtureRoot, ".aws", "workspace");
    const selectedRoot = join(fixtureRoot, "selected");
    mkdirSync(safeRoot);
    mkdirSync(deniedRoot, { recursive: true });
    symlinkSync(safeRoot, selectedRoot);
    const canonicalSafeRoot = realpathSync(safeRoot);
    const detectionFailure = new Error("workspace detection failure");
    let detectedRoot: string | undefined;

    await expect(
      retrieveConnectedContextPack(fixtureInput(selectedRoot), {
        answerer: ANSWERER_NOT_USED,
        correlationId: CORRELATION_ID,
        detectWorkspace: (root): WorkspaceInfo => {
          detectedRoot = root;
          unlinkSync(selectedRoot);
          symlinkSync(deniedRoot, selectedRoot);
          throw detectionFailure;
        },
      }),
    ).rejects.toBe(detectionFailure);

    expect(detectedRoot).toBe(canonicalSafeRoot);
  });

  it("allows an unchanged root below an existing denied ancestor", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-unchanged-denied-root-"));
    const unchangedRoot = join(fixtureRoot, ".codex", "worktrees", "project");
    mkdirSync(unchangedRoot, { recursive: true });
    const activityLog = createBufferedServerLogSink();

    const output = await retrieveConnectedContextPack(zeroReadInput(unchangedRoot), {
      answerer: ANSWERER_NOT_USED,
      activityLog,
      correlationId: CORRELATION_ID,
      nowMs: () => NOW,
    });

    expect(output.pack.uncertainty).toContainEqual(
      expect.objectContaining({ kind: "budget-clipped" }),
    );
    expect(activityLog.events).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "allows the reviewed macOS private-prefix alias",
    async () => {
      fixtureRoot = mkdtempSync("/var/tmp/keiko-platform-root-");
      const workspaceRoot = join(fixtureRoot, ".codex", "worktrees", "project");
      mkdirSync(workspaceRoot, { recursive: true });
      const activityLog = createBufferedServerLogSink();

      const output = await retrieveConnectedContextPack(zeroReadInput(workspaceRoot), {
        answerer: ANSWERER_NOT_USED,
        activityLog,
        correlationId: CORRELATION_ID,
        nowMs: () => NOW,
      });

      expect(output.pack.uncertainty).toContainEqual(
        expect.objectContaining({ kind: "budget-clipped" }),
      );
      expect(activityLog.events).toEqual([]);
    },
  );
});

function zeroReadInput(root: string): OrchestratorInput {
  return {
    ...fixtureInput(root),
    budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0, excerptBytesMax: 0 },
  };
}

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
