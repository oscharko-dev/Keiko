import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { CodingWorkbenchMode, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type {
  ConversationId,
  MemoryReviewerId,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  createMemoryAuditDeleteCommitHandler,
  createMemoryAuditHandler,
} from "./memory-audit-handler.js";
import { handleForgetMemory, handleListMemories } from "./memory-handlers.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import { captureSalientFromTurn } from "./memory-salience.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

const SECRET_MARKER = "FAKE-JOURNAL-SECRET-PLACEHOLDER";
const SECRET_TURN = `The deployment login uses password=${SECRET_MARKER}.`;

interface RecentCaptureWire {
  readonly outcome: "captured" | "proposed" | "auto-accepted" | "rejected";
  readonly scope: { readonly kind: string };
  readonly mode: CodingWorkbenchMode;
  readonly provenance: { readonly initiatorSurface: string; readonly sourceKind: string };
  readonly reason: string;
  readonly memoryId?: string;
  readonly bodyExcerpt?: string;
}

const temporaryDirectories: string[] = [];
const activeVaults: MemoryVaultStore[] = [];

afterEach(() => {
  for (const vault of activeVaults.splice(0)) vault.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeModel(content: string): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      return Promise.resolve({
        modelId: request.modelId,
        content,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "capture-projection-journey",
          promptTokens: 4,
          completionTokens: 2,
          latencyMs: 1,
          costClass: "low",
        },
      });
    },
  };
}

function modelFact(body: string): string {
  return JSON.stringify([
    {
      source: "user",
      body,
      type: "fact",
      confidence: 0.8,
      scope: "project",
      tags: ["journal"],
    },
  ]);
}

function context(): ConversationMemoryRuntimeContext {
  return {
    userId: "local-operator" as UserId,
    workspaceId: "workspace-a" as WorkspaceId,
    projectId: "project-a" as ProjectId,
    conversationId: "conversation-a" as ConversationId,
  };
}

function makeRequest(content: string): {
  readonly content: string;
  readonly memory: { readonly enabled: boolean };
} {
  return { content, memory: { enabled: true } };
}

function makeRouteContext(path: string, payload: unknown, id?: string): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage,
    res: { socket: new Socket() } as unknown as RouteContext["res"],
    params: id === undefined ? {} : { id },
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function makeVault(
  evidenceStore: ReturnType<typeof createInMemoryEvidenceStore>,
): MemoryVaultStore {
  const memoryDir = mkdtempSync(join(tmpdir(), "keiko-capture-projection-"));
  temporaryDirectories.push(memoryDir);
  const redactString = (value: string): string => value;
  const postCommitAudit = createMemoryAuditHandler({ evidenceStore, redactString });
  const vault = createMemoryVault({
    memoryDir,
    redactString,
    onMemoryEvent: (event) => {
      if (event.kind !== "memory:deleted" && event.kind !== "memory:tombstoned") {
        postCommitAudit(event);
      }
    },
    onDeleteEventsBeforeCommit: createMemoryAuditDeleteCommitHandler({
      evidenceStore,
      redactString,
    }),
  });
  activeVaults.push(vault);
  return vault;
}

function depsFor(
  vault: MemoryVaultStore,
  evidenceStore: ReturnType<typeof createInMemoryEvidenceStore>,
  mode: CodingWorkbenchMode,
  modelOutput: string,
): UiHandlerDeps {
  const ctx = context();
  return {
    config: undefined,
    configPresent: false,
    evidenceStore,
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => fakeModel(modelOutput),
    store: createInMemoryUiStore(),
    memoryVault: vault,
    memoryAuthorization: {
      reviewerId: "local-operator" as MemoryReviewerId,
      authorizedScopes: () => [{ kind: "project", projectId: ctx.projectId }],
    },
    codingRuntimeDeploymentCeiling: mode,
  };
}

function recentCaptures(deps: UiHandlerDeps, since: number): readonly RecentCaptureWire[] {
  const result = handleListMemories(
    makeRouteContext(`/api/memory?since=${String(since)}&order=desc`, {}),
    deps,
  );
  expect(result.status).toBe(200);
  return (result.body as { readonly captures: readonly RecentCaptureWire[] }).captures;
}

describe("recent memory capture journey", () => {
  it("projects mode decisions, refuses secrets, and never resurrects a forgotten capture", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const ctx = context();
    const since = Date.now() - 1_000;
    const governed = depsFor(
      vault,
      evidenceStore,
      "governed-assist",
      modelFact("The release train follows a two-week cadence."),
    );
    const supervised = depsFor(
      vault,
      evidenceStore,
      "supervised-coding",
      modelFact("This output must not be reached for a refused turn."),
    );
    const autonomous = depsFor(
      vault,
      evidenceStore,
      "autonomous-delivery",
      modelFact("The platform team uses deterministic deployment windows."),
    );

    await captureSalientFromTurn(
      governed,
      makeRequest("We reviewed the release cadence."),
      ctx,
      "gpt-test",
      "ok",
    );
    await captureSalientFromTurn(
      autonomous,
      makeRequest("We reviewed deployment scheduling."),
      ctx,
      "gpt-test",
      "ok",
    );
    await captureSalientFromTurn(supervised, makeRequest(SECRET_TURN), ctx, "gpt-test", "ok");

    const initial = recentCaptures(autonomous, since);
    expect(initial.map(({ outcome, mode }) => [outcome, mode])).toEqual([
      ["rejected", "supervised-coding"],
      ["auto-accepted", "autonomous-delivery"],
      ["proposed", "governed-assist"],
    ]);
    expect(initial.every((capture) => capture.scope.kind === "project")).toBe(true);
    expect(
      initial.every(
        (capture) =>
          capture.provenance.initiatorSurface === "conversation-center" &&
          capture.provenance.sourceKind === "system-default" &&
          capture.reason.length > 0,
      ),
    ).toBe(true);
    const rejected = initial[0];
    expect(rejected).not.toHaveProperty("memoryId");
    expect(rejected).not.toHaveProperty("bodyExcerpt");
    expect(JSON.stringify(initial)).not.toContain(SECRET_MARKER);

    const proposedId = initial.find((capture) => capture.outcome === "proposed")?.memoryId;
    expect(proposedId).toBeDefined();
    const forgotten = await handleForgetMemory(
      makeRouteContext(
        `/api/memory/${String(proposedId)}/forget`,
        { acknowledged: true },
        proposedId,
      ),
      governed,
    );
    expect(forgotten.status).toBe(200);

    const afterForget = recentCaptures(autonomous, since);
    expect(afterForget.map((capture) => capture.outcome)).toEqual(["rejected", "auto-accepted"]);
    expect(recentCaptures(autonomous, since)).toEqual(afterForget);
  });
});
