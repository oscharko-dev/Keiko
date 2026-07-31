import { describe, expect, it } from "vitest";

import type { CodingWorkbenchSupervisedActionKind } from "@oscharko-dev/keiko-contracts";

import {
  createInMemorySupervisedCodingApprovalStore,
  isSupervisedActionTaskGrantable,
  type SupervisedCodingApprovalBindingOnce,
  type SupervisedCodingApprovalBindingTask,
} from "./supervisedCodingApprovalStore.js";

const binding = (runId: string, requestId: string): SupervisedCodingApprovalBindingOnce => ({
  grantScope: "once",
  runId,
  requestId,
  actionKind: "system-mutation",
  scopeDigest: "a".repeat(64),
  connectorScopes: [],
});

const taskBinding = (
  overrides: Partial<SupervisedCodingApprovalBindingTask> = {},
): SupervisedCodingApprovalBindingTask => ({
  grantScope: "task",
  runId: "run-1",
  requestId: "request-1",
  actionKind: "verification-command",
  scopeDigest: "b".repeat(64),
  connectorScopes: [],
  commandTemplateId: "verify.typecheck",
  safeArgumentClasses: ["frozen-argv"],
  workspaceDigest: "c".repeat(64),
  sourceDigest: "d".repeat(64),
  policyVersion: "policy-1",
  ...overrides,
});

describe("SupervisedCodingApprovalStore (once)", () => {
  it("invalidates outstanding approvals for only the requested run", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const first = store.issue({
      binding: binding("run-1", "request-1"),
      approvedByUserId: "u",
      nowMs: 1,
    });
    const second = store.issue({
      binding: binding("run-2", "request-2"),
      approvedByUserId: "u",
      nowMs: 1,
    });

    store.invalidateRun("run-1");

    expect(
      store.consume({ approval: first.approval, binding: binding("run-1", "request-1"), nowMs: 2 }),
    ).toBeUndefined();
    expect(
      store.consume({
        approval: second.approval,
        binding: binding("run-2", "request-2"),
        nowMs: 2,
      }),
    ).toMatchObject({ approvedByUserId: "u", grantScope: "once" });
  });

  it("is single-use: a second consume of the same claim fails closed", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const issued = store.issue({
      binding: binding("run-1", "req"),
      approvedByUserId: "u",
      nowMs: 1,
    });
    expect(
      store.consume({ approval: issued.approval, binding: binding("run-1", "req"), nowMs: 2 }),
    ).toBeDefined();
    expect(
      store.consume({ approval: issued.approval, binding: binding("run-1", "req"), nowMs: 3 }),
    ).toBeUndefined();
  });
});

describe("task-grant grantability", () => {
  it.each<CodingWorkbenchSupervisedActionKind>(["file-edit", "verification-command"])(
    "admits routine kind %s",
    (kind) => {
      expect(isSupervisedActionTaskGrantable(kind)).toBe(true);
    },
  );

  it.each<CodingWorkbenchSupervisedActionKind>([
    "commit",
    "push",
    "pull-request",
    "merge",
    "connector-write",
    "external-write",
    "system-mutation",
  ])("excludes %s from task grants", (kind) => {
    expect(isSupervisedActionTaskGrantable(kind)).toBe(false);
  });
});

describe("SupervisedCodingApprovalStore (task grants)", () => {
  it("refuses to issue a task grant for an excluded action kind (issuance deny-list)", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    expect(
      store.issueTaskGrant({
        binding: taskBinding({ actionKind: "push" }),
        approvedByUserId: "u",
        nowMs: 1,
      }),
    ).toBeUndefined();
  });

  it("is reusable across consumes when every binding dimension revalidates", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const grant = store.issueTaskGrant({ binding: taskBinding(), approvedByUserId: "u", nowMs: 1 });
    expect(grant).toBeDefined();
    if (grant === undefined) return;
    expect(
      store.consume({ approval: grant.approval, binding: taskBinding(), nowMs: 2 }),
    ).toMatchObject({
      grantScope: "task",
    });
    // Survives the first consume — a task grant is not single-use.
    expect(
      store.consume({ approval: grant.approval, binding: taskBinding(), nowMs: 3 }),
    ).toMatchObject({
      grantScope: "task",
    });
  });

  it.each<Partial<SupervisedCodingApprovalBindingTask>>([
    { sourceDigest: "e".repeat(64) },
    { workspaceDigest: "e".repeat(64) },
    { policyVersion: "policy-2" },
    { commandTemplateId: "verify.lint" },
    { safeArgumentClasses: ["frozen-argv", "path-in-workspace"] },
  ])("cannot be reused after a binding dimension drifts (%o)", (drift) => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const grant = store.issueTaskGrant({ binding: taskBinding(), approvedByUserId: "u", nowMs: 1 });
    if (grant === undefined) throw new Error("expected grant");
    expect(
      store.consume({ approval: grant.approval, binding: taskBinding(drift), nowMs: 2 }),
    ).toBeUndefined();
  });

  it("cannot be reused for an action kind that became ungrantable (consumption deny-list)", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const grant = store.issueTaskGrant({ binding: taskBinding(), approvedByUserId: "u", nowMs: 1 });
    if (grant === undefined) throw new Error("expected grant");
    // Same claim, but the presented binding names an excluded kind: fail closed, and drop it.
    expect(
      store.consume({
        approval: grant.approval,
        binding: taskBinding({ actionKind: "push" }),
        nowMs: 2,
      }),
    ).toBeUndefined();
  });

  it("expires a task grant after an inactivity lapse", () => {
    const store = createInMemorySupervisedCodingApprovalStore({ inactivityMs: 10, ttlMs: 10_000 });
    const grant = store.issueTaskGrant({ binding: taskBinding(), approvedByUserId: "u", nowMs: 1 });
    if (grant === undefined) throw new Error("expected grant");
    expect(
      store.consume({ approval: grant.approval, binding: taskBinding(), nowMs: 5 }),
    ).toBeDefined();
    // 20ms after the last activity (nowMs 5) exceeds the 10ms inactivity window.
    expect(
      store.consume({ approval: grant.approval, binding: taskBinding(), nowMs: 26 }),
    ).toBeUndefined();
  });

  // Gitar review on #2469: the sliding idle window is a TASK-grant concept. A single-use "once"
  // approval has no activity to slide on — it must stay consumable until its hard TTL.
  it("keeps an idle once approval consumable until its hard TTL", () => {
    const store = createInMemorySupervisedCodingApprovalStore({ inactivityMs: 10, ttlMs: 10_000 });
    const once = binding("run-1", "request-1");
    const issued = store.issue({ binding: once, approvedByUserId: "u", nowMs: 1 });
    // Presented well past the idle window but inside the TTL: still a valid single use.
    expect(store.consume({ approval: issued.approval, binding: once, nowMs: 5_000 })).toBeDefined();
    const expired = store.issue({ binding: once, approvedByUserId: "u", nowMs: 1 });
    expect(
      store.consume({ approval: expired.approval, binding: once, nowMs: 10_002 }),
    ).toBeUndefined();
  });

  it("drops task grants bound to a superseded policy version", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const grant = store.issueTaskGrant({ binding: taskBinding(), approvedByUserId: "u", nowMs: 1 });
    if (grant === undefined) throw new Error("expected grant");
    store.invalidateStaleByPolicyVersion("policy-2");
    expect(
      store.consume({ approval: grant.approval, binding: taskBinding(), nowMs: 2 }),
    ).toBeUndefined();
  });

  it("keeps task grants whose policy version is still current", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const grant = store.issueTaskGrant({ binding: taskBinding(), approvedByUserId: "u", nowMs: 1 });
    if (grant === undefined) throw new Error("expected grant");
    store.invalidateStaleByPolicyVersion("policy-1");
    expect(
      store.consume({ approval: grant.approval, binding: taskBinding(), nowMs: 2 }),
    ).toBeDefined();
  });
});

// Release-audit P0 (second half), store layer: the configured TTL was only a DEFAULT, so any caller
// that supplied `ttlMs` chose the stored approval's lifetime with no ceiling — and the only caller
// on the coding-runtime path derives that number from an instant the untrusted runtime child sends.
// The store owns the record it persists, so the ceiling belongs here as well as at the orchestrator:
// two independent layers must both be wrong before a long-lived approval can exist.
describe("SupervisedCodingApprovalStore lifetime ceiling", () => {
  const once = binding("run-1", "request-1");

  it("clamps a caller-supplied lifetime to the store's configured ceiling", () => {
    const store = createInMemorySupervisedCodingApprovalStore({ ttlMs: 1_000 });
    const issued = store.issue({
      binding: once,
      approvedByUserId: "u",
      nowMs: 0,
      ttlMs: 24 * 60 * 60 * 1_000,
    });

    expect(issued.expiresAtMs).toBe(1_000);
    expect(
      store.consume({ approval: issued.approval, binding: once, nowMs: 1_001 }),
    ).toBeUndefined();
  });

  it("clamps a caller-supplied lifetime on a reusable task grant too", () => {
    const store = createInMemorySupervisedCodingApprovalStore({ ttlMs: 1_000 });
    const grant = store.issueTaskGrant({
      binding: taskBinding(),
      approvedByUserId: "u",
      nowMs: 0,
      ttlMs: Number.MAX_SAFE_INTEGER,
    });
    if (grant === undefined) throw new Error("expected grant");

    expect(grant.expiresAtMs).toBe(1_000);
  });

  it.each([
    ["a shorter lifetime", 250, 250],
    ["exactly the ceiling", 1_000, 1_000],
    ["a zero lifetime", 0, 1],
    ["a negative lifetime", -5_000, 1],
    ["a non-finite lifetime", Number.NaN, 1],
  ])("honours %s without ever exceeding the ceiling", (_label, ttlMs, expectedExpiry) => {
    const store = createInMemorySupervisedCodingApprovalStore({ ttlMs: 1_000 });
    const issued = store.issue({ binding: once, approvedByUserId: "u", nowMs: 0, ttlMs });

    expect(issued.expiresAtMs).toBe(expectedExpiry);
  });
});
