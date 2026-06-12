// Source-shaping tests for the Conversation Center → QI run handoff (Epic #270, Issue #281).
//
// These assert WHICH sources the background design-tests run is started with, closing the
// mutation-blindness of handoffRun.test.ts (which only checks the returned run-id shape). The
// handoff must ingest the chat's FULL connected workspace context — every connected folder root,
// not just the first (Epic #532/#729 multi-source) — so a single-line mutation in
// `resolveHandoffRunId` / `startHandoffRun` is caught here. `executeQiRun` is module-mocked to
// capture the request it receives without running the real model-routed workflow.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { RouteContext } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { ChatMessage } from "../../store/types.js";
import { buildRedactor, createRunRegistry } from "../../index.js";

interface CapturedSource {
  readonly kind: string;
  readonly path: string;
  readonly label?: string;
}

const capturedRequests: { sources: readonly CapturedSource[] }[] = [];

vi.mock("../runExecution.js", () => ({
  executeQiRun: vi.fn(
    (args: { request: { sources: readonly CapturedSource[] } }): Promise<{ status: string }> => {
      capturedRequests.push({ sources: args.request.sources });
      return Promise.resolve({ status: "succeeded" });
    },
  ),
}));

// Imported AFTER the mock declaration so the route binds to the mocked executeQiRun.
const { handleQiHandoff } = await import("../handoffRoutes.js");

const CHAT_ID = "chat-1";
const MSG_ID = "msg-1";

const scope = (root: string | undefined): Record<string, unknown> => ({
  kind: "workspace-root",
  relativePaths: [],
  connectedAtMs: 0,
  ...(root !== undefined ? { root } : {}),
});

// Build a store whose chat exposes the multi-source `connectedScopes` list and/or the legacy
// singular `connectedScope`, so we can drive each resolution branch.
function mockStore(chatShape: Record<string, unknown>): UiHandlerDeps["store"] {
  const message: ChatMessage = {
    id: MSG_ID,
    chatId: CHAT_ID,
    role: "user",
    content: "design tests",
    timestamp: 0,
  } as ChatMessage;
  const chat = { id: CHAT_ID, ...chatShape };
  return {
    findMessageById: (id: string) => (id === MSG_ID ? message : undefined),
    findChatById: (id: string) => (id === CHAT_ID ? (chat as never) : undefined),
    createMessage: (m: unknown) => ({ ...(m as object), id: "persisted-1" }) as ChatMessage,
  } as unknown as UiHandlerDeps["store"];
}

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function deps(chatShape: Record<string, unknown>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: mockStore(chatShape),
    evidenceDir: "/tmp/qi-ho-sources-unused",
  };
}

function makeReq(body: Record<string, unknown>): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
}

function ctx(req: IncomingMessage): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/quality-intelligence/handoff"),
  };
}

const handoffBody = (action: string): Record<string, unknown> => ({
  id: "handoff-1",
  requestedByChatMessageId: MSG_ID,
  promptedAction: action,
  payloadRef: { sourceEnvelopeIds: [] },
});

describe("QI handoff run source-shaping (#281)", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ingests EVERY connected workspace root (multi-source), not just the first", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq(handoffBody("design-tests"))),
      deps({ connectedScopes: [scope("/work/a"), scope("/work/b"), scope("/work/c")] }),
    );
    expect(result.status).toBe(200);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.sources.map((s) => s.path)).toEqual([
      "/work/a",
      "/work/b",
      "/work/c",
    ]);
    expect(capturedRequests[0]?.sources.every((s) => s.kind === "workspace")).toBe(true);
  });

  it("falls back to the legacy singular connectedScope when no list is present", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq(handoffBody("design-tests"))),
      deps({ connectedScope: scope("/work/legacy") }),
    );
    expect(result.status).toBe(200);
    expect(capturedRequests[0]?.sources.map((s) => s.path)).toEqual(["/work/legacy"]);
  });

  it("de-duplicates identical roots so a folder is ingested once", async () => {
    await handleQiHandoff(
      ctx(makeReq(handoffBody("design-tests"))),
      deps({ connectedScopes: [scope("/work/a"), scope("/work/a"), scope("/work/b")] }),
    );
    expect(capturedRequests[0]?.sources.map((s) => s.path)).toEqual(["/work/a", "/work/b"]);
  });

  it("skips non-folder scopes that carry no root", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq(handoffBody("design-tests"))),
      deps({ connectedScopes: [scope(undefined), scope("/work/only")] }),
    );
    expect(result.status).toBe(200);
    expect(capturedRequests[0]?.sources.map((s) => s.path)).toEqual(["/work/only"]);
  });

  it("does NOT start a run when every connected scope lacks a root", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq(handoffBody("design-tests"))),
      deps({ connectedScopes: [scope(undefined), scope(undefined)] }),
    );
    expect(result.status).toBe(200);
    expect(capturedRequests).toHaveLength(0);
    expect((result.body as { runId?: string }).runId).toBeUndefined();
  });
});
