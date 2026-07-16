import { describe, expect, it, vi } from "vitest";

import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentChangeset,
} from "@oscharko-dev/keiko-contracts";
import { EditorAgentHttpClient } from "@oscharko-dev/keiko-tools";

import { createCodingToolReadEditPorts } from "./codingToolReadEditPorts.js";

const DIGEST = "a".repeat(64);
const SENTINEL = "RAW_PATH_CONTENT_PATCH_CAPABILITY_SENTINEL";

const admittedBinding = {
  runId: "run-authority-a",
  envelopeDigest: DIGEST,
  workspaceId: "workspace-authority-a",
  workspaceRootDigest: DIGEST,
  expiresAt: "2026-07-12T12:00:00.000Z",
};

function changeset(): EditorAgentChangeset {
  return {
    patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
    files: [{ file: "src/a.ts", expectedContentHash: DIGEST }],
  };
}

describe("CodingTool read/edit producer adapters (Issue #2332)", () => {
  it("uses only SecureWorkspaceTextReadPort and exposes the sole bounded content-bearing read result", async () => {
    const readText = vi.fn(() =>
      Promise.resolve({ ok: true as const, text: "const value = 1;\n" }),
    );
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    const result = await ports.repositoryRead.execute(
      { action: "read", actionId: "read-1", idempotencyKey: "read-key", relativePath: "src/a.ts" },
      undefined,
      { check: (): true => true },
    );

    expect(readText).toHaveBeenCalledWith({ relativePath: "src/a.ts", signal: undefined });
    expect(editorAction).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "completed",
      read: {
        text: "const value = 1;\n",
        byteCount: Buffer.byteLength("const value = 1;\n", "utf8"),
        digest: "8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d",
      },
    });
  });

  it("returns content-free read failures and cancellation without calling a writer", async () => {
    const readText = vi.fn(() =>
      Promise.resolve({ ok: false as const, reason: "cancelled" as const }),
    );
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    const result = await ports.repositoryRead.execute(
      { action: "read", actionId: "read-1", idempotencyKey: "read-key", relativePath: "src/a.ts" },
      undefined,
      { check: (): true => true },
    );

    expect(result).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(editorAction).not.toHaveBeenCalled();
  });

  it("fails closed when a compromised read port returns more than 65,536 bytes", async () => {
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: {
        readText: () => Promise.resolve({ ok: true, text: "x".repeat(65_537) }),
      },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-1",
          idempotencyKey: "read-key",
          relativePath: "src/a.ts",
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(editorAction).not.toHaveBeenCalled();
  });

  it.each([".env", ".ENV", "nested/.env", "nested/.ENV"])(
    "checks canonical sensitive-path denial immediately before the secure reader for %s",
    async (relativePath) => {
      const readText = vi.fn(() => Promise.resolve({ ok: true as const, text: "SECRET" }));
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText },
        editorAgentClient: { action: vi.fn() },
        resolveEditorActionContext: () => ({
          sessionId: "session-2332",
          authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
          origin: "agent",
        }),
      });

      await expect(
        ports.repositoryRead.execute(
          { action: "read", actionId: "read-1", idempotencyKey: "read-key", relativePath },
          undefined,
          { check: (): true => true },
        ),
      ).resolves.toEqual({ status: "failed" });
      expect(readText).not.toHaveBeenCalled();
    },
  );

  it("carries the admitted immutable binding to the read producer and denies a cross-wired workspace", async () => {
    const readText = vi.fn(() => Promise.resolve({ ok: true as const, text: "SECRET" }));
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-editor-b", envelopeDigest: "b".repeat(64) },
        origin: "agent",
      }),
      // Issue #2332: the read producer must receive the same trusted binding as its admission.
      resolveRepositoryReadContext: () => ({
        runId: "run-reader-b",
        envelopeDigest: "b".repeat(64),
        workspaceId: "workspace-reader-b",
        workspaceRootDigest: "b".repeat(64),
        expiresAt: "2026-07-12T12:00:00.000Z",
      }),
    } as never);

    await expect(
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-1",
          idempotencyKey: "read-key",
          relativePath: "src/a.ts",
        },
        undefined,
        { check: (): true => true, binding: admittedBinding },
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(readText).not.toHaveBeenCalled();
  });

  it("sends a validated changeset through the existing editor action client with server-attached identity", async () => {
    let adapterSignal: AbortSignal | undefined;
    const editorAction = vi.fn((_action: EditorAgentAction, signal: AbortSignal) => {
      adapterSignal = signal;
      return Promise.resolve({
        ok: true as const,
        value: {
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: "edit-1",
            sessionId: "session-2332",
            status: "queued" as const,
          },
        },
      });
    });
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await ports.editorChangeset.execute(
      {
        action: "edit",
        actionId: "edit-1",
        idempotencyKey: "edit-key",
        changeset: changeset(),
      },
      undefined,
      { check: (): true => true },
    );

    expect(editorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "edit-1",
        idempotencyKey: "edit-key",
        sessionId: "session-2332",
        type: "applyChangeset",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
        changeset: changeset(),
      }),
      adapterSignal,
    );
    expect(adapterSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed changesets or a revoked final guard before queueing an editor action", async () => {
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "bad",
          idempotencyKey: "bad",
          changeset: { patch: "x", files: [] },
        },
        undefined,
        { check: (): false => false },
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(editorAction).not.toHaveBeenCalled();
  });

  it("carries the admitted immutable binding to the editor producer and denies a cross-wired editor context", async () => {
    const editorAction = vi.fn(() => Promise.resolve({ ok: true, value: { status: "queued" } }));
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-cross-wired",
        authorityRef: { runId: "run-editor-b", envelopeDigest: "b".repeat(64) },
        origin: "agent",
        workspaceId: "workspace-editor-b",
        workspaceRootDigest: "b".repeat(64),
        expiresAt: "2026-07-12T12:00:00.000Z",
      }),
    } as never);

    await expect(
      ports.editorChangeset.execute(
        { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
        undefined,
        { check: (): true => true, binding: admittedBinding },
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(editorAction).not.toHaveBeenCalled();
  });

  it.each([
    [200, "queued", "completed"],
    [200, "succeeded", "completed"],
    [200, "failed", "failed"],
    [200, "conflict", "failed"],
    [403, "conflict", "failed"],
    [409, "conflict", "failed"],
    [429, "failed", "failed"],
  ] as const)(
    "uses the real EditorAgentHttpClient with an adapter-owned signal and maps HTTP %s/%s to %s",
    async (httpStatus, editorStatus, expectedStatus) => {
      let adapterSignal: AbortSignal | undefined;
      const client = new EditorAgentHttpClient({
        baseUrl: "http://127.0.0.1:1983",
        transport: {
          request: (
            request,
          ): Promise<{
            readonly status: number;
            readonly body: Uint8Array;
            readonly url: string;
            readonly redirected: boolean;
          }> => {
            adapterSignal = request.signal;
            return Promise.resolve({
              status: httpStatus,
              body: Buffer.from(
                JSON.stringify({
                  result: {
                    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
                    actionId: "edit-1",
                    sessionId: "session-2332",
                    status: editorStatus,
                  },
                }),
              ),
              url: request.url,
              redirected: false,
            });
          },
        },
      });
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: client,
        resolveEditorActionContext: () => ({
          sessionId: "session-2332",
          authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
          origin: "agent",
        }),
      } as never);

      await expect(
        ports.editorChangeset.execute(
          {
            action: "edit",
            actionId: "edit-1",
            idempotencyKey: "edit-key",
            changeset: changeset(),
          },
          undefined,
          { check: (): true => true },
        ),
      ).resolves.toEqual({ status: expectedStatus });
      expect(adapterSignal).toBeInstanceOf(AbortSignal);
    },
  );

  it("rejects an adapter-owned editor-client timeout without content and without a caller signal", async () => {
    let adapterSignal: AbortSignal | undefined;
    const client = new EditorAgentHttpClient({
      baseUrl: "http://127.0.0.1:1983",
      transport: {
        request: (request): Promise<never> => {
          adapterSignal = request.signal;
          return new Promise(() => undefined);
        },
      },
      scheduler: {
        set: (callback): string => {
          callback();
          return "timeout";
        },
        clear: (): void => undefined,
      },
    });
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: client,
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    } as never);

    const result = await ports.editorChangeset.execute(
      { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
      undefined,
      { check: (): true => true },
    );

    expect(result).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(adapterSignal).toBeInstanceOf(AbortSignal);
    expect(adapterSignal?.aborted).toBe(true);
  });
});
