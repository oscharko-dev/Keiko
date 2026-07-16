import { describe, expect, it, vi } from "vitest";

import { createCodingToolFacade } from "./codingToolFacade.js";
import type {
  CodingToolAuthorityPort,
  CodingToolCapability,
  CodingToolDelegatePort,
} from "./codingToolFacadePorts.js";
import type { CodingToolActionRequest } from "./codingToolIpc.js";

const capability = "capability-1-opaque-runtime-secret";
const changeset = {
  patch: "--- a/src/file.ts\n+++ b/src/file.ts\n@@\n-old\n+new\n",
  files: [{ file: "src/file.ts", expectedContentHash: "a".repeat(64) }],
};

function requestBody(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ actionId: "action-1", idempotencyKey: "idempotency-1", ...value });
}

interface MutableFacadePorts {
  authority: { admit: CodingToolAuthorityPort["admit"] };
  delegate: { execute: CodingToolDelegatePort["execute"] };
}

function facade(admitted = true): MutableFacadePorts {
  return {
    authority: {
      admit: vi.fn(() =>
        admitted
          ? { ok: true as const, mutationGuard: { check: (): true => true } }
          : { ok: false as const },
      ),
    },
    delegate: { execute: vi.fn(() => Promise.resolve({ outcome: "completed", evidence: [] })) },
  };
}

describe("CodingToolFacade", () => {
  it("admits an exact edit request before making exactly one governed delegate call", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "edit", changeset }),
      capability,
    });

    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
    expect(ports.authority.admit).toHaveBeenCalledTimes(1);
    expect(ports.delegate.execute).toHaveBeenCalledTimes(1);
    expect(ports.authority.admit).toHaveBeenCalledBefore(
      ports.delegate.execute as ReturnType<typeof vi.fn>,
    );
  });

  it("denies forged and missing capabilities without calling a delegate", async () => {
    const ports = facade(false);
    const subject = createCodingToolFacade(ports);
    const body = requestBody({ action: "command", commandId: "test" });

    await expect(subject.execute({ body, capability })).resolves.toMatchObject({
      status: "denied",
    });
    await expect(subject.execute({ body })).resolves.toMatchObject({ status: "denied" });
    expect(ports.authority.admit).toHaveBeenCalledTimes(2);
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("carries replay identities to authoritative admission and never re-executes a replay", async () => {
    const ports = facade();
    const admitted = new Set<string>();
    ports.authority.admit = vi.fn(
      (_capability: CodingToolCapability | undefined, request: CodingToolActionRequest) => {
        const replayKey = `${request.actionId}:${request.idempotencyKey}`;
        if (admitted.has(replayKey)) {
          return { ok: false as const, reason: "authority-replayed" };
        }
        admitted.add(replayKey);
        return { ok: true as const, mutationGuard: { check: (): true => true } };
      },
    );
    const subject = createCodingToolFacade(ports);
    const body = requestBody({ action: "command", commandId: "test" });

    await expect(subject.execute({ body, capability })).resolves.toMatchObject({
      status: "completed",
    });
    await expect(subject.execute({ body, capability })).resolves.toMatchObject({
      status: "denied",
    });
    expect(ports.delegate.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects every Origin header, including same-origin", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
        headers: { Origin: "http://127.0.0.1" },
      }),
    ).resolves.toMatchObject({ status: "denied" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("fails closed for unknown actions and extra request keys", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({ body: requestBody({ action: "shell" }), capability }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test", extra: true }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test", capability: "forged" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("enforces bounded body and in-flight limits", async () => {
    const ports = facade();
    let release: (() => void) | undefined;
    ports.delegate.execute = vi.fn(
      () =>
        new Promise((resolve) => {
          release = (): void => {
            resolve({ outcome: "completed" });
          };
        }),
    );
    const subject = createCodingToolFacade(ports, { maxBodyBytes: 256, maxInFlight: 1 });
    const body = requestBody({ action: "command", commandId: "test" });

    await expect(subject.execute({ body: "x".repeat(257), capability })).resolves.toMatchObject({
      status: "invalid",
    });
    const first = subject.execute({ body, capability });
    await expect(subject.execute({ body, capability })).resolves.toMatchObject({ status: "busy" });
    release?.();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("does not delegate denied or cancelled actions", async () => {
    const ports = facade();
    const controller = new AbortController();
    controller.abort();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("treats permission observation as non-executable", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: JSON.stringify({ action: "permission-event", requestId: "request-1" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "observed" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("delegates each closed governed action exactly once", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const bodies = [
      { action: "edit", changeset },
      { action: "command", commandId: "test" },
      { action: "verification", verifierId: "unit" },
      { action: "git", operation: "read" },
      { action: "delivery", intent: "push" },
      { action: "connector", scope: "source-control.read" },
      { action: "egress", target: "https://example.test" },
    ];

    for (const body of bodies)
      await expect(subject.execute({ body: requestBody(body), capability })).resolves.toMatchObject(
        { status: "completed" },
      );
    expect(ports.authority.admit).toHaveBeenCalledTimes(bodies.length);
    expect(ports.delegate.execute).toHaveBeenCalledTimes(bodies.length);
  });

  it("rechecks revocation immediately before dispatch", async () => {
    const ports = facade();
    ports.authority.admit = vi.fn(() => ({
      ok: true as const,
      mutationGuard: { check: (): false => false },
    }));
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "denied" });
    expect(ports.authority.admit).toHaveBeenCalledTimes(1);
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("replaces delegate evidence with fixed server-owned labels", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        stdout: "SECRET-SENTINEL",
        evidence: [
          {
            kind: "/private/SECRET-SENTINEL",
            code: "curl https://SECRET-SENTINEL.example",
            content: "SECRET-SENTINEL",
          },
        ],
      }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "verification", verifierId: "unit" }),
      capability,
    });
    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-SENTINEL");
  });

  it("rejects rollback and accepts only existing safe delivery intents", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "delivery", operation: "rollback" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ action: "delivery", intent: "merge" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("contains delegate failures without exposing their content", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() => Promise.reject(new Error("SECRET-SENTINEL")));
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "failed" }],
    });
  });

  it("accepts only the exact bounded repository-read shape and never trusts a runtime root or authority", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const read = { action: "read", relativePath: "src/a.ts" };

    await expect(subject.execute({ body: requestBody(read), capability })).resolves.toMatchObject({
      status: "completed",
    });
    for (const forged of [
      { ...read, relativePath: "../outside.ts" },
      { ...read, relativePath: "/workspace/a.ts" },
      { ...read, workspaceRoot: "/forged" },
      { ...read, authorityRef: { runId: "forged" } },
      { ...read, approvalRef: "forged" },
      { ...read, byteCount: 1 },
    ]) {
      await expect(
        subject.execute({ body: requestBody(forged), capability }),
      ).resolves.toMatchObject({ status: "invalid" });
    }
    expect(ports.delegate.execute).toHaveBeenCalledTimes(1);
    expect(ports.delegate.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "read", relativePath: "src/a.ts" }),
      undefined,
      expect.anything(),
    );
  });

  it.each([".env", ".ENV", "services/.env", "secrets/.ENV"])(
    "rejects canonical deny-listed repository reads for %s before authority admission",
    async (relativePath) => {
      const ports = facade();
      const subject = createCodingToolFacade(ports);

      await expect(
        subject.execute({ body: requestBody({ action: "read", relativePath }), capability }),
      ).resolves.toMatchObject({ status: "invalid" });

      expect(ports.authority.admit).not.toHaveBeenCalled();
      expect(ports.delegate.execute).not.toHaveBeenCalled();
    },
  );

  it("aligns the raw invocation body cap with the 256 KiB registry entry cap while retaining changeset validation", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const largeButValidChangeset = {
      action: "edit",
      changeset: {
        patch: "x".repeat(16_385),
        files: [{ file: "src/a.ts", expectedContentHash: "a".repeat(64) }],
      },
    };

    await expect(
      subject.execute({ body: requestBody(largeButValidChangeset), capability }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(subject.execute({ body: "x".repeat(262_145), capability })).resolves.toMatchObject(
      { status: "invalid" },
    );
    expect(ports.delegate.execute).toHaveBeenCalledOnce();
  });

  it("keeps no legacy targetPath/patchBytes request type or parser lane", async () => {
    const legacy: CodingToolActionRequest = {
      action: "edit",
      actionId: "legacy-action",
      idempotencyKey: "legacy-key",
      // @ts-expect-error Issue #2332 removes the metadata-only edit request variant entirely.
      targetPath: "src/a.ts",
      patchBytes: 1,
    };
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({ body: JSON.stringify(legacy), capability }),
    ).resolves.toMatchObject({ status: "invalid" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("accepts only an exact validated changeset edit and never projects its raw payload into facade results", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        patch: "SENTINEL_RAW_PATCH",
        capability: "SENTINEL_RUNTIME_CAPABILITY",
      }),
    );
    const subject = createCodingToolFacade(ports);
    const edit = {
      action: "edit",
      changeset: {
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
        files: [{ file: "src/a.ts", expectedContentHash: "a".repeat(64) }],
      },
    };

    const result = await subject.execute({ body: requestBody(edit), capability });
    await expect(
      subject.execute({ body: requestBody({ ...edit, patchBytes: 1 }), capability }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ ...edit, changeset: { patch: "x", files: [] } }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });

    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_");
  });

  it("fails closed for blocked, denied, and malformed delegate outcomes", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const body = requestBody({ action: "command", commandId: "test" });

    for (const outcome of [{ outcome: "blocked" }, { outcome: "denied" }, {}, null]) {
      ports.delegate.execute = vi.fn(() => Promise.resolve(outcome));
      await expect(subject.execute({ body, capability })).resolves.toEqual({
        status: "failed",
        evidence: [{ kind: "governed-delegate", code: "failed" }],
      });
    }
  });
});
