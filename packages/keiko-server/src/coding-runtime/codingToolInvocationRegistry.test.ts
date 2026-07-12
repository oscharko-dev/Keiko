import { describe, expect, it, vi } from "vitest";

import {
  CODING_TOOL_INVOCATION_MAX_AGGREGATE_BYTES,
  CODING_TOOL_INVOCATION_MAX_BYTES_PER_ENTRY,
  CODING_TOOL_INVOCATION_MAX_LIVE_PER_RUN,
  createCodingToolInvocationRegistry,
} from "./codingToolInvocationRegistry.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const FAR_FUTURE = "2026-07-12T12:00:00.000Z";

interface StagedEditRequest {
  readonly runId: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly digest: string;
  readonly authorityExpiresAt: string;
  readonly payload: Buffer;
}

function stagedEdit(overrides: Partial<StagedEditRequest> = {}): StagedEditRequest {
  return {
    runId: "run-2332",
    actionId: "action-1",
    idempotencyKey: "idempotency-1",
    digest: DIGEST_A,
    authorityExpiresAt: FAR_FUTURE,
    payload: Buffer.from('{"changeset":{"patch":"SENTINEL_PATCH"}}', "utf8"),
    ...overrides,
  };
}

describe("CodingToolInvocationRegistry (Issue #2332)", () => {
  it("caps each run at eight entries, 262,144 bytes per entry, and 2 MiB in aggregate", () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });

    expect(CODING_TOOL_INVOCATION_MAX_LIVE_PER_RUN).toBe(8);
    expect(CODING_TOOL_INVOCATION_MAX_BYTES_PER_ENTRY).toBe(262_144);
    expect(CODING_TOOL_INVOCATION_MAX_AGGREGATE_BYTES).toBe(2 * 1024 * 1024);
    for (let index = 0; index < CODING_TOOL_INVOCATION_MAX_LIVE_PER_RUN; index += 1) {
      expect(
        registry.stage(
          stagedEdit({
            actionId: `action-${String(index)}`,
            idempotencyKey: `key-${String(index)}`,
          }),
        ).kind,
      ).toBe("staged");
    }
    expect(registry.stage(stagedEdit({ actionId: "ninth", idempotencyKey: "ninth" })).kind).toBe(
      "busy",
    );
    expect(
      registry.stage(
        stagedEdit({ actionId: "large", idempotencyKey: "large", payload: Buffer.alloc(262_145) }),
      ).kind,
    ).toBe("invalid");

    const aggregate = createCodingToolInvocationRegistry({ now: () => 0 });
    for (let index = 0; index < 8; index += 1) {
      expect(
        aggregate.stage(
          stagedEdit({
            runId: `run-${String(index)}`,
            actionId: `aggregate-${String(index)}`,
            idempotencyKey: `aggregate-key-${String(index)}`,
            payload: Buffer.alloc(CODING_TOOL_INVOCATION_MAX_BYTES_PER_ENTRY),
          }),
        ).kind,
      ).toBe("staged");
    }
    expect(
      aggregate.stage(
        stagedEdit({
          runId: "aggregate-overflow",
          actionId: "aggregate-overflow",
          idempotencyKey: "aggregate-overflow",
        }),
      ).kind,
    ).toBe("busy");
  });

  it("keeps claimed payloads in per-run and aggregate capacity accounting until terminal wipe", () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });
    for (let index = 0; index < CODING_TOOL_INVOCATION_MAX_LIVE_PER_RUN; index += 1) {
      const request = stagedEdit({
        actionId: `claimed-${String(index)}`,
        idempotencyKey: `claimed-${String(index)}`,
      });
      expect(registry.stage(request)).toEqual({ kind: "staged" });
      expect(registry.take(request).kind).toBe("ready");
    }
    expect(
      registry.stage(
        stagedEdit({ actionId: "claimed-overflow", idempotencyKey: "claimed-overflow" }),
      ),
    ).toEqual({ kind: "busy" });
  });

  it("expires at the earlier of authority expiry and thirty seconds, wipes payload bytes, and retains no content tombstone", () => {
    let now = 0;
    const registry = createCodingToolInvocationRegistry({ now: () => now });
    const payload = Buffer.from("SENTINEL_PATCH", "utf8");
    const staged = registry.stage(
      stagedEdit({ authorityExpiresAt: "1970-01-01T00:00:05.000Z", payload }),
    );
    expect(staged.kind).toBe("staged");

    now = 5_001;
    expect(registry.take(stagedEdit())).toEqual({ kind: "expired" });
    expect([...payload]).toEqual(Array.from({ length: payload.length }, () => 0));
    expect(
      JSON.stringify(registry.tombstoneFor("run-2332", "action-1", "idempotency-1")),
    ).not.toContain("SENTINEL_PATCH");

    let thirtySecondNow = 0;
    const thirtySecondRegistry = createCodingToolInvocationRegistry({ now: () => thirtySecondNow });
    const thirtySecond = stagedEdit({ actionId: "thirty-second", idempotencyKey: "thirty-second" });
    expect(thirtySecondRegistry.stage(thirtySecond).kind).toBe("staged");
    thirtySecondNow = 30_001;
    expect(thirtySecondRegistry.take(thirtySecond)).toEqual({ kind: "expired" });
  });

  it("is monotonic under revoke, cancels every run payload, and denies same-identity digest changes", () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });
    const first = stagedEdit();
    const duplicate = stagedEdit();
    const conflict = stagedEdit({ digest: DIGEST_B });

    expect(registry.stage(first).kind).toBe("staged");
    expect(registry.stage(duplicate).kind).toBe("duplicate");
    expect(registry.stage(conflict)).toEqual({ kind: "conflict" });
    expect(registry.revokeRun("run-2332")).toBe(1);
    expect(registry.take(first)).toEqual({ kind: "revoked" });
    expect(
      registry.stage(stagedEdit({ actionId: "after-revoke", idempotencyKey: "after-revoke" })),
    ).toEqual({ kind: "revoked" });
  });

  it("retains exactly 2,048 content-free revoked runs without affecting a valid unrelated run", () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });
    const revoked = stagedEdit({
      runId: "revoked-0",
      actionId: "revoked-action",
      idempotencyKey: "revoked-key",
      payload: Buffer.from("SENTINEL_REVOKED_CONTENT", "utf8"),
    });
    const unrelated = Array.from({ length: 7 }, (_, index) =>
      stagedEdit({
        runId: "unrelated-valid",
        actionId: `unrelated-action-${String(index)}`,
        idempotencyKey: `unrelated-key-${String(index)}`,
      }),
    );

    for (const request of unrelated) expect(registry.stage(request)).toEqual({ kind: "staged" });
    expect(registry.stage(revoked)).toEqual({ kind: "staged" });
    expect(registry.revokeRun(revoked.runId)).toBe(1);
    expect([...revoked.payload]).toEqual(Array.from({ length: revoked.payload.length }, () => 0));
    expect(
      registry.tombstoneFor(revoked.runId, revoked.actionId, revoked.idempotencyKey),
    ).toBeUndefined();
    expect(registry.stage(revoked)).toEqual({ kind: "revoked" });
    expect(registry.take(revoked)).toEqual({ kind: "revoked" });

    for (let index = 1; index < 2_048; index += 1) registry.revokeRun(`revoked-${String(index)}`);

    expect(registry.stage(revoked)).toEqual({ kind: "revoked" });
    expect(registry.take(revoked)).toEqual({ kind: "revoked" });
    const eighth = stagedEdit({
      runId: "unrelated-valid",
      actionId: "unrelated-action-7",
      idempotencyKey: "unrelated-key-7",
    });
    expect(registry.stage(eighth)).toEqual({ kind: "staged" });
    expect(
      registry.stage(
        stagedEdit({
          runId: "unrelated-valid",
          actionId: "unrelated-overflow",
          idempotencyKey: "unrelated-overflow",
        }),
      ),
    ).toEqual({ kind: "busy" });

    registry.revokeRun("revoked-2048");

    expect(registry.take(eighth).kind).toBe("ready");
    expect(
      registry.stage(
        stagedEdit({
          runId: revoked.runId,
          actionId: revoked.actionId,
          idempotencyKey: revoked.idempotencyKey,
          payload: Buffer.from("REINTRODUCED_CONTENT", "utf8"),
        }),
      ),
    ).toEqual({ kind: "staged" });
  });

  it("executes a duplicate or reconnect storm exactly once without retaining the consumed payload", () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });
    const request = stagedEdit();
    expect(registry.stage(request).kind).toBe("staged");
    for (let index = 0; index < 1_000; index += 1)
      expect(registry.stage(request).kind).toBe("duplicate");

    const first = registry.take(request);
    expect(first.kind).toBe("ready");
    expect(registry.take(request)).toEqual({ kind: "replayed" });
    expect(
      JSON.stringify(registry.tombstoneFor("run-2332", "action-1", "idempotency-1")),
    ).not.toContain("SENTINEL_PATCH");
  });

  it("expires a claimed invocation at its authority deadline and aborts a delegate that never settles", () => {
    let now = 0;
    const registry = createCodingToolInvocationRegistry({ now: () => now });
    const request = stagedEdit({ authorityExpiresAt: "1970-01-01T00:00:05.000Z" });
    expect(registry.stage(request)).toEqual({ kind: "staged" });
    const taken = registry.take(request);
    if (taken.kind !== "ready") throw new Error("expected claimed invocation");

    now = 5_001;
    expect(
      registry.stage(stagedEdit({ actionId: "expiry-probe", idempotencyKey: "expiry-probe" })),
    ).toEqual({
      kind: "staged",
    });
    expect(taken.signal.aborted).toBe(true);
    expect([...taken.payload]).toEqual(Array.from({ length: taken.payload.length }, () => 0));
    expect(registry.settle(request)).toBe(false);
  });

  it("retains completed replay identities for the run lifetime without locking another run", () => {
    let now = 0;
    const registry = createCodingToolInvocationRegistry({ now: () => now });
    for (let index = 0; index < 2_048; index += 1) {
      const expiresAt = new Date(now + 1_000).toISOString();
      const request = stagedEdit({
        actionId: `completed-${String(index)}`,
        idempotencyKey: `completed-key-${String(index)}`,
        authorityExpiresAt: expiresAt,
      });
      expect(registry.stage(request)).toEqual({ kind: "staged" });
      expect(registry.take(request).kind).toBe("ready");
      expect(registry.settle(request)).toBe(true);
    }
    now += 31_001;
    const first = stagedEdit({
      actionId: "completed-0",
      idempotencyKey: "completed-key-0",
      authorityExpiresAt: new Date(now + 1_000).toISOString(),
    });
    expect(registry.stage(first)).toEqual({ kind: "replayed" });
    expect(
      registry.stage(
        stagedEdit({ runId: "run-elsewhere", actionId: "other-run", idempotencyKey: "other-run" }),
      ),
    ).toEqual({ kind: "staged" });
    expect(
      registry.stage(
        stagedEdit({ actionId: "completed-overflow", idempotencyKey: "completed-overflow" }),
      ),
    ).toEqual({ kind: "busy" });
  });

  it("uses independent per-run action and idempotency indexes, including after a content-free tombstone", () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });
    const first = stagedEdit();

    expect(registry.stage(first)).toEqual({ kind: "staged" });
    expect(
      registry.stage(stagedEdit({ actionId: "action-1", idempotencyKey: "idempotency-2" })),
    ).toEqual({ kind: "conflict" });
    expect(
      registry.stage(stagedEdit({ actionId: "action-2", idempotencyKey: "idempotency-1" })),
    ).toEqual({ kind: "conflict" });
    expect(registry.take(first).kind).toBe("ready");
    expect(
      registry.stage(stagedEdit({ actionId: "action-1", idempotencyKey: "idempotency-2" })),
    ).toEqual({ kind: "conflict" });
    expect(
      registry.stage(stagedEdit({ actionId: "action-2", idempotencyKey: "idempotency-1" })),
    ).toEqual({ kind: "conflict" });
    expect(registry.stage(stagedEdit({ digest: DIGEST_B }))).toEqual({ kind: "conflict" });
  });

  it("expires and wipes by its unref timer without requiring a later registry operation", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const payload = Buffer.from("SENTINEL_TIMER_PAYLOAD", "utf8");
      const registry = createCodingToolInvocationRegistry({ now: () => Date.now() });

      expect(
        registry.stage(stagedEdit({ payload, authorityExpiresAt: "1970-01-01T00:00:05.000Z" })),
      ).toEqual({
        kind: "staged",
      });
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(5_001);

      expect([...payload]).toEqual(Array.from({ length: payload.length }, () => 0));
      expect(vi.getTimerCount()).toBe(0);
      expect(
        JSON.stringify(registry.tombstoneFor("run-2332", "action-1", "idempotency-1")),
      ).not.toContain("SENTINEL_TIMER_PAYLOAD");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["revokeRun", "dispose"] as const)(
    "clears its expiry timer when %s reaches a terminal path",
    (terminal) => {
      vi.useFakeTimers({ now: 0 });
      try {
        const registry = createCodingToolInvocationRegistry({ now: () => Date.now() });
        const request = stagedEdit({ authorityExpiresAt: "2099-01-01T00:00:00.000Z" });
        expect(registry.stage(request)).toEqual({ kind: "staged" });
        expect(vi.getTimerCount()).toBe(1);

        if (terminal === "revokeRun") registry.revokeRun(request.runId);
        if (terminal === "dispose") registry.dispose();

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
