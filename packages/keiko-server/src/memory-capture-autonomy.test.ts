// Mode-aware memory capture journey (issue #2546, Memory M1.1). Drives the REAL exported
// collectMemoryActions / captureSalientFromTurn against an in-process vault and a fake ModelPort —
// no network, no real model — and asserts ONLY content-free facts: statuses, counts, scopes,
// review-queue membership (through the exported handleMemoryReviewQueue projection), next-turn
// retrieval visibility (through the real accepted-only gatherExistingBodies dedup read), and the
// content-free secret-drop diagnostic. Requested modes are bounded by the validated, server-owned
// deps.codingRuntimeDeploymentCeiling (undefined fails closed to governed-assist).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { CodingWorkbenchMode, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  ConversationId,
  MemoryRecord,
  MemoryStatus,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { collectMemoryActions, type SendDesktopChatRequest } from "./chat-handlers.js";
import { captureSalientFromTurn } from "./memory-salience.js";
import { handleMemoryReviewQueue } from "./memory-handlers.js";
import type { RouteContext } from "./routes.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

// A single durable public fact. Body carries no regex-capture trigger (no remember/forget/update/
// correction/identity phrasing) so the deterministic regex path stays empty and the salience path
// is the ONLY writer — this is what the "persisted exactly once" counts depend on.
function publicFact(confidence: number): string {
  return JSON.stringify([
    {
      source: "user",
      body: "The platform team ships releases on a fortnightly cadence.",
      type: "fact",
      confidence,
      scope: "project",
      tags: ["release"],
    },
  ]);
}

const CONFIDENTIAL_FACT = JSON.stringify([
  {
    source: "user",
    body: "The escalation contact address is oncall@example.com.",
    type: "fact",
    confidence: 0.7,
    scope: "user",
    tags: ["contact"],
  },
]);

const SECRET_BODY = "The staging login uses password=FAKE-TEST-PLACEHOLDER-VALUE.";
const SECRET_TOKEN = "FAKE-TEST-PLACEHOLDER-VALUE";

// A single credential-shaped item. The secret net drops it inside candidateBody before any mode
// logic, so nothing is persisted in any mode.
const SECRET_ONLY = JSON.stringify([
  {
    source: "user",
    body: SECRET_BODY,
    type: "fact",
    confidence: 0.8,
    scope: "project",
    tags: ["ops"],
  },
]);

// User text is clean: no secret (egress guard passes → model is consulted) and no regex-capture
// trigger (deterministic path stays empty).
const USER_TEXT = "We reviewed the deployment configuration for the platform team today.";

const ALL_MODES: readonly CodingWorkbenchMode[] = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
];

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
          requestId: "autonomy-test",
          promptTokens: 7,
          completionTokens: 3,
          latencyMs: 11,
          costClass: "high",
        },
      });
    },
  };
}

let activeVaults: MemoryVaultStore[] = [];
let tmpDirs: string[] = [];

beforeEach(() => {
  activeVaults = [];
  tmpDirs = [];
});

afterEach(() => {
  for (const v of activeVaults) {
    try {
      v.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-autonomy-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

// A Map-backed evidence store so a test can read back the audit ledger the capture path wrote —
// both to prove a decision WAS recorded and to prove no body leaked into it.
function capturingEvidenceStore(): {
  readonly store: UiHandlerDeps["evidenceStore"];
  readonly serialized: () => string;
} {
  const runs = new Map<string, string>();
  return {
    store: {
      put: (runId: string, json: string): string => {
        runs.set(runId, json);
        return runId;
      },
      get: (runId: string): string | undefined => runs.get(runId),
      list: (): readonly string[] => [...runs.keys()],
      delete: (runId: string): void => {
        runs.delete(runId);
      },
    },
    serialized: (): string => JSON.stringify([...runs.values()]),
  };
}

interface DepsOptions {
  readonly vault: MemoryVaultStore;
  readonly model: string;
  readonly mode?: CodingWorkbenchMode;
  readonly diagnostics?: UiHandlerDeps["diagnostics"];
  readonly evidenceStore?: UiHandlerDeps["evidenceStore"];
}

function makeDeps(options: DepsOptions): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: options.evidenceStore ?? {
      put: () => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => fakeModel(options.model),
    store: createInMemoryUiStore(),
    memoryVault: options.vault,
    ...(options.mode !== undefined ? { codingRuntimeDeploymentCeiling: options.mode } : {}),
    ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
  };
}

function context(): ConversationMemoryRuntimeContext {
  const path = mkdtempSync(join(tmpdir(), "keiko-autonomy-proj-"));
  tmpDirs.push(path);
  return {
    userId: "local-operator" as UserId,
    workspaceId: path as WorkspaceId,
    projectId: path as ProjectId,
    conversationId: "chat-1" as ConversationId,
  };
}

function turnRequest(content: string): SendDesktopChatRequest {
  return { content, memory: { enabled: true } } as unknown as SendDesktopChatRequest;
}

async function runTurn(
  deps: UiHandlerDeps,
  ctx: ConversationMemoryRuntimeContext,
  content: string,
): Promise<readonly unknown[]> {
  const request = turnRequest(content);
  const deterministic = await collectMemoryActions(deps, request, ctx);
  // Canonical chat now starts fallible model-assisted salience only after the Assistant commit.
  // Drive that post-commit phase explicitly so this journey remains deterministic and never infers
  // completion from a background timer.
  const salient = await captureSalientFromTurn(deps, request, ctx, "gpt-test", "ok");
  return [...deterministic, ...salient];
}

function readMemories(
  vault: MemoryVaultStore,
  ctx: ConversationMemoryRuntimeContext,
): readonly MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  for (const scope of conversationMemoryScopes(ctx)) {
    for (const record of vault.listMemoriesByScope(scope)) {
      byId.set(String(record.id), record);
    }
  }
  return [...byId.values()];
}

function readByStatus(
  vault: MemoryVaultStore,
  ctx: ConversationMemoryRuntimeContext,
  status: MemoryStatus,
): readonly MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const scope of conversationMemoryScopes(ctx)) {
    records.push(...vault.listMemoriesByScope(scope, { status: [status] }));
  }
  return records;
}

// handleMemoryReviewQueue reads only deps (its ctx parameter is unused), so a minimal stub keeps
// the projection call hermetic while still exercising the real exported server handler.
function reviewQueueContext(): RouteContext {
  return {
    params: {},
    url: new URL("http://127.0.0.1/api/memory/review-queue"),
  } as unknown as RouteContext;
}

// Content-free view of the real review-queue projection: how many entries and their statuses only.
function reviewQueueProjection(deps: UiHandlerDeps): {
  readonly total: number;
  readonly statuses: readonly string[];
} {
  const result = handleMemoryReviewQueue(reviewQueueContext(), deps);
  expect(result.status).toBe(200);
  const body = result.body as {
    readonly total: number;
    readonly memories: readonly { readonly status: string }[];
  };
  return { total: body.total, statuses: body.memories.map((memory) => memory.status) };
}

// A one-turn salience request. Driving captureSalientFromTurn directly (vs the background
// collectMemoryActions path) makes multi-turn retrieval sequencing deterministic and awaitable.
function salienceRequest(mode?: CodingWorkbenchMode): {
  readonly content: string;
  readonly memory: { readonly enabled: boolean; readonly mode?: CodingWorkbenchMode };
} {
  return {
    content: USER_TEXT,
    memory: { enabled: true, ...(mode === undefined ? {} : { mode }) },
  };
}

interface SalienceDiagnosticPayload {
  readonly kind?: string;
  readonly rawItemCount?: number;
}

function recordingDiagnosticsSink(): ServerDiagnosticSink & {
  readonly record: ReturnType<typeof vi.fn<(record: ServerDiagnosticRecord) => void>>;
} {
  return { record: vi.fn() };
}

// Extracts the content-free "SalienceExtractionDiagnostic" records a spy diagnostics sink
// captured. logSalienceDiagnostic emits counts/kind only — never bodies — as a plain
// "model=... kind=<kind> rawItemCount=<n>" message, so a regex read keeps the assertion
// content-free without depending on the message's exact wording.
function capturedSalienceDiagnostics(
  calls: readonly (readonly unknown[])[],
): readonly SalienceDiagnosticPayload[] {
  const payloads: SalienceDiagnosticPayload[] = [];
  for (const args of calls) {
    const record = args[0] as { readonly errorClass?: string; readonly message?: string };
    if (record.errorClass !== "SalienceExtractionDiagnostic") continue;
    const message = record.message ?? "";
    const kind = /kind=(\S+)/u.exec(message)?.[1];
    const rawItemCountMatch = /rawItemCount=(\d+)/u.exec(message)?.[1];
    payloads.push({
      ...(kind === undefined ? {} : { kind }),
      ...(rawItemCountMatch === undefined ? {} : { rawItemCount: Number(rawItemCountMatch) }),
    });
  }
  return payloads;
}

// Yields to the event loop so a background capture that has already made the record visible can
// finish its remaining synchronous tail (summary log + bookkeeping) before the vault is closed in
// afterEach. Deterministic — no wall-clock sleep.
function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function waitForCount(
  vault: MemoryVaultStore,
  ctx: ConversationMemoryRuntimeContext,
  count: number,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(readMemories(vault, ctx)).toHaveLength(count);
    },
    { timeout: 4000, interval: 25 },
  );
  await drainMicrotasks();
  await drainMicrotasks();
}

describe("mode-aware memory capture journey", () => {
  it("auto-accepts explicit remember intent under autonomous delivery", async () => {
    const vault = makeVault();
    const evidence = capturingEvidenceStore();
    const deps = makeDeps({
      vault,
      model: "[]",
      mode: "autonomous-delivery",
      evidenceStore: evidence.store,
    });
    const ctx = context();
    const request = {
      ...turnRequest("Remember that release hardening uses vitest"),
      clientTurnId: "canonical-auto-accept",
    };

    const actions = await collectMemoryActions(deps, request, ctx);
    const replay = await collectMemoryActions(deps, request, ctx);

    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "candidate", requiresApproval: false, status: "accepted" }),
    );
    expect(replay).toContainEqual(expect.objectContaining({ status: "accepted" }));
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(1);
    const ledger = evidence.serialized();
    expect(ledger.match(/governance-auto-accepted/gu)).toHaveLength(1);
    expect(ledger).not.toContain("release hardening uses vitest");
  });

  it("rejects explicit recapture of a forgotten body", async () => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: "[]" });
    const ctx = context();
    const request = turnRequest("Remember that release hardening uses vitest");
    await collectMemoryActions(deps, request, ctx);
    const existing = readMemories(vault, ctx)[0];
    if (existing === undefined) throw new Error("expected captured memory");
    vault.deleteMemory(existing.id, {
      tombstone: true,
      forgetterSurface: "test",
      reason: "user-request",
      nowMs: existing.updatedAt + 1,
    });

    const actions = await collectMemoryActions(deps, request, ctx);

    expect(actions).toEqual([{ kind: "rejected", reason: "suppressed-by-forget" }]);
    expect(readMemories(vault, ctx)).toHaveLength(0);
  });

  it("keeps a routine public fact proposed under governed-assist (legacy default deps)", async () => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: publicFact(0.7) });
    const ctx = context();
    await runTurn(deps, ctx, USER_TEXT);
    await waitForCount(vault, ctx, 1);
    const [record] = readMemories(vault, ctx);
    expect(record?.status).toBe("proposed");
    expect(record?.provenance.sensitivity).toBe("public");
    expect(readByStatus(vault, ctx, "proposed")).toHaveLength(1);
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(0);
    // AC: the governed-assist fact surfaces as a single proposal in the review-queue projection.
    const queue = reviewQueueProjection(deps);
    expect(queue.total).toBe(1);
    expect(queue.statuses).toEqual(["proposed"]);
  });

  it("auto-accepts a routine public fact under supervised-coding (confidence >= promote floor)", async () => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: publicFact(0.7), mode: "supervised-coding" });
    const ctx = context();
    const actions = await runTurn(deps, ctx, USER_TEXT);
    await waitForCount(vault, ctx, 1);
    const [record] = readMemories(vault, ctx);
    expect(record?.status).toBe("accepted");
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(1);
    expect(readByStatus(vault, ctx, "proposed")).toHaveLength(0);
    // AC complement: an auto-accepted fact is NOT surfaced in the review queue (accepted is not a
    // review-queue status), so the operator sees nothing pending for it.
    expect(reviewQueueProjection(deps).total).toBe(0);
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "candidate", status: "accepted" }),
    );
  });

  it("auto-accepts a routine public fact under autonomous-delivery", async () => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: publicFact(0.7), mode: "autonomous-delivery" });
    const ctx = context();
    await runTurn(deps, ctx, USER_TEXT);
    await waitForCount(vault, ctx, 1);
    const [record] = readMemories(vault, ctx);
    expect(record?.status).toBe("accepted");
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(1);
    expect(readByStatus(vault, ctx, "proposed")).toHaveLength(0);
  });

  it("uses the request mode without allowing it to exceed the server deployment ceiling", async () => {
    const allowedVault = makeVault();
    const allowedDeps = makeDeps({
      vault: allowedVault,
      model: publicFact(0.7),
      mode: "autonomous-delivery",
    });
    const allowedContext = context();
    await captureSalientFromTurn(
      allowedDeps,
      salienceRequest("supervised-coding"),
      allowedContext,
      "gpt-test",
      "ok",
    );
    expect(readMemories(allowedVault, allowedContext)[0]?.status).toBe("accepted");

    const cappedVault = makeVault();
    const cappedDeps = makeDeps({ vault: cappedVault, model: publicFact(0.7) });
    const cappedContext = context();
    await captureSalientFromTurn(
      cappedDeps,
      salienceRequest("autonomous-delivery"),
      cappedContext,
      "gpt-test",
      "ok",
    );
    expect(readMemories(cappedVault, cappedContext)[0]?.status).toBe("proposed");
  });

  it("keeps a low-confidence public fact proposed under supervised-coding (shouldPromote gate holds)", async () => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: publicFact(0.3), mode: "supervised-coding" });
    const ctx = context();
    await runTurn(deps, ctx, USER_TEXT);
    await waitForCount(vault, ctx, 1);
    const [record] = readMemories(vault, ctx);
    expect(record?.status).toBe("proposed");
    expect(readByStatus(vault, ctx, "proposed")).toHaveLength(1);
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(0);
  });

  it.each(ALL_MODES)("keeps a confidential fact proposed under %s", async (mode) => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: CONFIDENTIAL_FACT, mode });
    const ctx = context();
    await runTurn(deps, ctx, USER_TEXT);
    await waitForCount(vault, ctx, 1);
    const [record] = readMemories(vault, ctx);
    expect(record?.status).toBe("proposed");
    expect(record?.provenance.sensitivity).toBe("confidential");
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(0);
  });

  it.each(ALL_MODES)(
    "drops a secret body with zero records and one content-free diagnostic under %s",
    async (mode) => {
      const vault = makeVault();
      const diagnostics = recordingDiagnosticsSink();
      const deps = makeDeps({ vault, model: SECRET_ONLY, mode, diagnostics });
      const ctx = context();
      // captureSalientFromTurn is awaited directly (like the throwing test) so the secret-drop
      // path settles deterministically before assertions.
      const actions = await captureSalientFromTurn(deps, salienceRequest(), ctx, "gpt-test", "ok");
      expect(actions).toEqual([]);
      expect(readMemories(vault, ctx)).toHaveLength(0);
      // AC "one content-free rejection outcome": the secret net drops the body silently inside
      // candidateBody — there is deliberately NO dropped-model-items reason for secrets (that enum
      // is source/type/scope only) and NO "rejected" wire action on the salience path (that kind
      // is reserved for restricted/tombstone). The faithful content-free signal is therefore the
      // "zero-candidates-after-filter" salience diagnostic: the model produced >= 1 raw item and
      // zero survived filtering. Counts only, never the secret body.
      const dropSignal = capturedSalienceDiagnostics(diagnostics.record.mock.calls).find(
        (payload) => payload.kind === "zero-candidates-after-filter",
      );
      expect(dropSignal).toBeDefined();
      expect(dropSignal?.rawItemCount ?? 0).toBeGreaterThanOrEqual(1);
      // Content-free: no diagnostic record leaks the secret body.
      expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain(SECRET_TOKEN);
    },
  );

  it("holds a proposed fact out of retrieval AND does not re-propose it on the next turn", async () => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: publicFact(0.7) }); // governed-assist (no ceiling)
    const ctx = context();
    const first = await captureSalientFromTurn(deps, salienceRequest(), ctx, "gpt-test", "ok");
    expect(first).toHaveLength(1);
    expect(readByStatus(vault, ctx, "proposed")).toHaveLength(1);
    // The record stays UNRETRIEVABLE: nothing is accepted in governed-assist, and retrieval reads
    // accepted-only (keiko-memory-retrieval suppression.ts pins that separately).
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(0);
    // ...but the capture dedup corpus DOES see the proposal, so re-emitting the same fact next turn
    // reinforces the pending review item instead of queueing the operator a second copy of it.
    const second = await captureSalientFromTurn(deps, salienceRequest(), ctx, "gpt-test", "ok");
    expect(second).toEqual([]);
    expect(readMemories(vault, ctx)).toHaveLength(1);
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(0);
    expect(reviewQueueProjection(deps).total).toBe(1);
  });

  it("does not re-propose a fact the operator rejected, and audits the refusal", async () => {
    const vault = makeVault();
    const evidence = capturingEvidenceStore();
    const deps = makeDeps({ vault, model: publicFact(0.7), evidenceStore: evidence.store });
    const ctx = context();
    await captureSalientFromTurn(deps, salienceRequest(), ctx, "gpt-test", "ok");
    const proposal = readMemories(vault, ctx)[0];
    if (proposal === undefined) throw new Error("expected one captured proposal");
    // The operator rejects it in the review queue.
    vault.updateMemory(
      proposal.id,
      { status: "rejected", staleReason: "rejected from review queue" },
      Date.now(),
    );
    expect(reviewQueueProjection(deps).total).toBe(0);

    // The extractor re-derives the identical fact from ordinary conversation on a later turn.
    const second = await captureSalientFromTurn(deps, salienceRequest(), ctx, "gpt-test", "ok");
    expect(second).toEqual([{ kind: "rejected", reason: "suppressed-by-rejection" }]);
    expect(readByStatus(vault, ctx, "proposed")).toHaveLength(0);
    expect(readMemories(vault, ctx)).toHaveLength(1);
    expect(reviewQueueProjection(deps).total).toBe(0);
    // The refusal is auditable, and the audit trail still carries no body.
    const ledger = evidence.serialized();
    expect(ledger).toContain("suppressed-by-rejection");
    expect(ledger).not.toContain("fortnightly cadence");
  });

  it("surfaces a supervised-accepted fact in the next turn's retrieval snapshot", async () => {
    const vault = makeVault();
    const deps = makeDeps({ vault, model: publicFact(0.7), mode: "supervised-coding" });
    const ctx = context();
    const first = await captureSalientFromTurn(deps, salienceRequest(), ctx, "gpt-test", "ok");
    expect(first).toHaveLength(1);
    expect(readByStatus(vault, ctx, "accepted")).toHaveLength(1);
    // The ACCEPTED fact IS in the accepted-only retrieval snapshot, so re-emitting it next turn is
    // deduped by gatherExistingBodies — nothing new is captured and the count stays at one.
    const second = await captureSalientFromTurn(deps, salienceRequest(), ctx, "gpt-test", "ok");
    expect(second).toEqual([]);
    expect(readMemories(vault, ctx)).toHaveLength(1);
  });

  it("leaves the turn well-formed and writes nothing when the model throws", async () => {
    const vault = makeVault();
    const throwingModel: ModelPort = {
      call() {
        return Promise.reject(new Error("model exploded"));
      },
    };
    const deps = makeDeps({ vault, model: publicFact(0.7), mode: "autonomous-delivery" });
    const ctx = context();
    // collectMemoryActions returns synchronously well-formed (regex path is empty).
    const actions = await runTurn(
      { ...deps, modelPortFactory: () => throwingModel },
      ctx,
      USER_TEXT,
    );
    expect(actions).toEqual([]);
    // The salience boundary swallows the throw and persists nothing (awaited directly for a
    // deterministic settle — the failure-containment invariant, mode-independent).
    const salience = await captureSalientFromTurn(
      { ...deps, modelPortFactory: () => throwingModel },
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(salience).toEqual([]);
    expect(readMemories(vault, ctx)).toHaveLength(0);
  });
});
