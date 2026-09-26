import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
  CodingWorkbenchMode,
  MemoryStatus,
  NormalizedResponse,
} from "@oscharko-dev/keiko-contracts";
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
import {
  handleAcceptMemoryProposal,
  handleForgetMemory,
  handleListMemories,
} from "./memory-handlers.js";
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
  readonly currentStatus?: MemoryStatus;
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
    correlationId: undefined,
    req: Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage,
    res: { socket: new Socket() } as unknown as RouteContext["res"],
    params: id === undefined ? {} : { id },
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function makeVault(
  evidenceStore: ReturnType<typeof createInMemoryEvidenceStore>,
): MemoryVaultStore {
  const memoryDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-capture-projection-"));
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
    const since = 0;
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
      makeRequest("The release train follows a two-week cadence."),
      ctx,
      "gpt-test",
      "ok",
    );
    await captureSalientFromTurn(
      autonomous,
      makeRequest("The platform team uses deterministic deployment windows."),
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

  // End-to-end shape of the Journal defect: a governed-assist capture is proposed, the operator
  // accepts it elsewhere (review queue / detail view / maintenance sweep), and the Journal row must
  // then reflect `accepted`. Driving the real accept route rather than patching the vault keeps the
  // expectation derived from the production transition.
  it("reports the live status after a proposed capture is accepted elsewhere", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const ctx = context();
    const governed = depsFor(
      vault,
      evidenceStore,
      "governed-assist",
      modelFact("The user reviews release notes every Friday."),
    );

    await captureSalientFromTurn(
      governed,
      makeRequest("The user reviews release notes every Friday."),
      ctx,
      "gpt-test",
      "ok",
    );

    const proposed = recentCaptures(governed, 0);
    expect(proposed.map(({ outcome, currentStatus }) => [outcome, currentStatus])).toEqual([
      ["proposed", "proposed"],
    ]);
    const proposedId = proposed[0]?.memoryId;
    expect(proposedId).toBeDefined();

    const accepted = await handleAcceptMemoryProposal(
      makeRouteContext(`/api/memory/proposals/${String(proposedId)}/accept`, {}, proposedId),
      governed,
    );
    expect(accepted.status).toBe(200);

    const afterAccept = recentCaptures(governed, 0);
    // The capture-time audit outcome is history; only the live status moves.
    expect(afterAccept.map(({ outcome, currentStatus }) => [outcome, currentStatus])).toEqual([
      ["proposed", "accepted"],
    ]);
  });
});

// #2550: the realtime-voice turn learns exactly as the desktop text turn does — same mode
// branching, same hard denials, same novelty gate — but is distinguishable in the Journal via the
// "voice" initiatorSurface tag. This is the voice-passive-capture journey the AC demands.
describe("voice-passive-capture journey", () => {
  it("attributes a voice turn to the voice surface, mode-branches, refuses secrets, and absorbs a repeat", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const ctx = context();
    const since = 0;
    const governed = depsFor(
      vault,
      evidenceStore,
      "governed-assist",
      modelFact("The user prefers stand-ups at 9am."),
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
      modelFact("The user's timezone is UTC+1."),
    );

    await captureSalientFromTurn(
      governed,
      makeRequest("The user prefers stand-ups at 9am."),
      ctx,
      "gpt-test",
      "ok",
      "voice",
    );
    await captureSalientFromTurn(
      autonomous,
      makeRequest("The user's timezone is UTC+1."),
      ctx,
      "gpt-test",
      "ok",
      "voice",
    );
    await captureSalientFromTurn(
      supervised,
      makeRequest(SECRET_TURN),
      ctx,
      "gpt-test",
      "ok",
      "voice",
    );

    const captured = recentCaptures(autonomous, since);
    expect(captured.map(({ outcome, mode }) => [outcome, mode])).toEqual([
      ["rejected", "supervised-coding"],
      ["auto-accepted", "autonomous-delivery"],
      ["proposed", "governed-assist"],
    ]);
    // Every voice-originated decision (captured or refused) carries the "voice" surface tag —
    // never the desktop "conversation-center" tag — so the Journal can tell them apart.
    expect(captured.every((capture) => capture.provenance.initiatorSurface === "voice")).toBe(true);
    expect(JSON.stringify(captured)).not.toContain(SECRET_MARKER);

    // A second, identical voice turn is absorbed by the novelty gate: the Journal count for the
    // autonomous-delivery fact does not double.
    await captureSalientFromTurn(
      autonomous,
      makeRequest("The user's timezone is UTC+1."),
      ctx,
      "gpt-test",
      "ok",
      "voice",
    );
    const afterRepeat = recentCaptures(autonomous, since);
    expect(afterRepeat).toHaveLength(captured.length);
    expect(afterRepeat.filter((capture) => capture.outcome === "auto-accepted")).toHaveLength(1);

    // The pre-existing desktop path is unaffected: an equivalent desktop-surface turn still tags
    // "conversation-center", proving the two surfaces stay distinguishable in both directions.
    const autonomousDesktop = depsFor(
      vault,
      evidenceStore,
      "autonomous-delivery",
      modelFact("The desktop client shows a status bar."),
    );
    await captureSalientFromTurn(
      autonomousDesktop,
      makeRequest("The desktop client shows a status bar."),
      ctx,
      "gpt-test",
      "ok",
    );
    const withDesktop = recentCaptures(autonomous, since);
    const desktopDecision = withDesktop.find(
      (capture) => capture.provenance.initiatorSurface === "conversation-center",
    );
    expect(desktopDecision).toBeDefined();
  });
});
