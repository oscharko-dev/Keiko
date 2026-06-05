import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryId,
  MemoryRecord,
  MemoryUserId,
  MemoryWorkspaceId,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  handleListMemories,
  handleMemoryReviewQueue,
  handlePinMemory,
  handleRejectMemoryProposal,
} from "./memory-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";

function makeReq(payload: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
}

function makeCtx(
  path: string,
  payload: unknown,
  params: Record<string, string> = {},
): RouteContext {
  const socket = new Socket();
  return {
    req: makeReq(payload),
    res: { socket } as unknown as RouteContext["res"],
    params,
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function makeDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

let activeVaults: MemoryVaultStore[] = [];
let tmpDirs: string[] = [];

beforeEach(() => {
  activeVaults = [];
  tmpDirs = [];
});

afterEach(() => {
  for (const vault of activeVaults) {
    try {
      vault.close();
    } catch {
      // ignore
    }
  }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-memory-handlers-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function userId(value: string): MemoryUserId {
  return value as MemoryUserId;
}

function workspaceId(value: string): MemoryWorkspaceId {
  return value as MemoryWorkspaceId;
}

function makeMemory(id: string, body: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: memoryId(id),
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function asJson(result: RouteResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe("memory handlers", () => {
  it("lists memories across scopes and paginates after filtering", () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("global-1", "global"));
    vault.insertMemory(
      makeMemory("user-1", "user one", {
        scope: { kind: "user", userId: userId("u-1") },
        provenance: {
          sourceKind: "explicit-user-instruction",
          capturedAt: 2,
          confidence: 0.9,
          sensitivity: "restricted",
        },
        createdAt: 2,
        updatedAt: 2,
      }),
    );
    vault.insertMemory(
      makeMemory("user-2", "user two", {
        scope: { kind: "user", userId: userId("u-2") },
        provenance: {
          sourceKind: "explicit-user-instruction",
          capturedAt: 3,
          confidence: 0.9,
          sensitivity: "restricted",
        },
        createdAt: 3,
        updatedAt: 3,
      }),
    );
    vault.insertMemory(
      makeMemory("workspace-1", "workspace", {
        scope: { kind: "workspace", workspaceId: workspaceId("ws-1") },
        createdAt: 4,
        updatedAt: 4,
      }),
    );

    const result = handleListMemories(
      makeCtx("/api/memory?scope=user&sensitivity=restricted&limit=1&offset=1", {}),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.total).toBe(2);
    const memories = body.memories as readonly MemoryRecord[];
    expect(memories).toHaveLength(1);
    expect(memories[0]?.id).toBe("user-1");
  });

  it("includes non-global conflicts in the review queue", () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("conflict-1", "conflict", {
        scope: { kind: "workspace", workspaceId: workspaceId("ws-9") },
        status: "conflicted",
      }),
    );

    const result = handleMemoryReviewQueue(
      makeCtx("/api/memory/review-queue", {}),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.total).toBe(1);
    const memories = body.memories as readonly MemoryRecord[];
    expect(memories[0]?.id).toBe("conflict-1");
  });

  it("allows conflicted memories to be dismissed through the reject route", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("conflict-2", "dismiss me", { status: "conflicted" }));

    const result = await handleRejectMemoryProposal(
      makeCtx(
        "/api/memory/proposals/conflict-2/reject",
        { reason: "dismissed from queue" },
        { id: "conflict-2" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const body = asJson(result);
    const memory = body.memory as MemoryRecord;
    expect(memory.status).toBe("rejected");
    expect(memory.staleReason).toBe("dismissed from queue");
  });

  it("sanitises GovernanceError responses so the memory id is not leaked", () => {
    const vault = makeVault();
    const idValue = "leak-probe-7f3a1c";
    // Pre-pinned record causes buildPinOperation to throw GovernanceError("idempotent-noop", ...)
    // whose composed message embeds the memory id; the handler must not forward that message.
    vault.insertMemory(makeMemory(idValue, "already pinned", { pinned: true }));

    const result = handlePinMemory(
      makeCtx(`/api/memory/${idValue}/pin`, {}, { id: idValue }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(409);
    const body = asJson(result);
    const errorField = body.error as { code: string; message: string };
    expect(errorField.code).toBe("GOVERNANCE_ERROR");
    expect(errorField.message).toContain("idempotent-noop");
    expect(errorField.message).not.toContain("GovernanceError(");
    expect(errorField.message).not.toContain(idValue);
  });
});
