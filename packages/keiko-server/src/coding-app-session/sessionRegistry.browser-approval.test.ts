import { describe, expect, it } from "vitest";

import { createSessionRegistry } from "./sessionRegistry.js";

const FIRST_APPROVAL = `bra_${"a".repeat(32)}`;
const SECOND_APPROVAL = `bra_${"b".repeat(32)}`;

function fixture(): {
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly setTime: (time: number) => void;
} {
  let now = 0;
  return {
    registry: createSessionRegistry({ now: (): number => now, idleTtlMs: 100 }),
    setTime: (time: number): void => {
      now = time;
    },
  };
}

describe("approval-bound sessions", () => {
  it("counts bulk approval expiry exactly during capacity cleanup", () => {
    let now = 0;
    const registry = createSessionRegistry({ now: (): number => now, maxSessions: 3 });
    const binding = { approvalId: FIRST_APPROVAL, expiresAtMs: 100 };
    const first = registry.mintForApproval("first", binding);
    const second = registry.mintForApproval("second", binding);
    const other = registry.mint("other");
    now = 100;
    const replacement = registry.mint("replacement");
    expect(replacement.capacityDecision).toEqual({
      expiredSessionCount: 2,
      evictedSessionClass: "none",
    });
    expect(registry.verify(first.cookieToken)).toBeUndefined();
    expect(registry.verify(second.cookieToken)).toBeUndefined();
    expect(registry.verify(other.cookieToken)).toBeDefined();
    expect(registry.verify(replacement.cookieToken)).toBeDefined();
    expect(registry.sessionCount()).toBe(2);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])(
    "rejects invalid approval issuance time before evicting existing authority: %s",
    (invalidTime) => {
      let now = 0;
      const registry = createSessionRegistry({ now: (): number => now, maxSessions: 1 });
      const existing = registry.mint("launcher");
      now = invalidTime;
      expect(() =>
        registry.mintForApproval("browser", { approvalId: FIRST_APPROVAL, expiresAtMs: 200 }),
      ).toThrow(TypeError);
      now = 0;
      expect(registry.verify(existing.cookieToken)).toBeDefined();
    },
  );
  it.each(["inspect", "rotate", "release", "repair"] as const)(
    "shares known grant expiry when %s is the first registry observer",
    (observer) => {
      let now = 0;
      const times: number[] = [];
      const registry = createSessionRegistry({ now: (): number => times.shift() ?? now });
      const binding = { approvalId: FIRST_APPROVAL, expiresAtMs: 100 };
      const first = registry.mintForApproval("first", binding);
      const second = registry.mintForApproval("second", binding);
      const other = registry.mintForApproval("other", {
        approvalId: SECOND_APPROVAL,
        expiresAtMs: 200,
      });
      const ordinary = registry.mint("launcher");
      const release = registry.beginOperation(first.cookieToken);
      now = 100;
      switch (observer) {
        case "inspect":
          registry.inspect(first.cookieToken);
          break;
        case "rotate":
          registry.rotate(first.session.sessionId);
          break;
        case "release":
          release?.();
          break;
        case "repair":
          times.push(99, 100);
          registry.verifyForCookieRepair(first.cookieToken);
          break;
      }
      now = 99;
      release?.();
      expect(registry.inspect(first.cookieToken)).toBeUndefined();
      expect(registry.inspect(second.cookieToken)).toBeUndefined();
      expect(registry.inspect(other.cookieToken)).toBeDefined();
      expect(registry.inspect(ordinary.cookieToken)).toBeDefined();
    },
  );

  it.each(["absolute", "idle"] as const)(
    "irreversibly expires the original %s boundary at equality",
    (kind) => {
      let now = 0;
      const registry = createSessionRegistry({
        now: (): number => now,
        absoluteTtlMs: kind === "absolute" ? 100 : 1_000,
        idleTtlMs: kind === "idle" ? 100 : 1_000,
      });
      const issued = registry.mint("launcher");
      now = 100;
      expect(registry.inspect(issued.cookieToken)).toBeUndefined();
      now = 99;
      expect(registry.verify(issued.cookieToken)).toBeUndefined();
    },
  );
  it("shares observed expiry across bindings without expiring valid grants or launcher authority", () => {
    const { registry, setTime } = fixture();
    const expired = registry.mintForApproval("session-only", {
      approvalId: FIRST_APPROVAL,
      expiresAtMs: 100,
    });
    const valid = registry.mintForApproval("remembered", {
      approvalId: SECOND_APPROVAL,
      expiresAtMs: 200,
    });
    const ordinary = registry.mint("launcher");
    const release = registry.beginOperation(expired.cookieToken);
    expect(() => registry.expireApprovalsAt(Number.NaN)).toThrow(TypeError);
    expect(registry.expireApprovalsAt(99)).toBe(0);
    expect(registry.inspect(expired.cookieToken)).toBeDefined();
    expect(registry.expireApprovalsAt(100)).toBe(1);
    setTime(50);
    release?.();
    expect(registry.inspect(expired.cookieToken)).toBeUndefined();
    expect(registry.inspect(valid.cookieToken)).toBeDefined();
    expect(registry.inspect(ordinary.cookieToken)).toBeDefined();
    expect(registry.expireApprovalsAt(100)).toBe(0);
  });
  it("caps cookie repair and rotation at the original approval expiry", () => {
    const { registry, setTime } = fixture();
    const first = registry.mintForApproval("browser", {
      approvalId: FIRST_APPROVAL,
      expiresAtMs: 30,
    });
    expect(registry.verifyForCookieRepair(first.cookieToken)).toBe(30);
    setTime(10);
    const rotated = registry.rotate(first.session.sessionId);
    expect(rotated?.session.issuedAtMs).toBe(0);
    expect(rotated?.session.rotationCount).toBe(1);
    expect(registry.verify(first.cookieToken)).toBeUndefined();
    expect(registry.verifyForCookieRepair(rotated?.cookieToken)).toBe(20);
    setTime(30);
    expect(registry.inspect(rotated?.cookieToken)).toBeUndefined();
    expect(registry.rotate(first.session.sessionId)).toBeUndefined();
  });

  it("does not protect approval expiry through an active operation", () => {
    const { registry, setTime } = fixture();
    const first = registry.mintForApproval("browser", {
      approvalId: FIRST_APPROVAL,
      expiresAtMs: 200,
    });
    const release = registry.beginOperation(first.cookieToken);
    expect(release).toBeTypeOf("function");
    setTime(150);
    expect(registry.inspect(first.cookieToken)).toBeDefined();
    setTime(200);
    expect(registry.verify(first.cookieToken)).toBeUndefined();
    release?.();
    release?.();
    expect(registry.sessionCount()).toBe(0);
  });

  it("irreversibly expires authority when operation release is the first expiry observer", () => {
    const { registry, setTime } = fixture();
    const first = registry.mintForApproval("browser", {
      approvalId: FIRST_APPROVAL,
      expiresAtMs: 200,
    });
    const release = registry.beginOperation(first.cookieToken);
    setTime(200);
    release?.();
    expect(registry.sessionCount()).toBe(0);
    setTime(150);
    expect(registry.verify(first.cookieToken)).toBeUndefined();
    expect(registry.rotate(first.session.sessionId)).toBeUndefined();
    release?.();
    expect(registry.sessionCount()).toBe(0);
  });

  it("refuses a backwards clock without letting operation cleanup move the observation back", () => {
    const { registry, setTime } = fixture();
    const first = registry.mintForApproval("browser", {
      approvalId: FIRST_APPROVAL,
      expiresAtMs: 200,
    });
    setTime(20);
    const release = registry.beginOperation(first.cookieToken);
    setTime(10);
    release?.();
    expect(registry.inspect(first.cookieToken)).toBeUndefined();
    setTime(30);
    expect(registry.verify(first.cookieToken)).toBeUndefined();
  });

  it("revokes every session of one approval while retaining other approval and launcher sessions", () => {
    const { registry } = fixture();
    const binding = { approvalId: FIRST_APPROVAL, expiresAtMs: 200 };
    const first = registry.mintForApproval("browser", binding);
    const second = registry.mintForApproval("browser", binding);
    const rotated = registry.rotate(second.session.sessionId);
    const other = registry.mintForApproval("other", {
      approvalId: SECOND_APPROVAL,
      expiresAtMs: 200,
    });
    const launcher = registry.mint("launcher");
    const release = registry.beginOperation(first.cookieToken);
    expect(registry.revokeApproval(FIRST_APPROVAL)).toBe(2);
    release?.();
    expect(registry.verify(first.cookieToken)).toBeUndefined();
    expect(registry.verify(rotated?.cookieToken)).toBeUndefined();
    expect(registry.verify(other.cookieToken)).toBeDefined();
    expect(registry.verify(launcher.cookieToken)).toBeDefined();
    expect(registry.revokeApproval(FIRST_APPROVAL)).toBe(0);
  });

  it.each([
    { approvalId: "invalid", expiresAtMs: 200 },
    { approvalId: FIRST_APPROVAL, expiresAtMs: Number.NaN },
    { approvalId: FIRST_APPROVAL, expiresAtMs: 0 },
    { approvalId: FIRST_APPROVAL, expiresAtMs: -1 },
  ])("refuses an invalid binding before evicting existing authority: %j", (binding) => {
    const registry = createSessionRegistry({ now: (): number => 0, maxSessions: 1 });
    const existing = registry.mint("launcher");
    expect(() => registry.mintForApproval("browser", binding)).toThrow(TypeError);
    expect(registry.verify(existing.cookieToken)).toBeDefined();
    expect(registry.sessionCount()).toBe(1);
  });

  it("copies the binding so caller mutation cannot change expiry or revocation scope", () => {
    const { registry, setTime } = fixture();
    const binding = { approvalId: FIRST_APPROVAL, expiresAtMs: 30 };
    const first = registry.mintForApproval("browser", binding);
    binding.approvalId = SECOND_APPROVAL;
    binding.expiresAtMs = 200;
    expect(registry.revokeApproval(SECOND_APPROVAL)).toBe(0);
    setTime(30);
    expect(registry.verify(first.cookieToken)).toBeUndefined();
  });

  it("retains the ordinary absolute lifetime when the approval lasts longer", () => {
    let now = 0;
    const registry = createSessionRegistry({
      now: (): number => now,
      absoluteTtlMs: 100,
      idleTtlMs: 1_000,
    });
    const first = registry.mintForApproval("browser", {
      approvalId: FIRST_APPROVAL,
      expiresAtMs: 200,
    });
    now = 90;
    const rotated = registry.rotate(first.session.sessionId);
    expect(registry.verifyForCookieRepair(rotated?.cookieToken)).toBe(10);
    now = 101;
    expect(registry.inspect(rotated?.cookieToken)).toBeUndefined();
  });
});
