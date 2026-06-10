// Integration tests for the Conversation Center → QI run handoff (Epic #270, Issue #281).
//
// A "design-tests" handoff over a chat with a connected folder must START a real QI run (background)
// and return its run id; other actions or a chat with no connected folder must not. The background
// run reuses executeQiRun (live-proven) — here we assert the synchronous handoff contract with a
// hand-rolled store + a model gateway that is intentionally absent, so the background run settles to
// "failed" without a network call while the handoff still returns the run id.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { RouteContext } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { ChatMessage } from "../../store/types.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { handleQiHandoff } from "../handoffRoutes.js";

const CHAT_ID = "chat-1";
const MSG_ID = "msg-1";

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

// Hand-rolled store exposing only the seams the handoff uses, so we control the connected folder.
function mockStore(connectedRoot: string | undefined): UiHandlerDeps["store"] {
  const message: ChatMessage = {
    id: MSG_ID,
    chatId: CHAT_ID,
    role: "user",
    content: "design tests",
    timestamp: 0,
  } as ChatMessage;
  const chat = {
    id: CHAT_ID,
    ...(connectedRoot !== undefined
      ? {
          connectedScope: {
            kind: "workspace-root",
            relativePaths: [],
            connectedAtMs: 0,
            root: connectedRoot,
          },
        }
      : {}),
  };
  return {
    findMessageById: (id: string) => (id === MSG_ID ? message : undefined),
    findChatById: (id: string) => (id === CHAT_ID ? (chat as never) : undefined),
    createMessage: (m: unknown) => ({ ...(m as object), id: "persisted-1" }) as ChatMessage,
  } as unknown as UiHandlerDeps["store"];
}

function deps(evidenceDir: string, connectedRoot: string | undefined): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: mockStore(connectedRoot),
    evidenceDir,
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

describe("QI Conversation Center handoff run-start (#281)", () => {
  let evidenceDir: string;
  let folder: string;

  beforeEach(() => {
    evidenceDir = mkdtempSync(join(tmpdir(), "qi-ho-ev-"));
    folder = mkdtempSync(join(tmpdir(), "qi-ho-src-"));
    writeFileSync(join(folder, "spec.md"), "The export must produce a CSV.\n", "utf8");
  });
  afterEach(() => {
    rmSync(evidenceDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it("starts a run and returns a run id for design-tests over a connected folder", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq(handoffBody("design-tests"))),
      deps(evidenceDir, folder),
    );
    expect(result.status).toBe(200);
    const body = result.body as { runId?: string; persistedMessageId: string };
    expect(body.persistedMessageId).toBe("persisted-1");
    expect(body.runId).toMatch(/^qi-run-/u);
  });

  it("does NOT start a run for design-tests when no folder is connected", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq(handoffBody("design-tests"))),
      deps(evidenceDir, undefined),
    );
    expect(result.status).toBe(200);
    expect((result.body as { runId?: string }).runId).toBeUndefined();
  });

  it("does NOT start a run for a non-design-tests action even with a connected folder", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq(handoffBody("validate-tests"))),
      deps(evidenceDir, folder),
    );
    expect(result.status).toBe(200);
    expect((result.body as { runId?: string }).runId).toBeUndefined();
  });

  it("404s for an unknown chat-message reference", async () => {
    const result = await handleQiHandoff(
      ctx(makeReq({ ...handoffBody("design-tests"), requestedByChatMessageId: "nope" })),
      deps(evidenceDir, folder),
    );
    expect(result.status).toBe(404);
  });
});
