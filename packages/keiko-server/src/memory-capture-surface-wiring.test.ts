// Issue #2550 reachability pin. The sibling `voice-passive-capture journey`
// (memory-capture-projection.journey.test.ts) proves everything DOWNSTREAM of the capture-surface
// parameter by handing `captureSalientFromTurn` the literal "voice" itself — a test-only seam. That
// leaves the decisive question unanswered: does anything in the product ever pass it? Before this
// pin both production call sites hardcoded "desktop" and no wire field could carry the origin, so
// every voice-originated capture was filed as desktop and the Journal could not tell them apart —
// while the journey test stayed green. These assertions drive the real post-commit chat side effects
// and therefore fail on that shape.
//
// Realtime Voice never routes its transcript through the control socket (voice-realtime.ts): a
// settled spoken final is answered by this same canonical chat pipeline, so the origin cannot be
// inferred server-side and must be declared on the request.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type {
  ConversationId,
  MemoryReviewerId,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { ConversationMemoryResultWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  createMemoryAuditDeleteCommitHandler,
  createMemoryAuditHandler,
} from "./memory-audit-handler.js";
import {
  parseMemoryRequest,
  runPostCommitCanonicalTurnMemorySideEffects,
  runPostCommitConversationMemorySideEffects,
  type SendDesktopChatRequest,
} from "./chat-handlers.js";
import { handleListMemories } from "./memory-handlers.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

interface RecentCaptureWire {
  readonly outcome: "captured" | "proposed" | "auto-accepted" | "rejected";
  readonly provenance: { readonly initiatorSurface: string };
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
          requestId: "capture-surface-wiring",
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
    { source: "user", body, type: "fact", confidence: 0.8, scope: "project", tags: ["surface"] },
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

function makeVault(
  evidenceStore: ReturnType<typeof createInMemoryEvidenceStore>,
): MemoryVaultStore {
  const memoryDir = mkdtempSync(join(tmpdir(), "keiko-capture-surface-"));
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
    codingRuntimeDeploymentCeiling: "autonomous-delivery",
  };
}

function makeRouteContext(path: string): RouteContext {
  return {
    req: Readable.from([Buffer.from("{}")]) as unknown as IncomingMessage,
    res: { socket: new Socket() } as unknown as RouteContext["res"],
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function recentCaptures(deps: UiHandlerDeps): readonly RecentCaptureWire[] {
  const result = handleListMemories(makeRouteContext("/api/memory?since=0&order=desc"), deps);
  expect(result.status).toBe(200);
  return (result.body as { readonly captures: readonly RecentCaptureWire[] }).captures;
}

const EMPTY_MEMORY_RESULT: ConversationMemoryResultWire = {
  context: { enabled: true, text: "", memories: [], budget: { tokens: 0, used: 0 } },
  actions: [],
};

function sendRequest(content: string, surface?: "desktop" | "voice"): SendDesktopChatRequest {
  return {
    content,
    memory: { enabled: true, ...(surface === undefined ? {} : { surface }) },
  } as unknown as SendDesktopChatRequest;
}

async function surfaceOfSingleCapture(deps: UiHandlerDeps): Promise<string> {
  let captures: readonly RecentCaptureWire[] = [];
  await vi.waitFor(() => {
    captures = recentCaptures(deps);
    expect(captures).toHaveLength(1);
  });
  return captures[0]?.provenance.initiatorSurface ?? "";
}

describe("conversation memory capture-surface wire", () => {
  it("carries a declared surface and omits the key entirely when absent", () => {
    expect(
      parseMemoryRequest({ enabled: true, surface: "voice", context: { userId: "local" } }),
    ).toEqual({ enabled: true, surface: "voice", context: { userId: "local" } });
    // Byte-identical legacy shape: an un-migrated caller gains no new key.
    expect(
      parseMemoryRequest({ enabled: true, budgetTokens: 800, context: { userId: "local" } }),
    ).toEqual({ enabled: true, budgetTokens: 800, context: { userId: "local" } });
  });

  it("fails closed on an unrecognised surface rather than degrading to desktop", () => {
    expect(
      parseMemoryRequest({ enabled: true, surface: "telepathy", context: { userId: "local" } }),
    ).toMatchObject({ status: 400 });
    expect(
      parseMemoryRequest({ enabled: true, surface: "", context: { userId: "local" } }),
    ).toMatchObject({ status: 400 });
  });
});

describe("post-commit capture-surface attribution", () => {
  it("files a voice-declared desktop-chat turn under the voice audit surface", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const deps = depsFor(vault, evidenceStore, modelFact("The user prefers stand-ups at 9am."));

    runPostCommitConversationMemorySideEffects(
      deps,
      sendRequest("Let's keep doing morning stand-ups.", "voice"),
      context(),
      "gpt-test",
      EMPTY_MEMORY_RESULT,
      "ok",
      "correlation-voice",
    );

    expect(await surfaceOfSingleCapture(deps)).toBe("voice");
  });

  it("keeps an undeclared turn on the desktop audit surface", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const deps = depsFor(vault, evidenceStore, modelFact("The user's timezone is UTC+1."));

    runPostCommitConversationMemorySideEffects(
      deps,
      sendRequest("I'm on UTC+1 this week."),
      context(),
      "gpt-test",
      EMPTY_MEMORY_RESULT,
      "ok",
      "correlation-desktop",
    );

    expect(await surfaceOfSingleCapture(deps)).toBe("conversation-center");
  });

  it("files a voice-declared canonical (grounded) turn under the voice audit surface", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const deps = depsFor(vault, evidenceStore, modelFact("The user ships on Fridays."));

    runPostCommitCanonicalTurnMemorySideEffects(
      deps,
      {
        chatId: "conversation-a",
        projectPath: "project-a",
        messages: [
          { role: "user", content: "We ship on Fridays." },
          { role: "assistant", content: "Noted." },
        ],
        modelId: "gpt-test",
        memory: { enabled: true, surface: "voice", context: { userId: context().userId } },
      },
      context(),
      "gpt-test",
      EMPTY_MEMORY_RESULT,
      "ok",
      "correlation-voice-canonical",
    );

    expect(await surfaceOfSingleCapture(deps)).toBe("voice");
  });
});
