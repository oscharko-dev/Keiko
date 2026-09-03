import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindVerifiedTaskWorkspace,
  repairAndBindVerifiedTaskWorkspace,
  restoreVerifiedActiveTaskWorkspace,
} from "./verified-task-workspace-binding";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

const api = vi.hoisted(() => ({
  provision: vi.fn(),
  reconcile: vi.fn(),
  activate: vi.fn(),
  getActive: vi.fn(),
  list: vi.fn(),
  repair: vi.fn(),
}));

vi.mock("./task-workspace-api", () => ({
  getActiveTaskWorkspace: api.getActive,
  provisionTaskWorkspace: api.provision,
  reconcileTaskWorkspaces: api.reconcile,
  setActiveTaskWorkspace: api.activate,
  listTaskWorkspaces: api.list,
  repairTaskWorkspace: api.repair,
}));

function pointerDrift(): Error {
  return Object.assign(new Error("sensitive worktree detail"), {
    code: "POINTER_DRIFT",
    failureClass: "repairable",
  });
}

function refusedRow(
  hints: readonly { readonly strategy: string; readonly operatorActionRequired: boolean }[],
): unknown {
  return {
    workspaceId: "ws-refused",
    taskId: INPUT.taskId,
    driftMarkers: ["identity-schema-retired"],
    recoveryHints: hints.map((hint) => ({ marker: "identity-schema-retired", ...hint })),
  };
}

const INPUT = {
  root: "/repo",
  taskId: "task-2473",
  baseBranch: "dev",
  requestedBy: "studio-operator",
} as const;

describe("bindVerifiedTaskWorkspace", () => {
  beforeEach(() => {
    api.provision.mockReset();
    api.reconcile.mockReset();
    api.activate.mockReset();
    api.list.mockReset();
    api.repair.mockReset();
  });

  afterEach(() => {
    resetClientDiagnosticWriter();
  });

  it("provisions, verifies, and only then activates the managed workspace", async () => {
    const order: string[] = [];
    api.provision.mockImplementation(() => {
      order.push("provision");
      return Promise.resolve({ instance: { workspaceId: "ws-1" } });
    });
    api.reconcile.mockImplementation(() => {
      order.push("verify");
      return Promise.resolve({ entries: [{ workspaceId: "ws-1", status: "healthy" }] });
    });
    api.activate.mockImplementation(() => {
      order.push("activate");
      return Promise.resolve({});
    });

    await expect(
      bindVerifiedTaskWorkspace({
        ...INPUT,
        onProvisioned: () => {
          order.push("provisioned");
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(order).toEqual(["provision", "provisioned", "verify", "activate"]);
    expect(api.reconcile).toHaveBeenCalledWith({ root: "/repo" });
    expect(api.activate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      requestedBy: "studio-operator",
    });
  });

  it("fails closed when reconciliation does not confirm the provisioned workspace", async () => {
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    api.provision.mockResolvedValue({ instance: { workspaceId: "ws-1" } });
    api.reconcile.mockResolvedValue({
      entries: [{ workspaceId: "ws-other", status: "healthy" }],
    });

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "verify",
    });
    expect(api.activate).not.toHaveBeenCalled();
    // The refusal names the verdict it saw, exactly as the restore path does: a report that never
    // mentioned the workspace is a different defect from one that classified it, and the generic
    // verify sentence cannot tell them apart (AGENTS.md §8, #3381 review).
    expect(diagnostics).toContain(
      "[keiko] task workspace bind verify failed: status=missing-report-entry",
    );
  });

  it.each([
    ["provision", api.provision, { ok: false, stage: "provision" }],
    ["verify", api.reconcile, { ok: false, stage: "verify" }],
    ["activate", api.activate, { ok: false, stage: "activate" }],
  ] as const)("returns a bounded %s failure without throwing", async (stage, failing, expected) => {
    api.provision.mockResolvedValue({ instance: { workspaceId: "ws-1" } });
    api.reconcile.mockResolvedValue({
      entries: [{ workspaceId: "ws-1", status: "healthy" }],
    });
    api.activate.mockResolvedValue({});
    failing.mockRejectedValue(new Error(`${stage}-sensitive-detail`));

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual(expected);
  });

  it("returns a bounded branch-conflict reason without exposing server detail", async () => {
    api.provision.mockRejectedValue(
      Object.assign(new Error("sensitive repository detail"), {
        code: "BRANCH_CONFLICT",
        failureClass: "blocked",
      }),
    );

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "provision",
      code: "BRANCH_CONFLICT",
      reason: "branch-conflict",
      failureClass: "blocked",
    });
    expect(api.reconcile).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });

  // The code alone is carried (it is the server's own vocabulary and lets a surface name the
  // refusal); the reason and the class are dropped because an unknown class carries no meaning
  // the surface may act on.
  it("drops branch-conflict metadata with an invalid failure class but keeps the code", async () => {
    api.provision.mockRejectedValue(
      Object.assign(new Error("sensitive repository detail"), {
        code: "BRANCH_CONFLICT",
        failureClass: "unknown",
      }),
    );

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "provision",
      code: "BRANCH_CONFLICT",
    });
  });

  it.each([
    { code: "INVALID_BASE_BRANCH", failureClass: "blocked" },
    { code: "LOCK_CONTENTION", failureClass: "retryable" },
  ])(
    "carries the $code failure code and class of a structured refusal",
    async ({ code, failureClass }) => {
      api.provision.mockRejectedValue(
        Object.assign(new Error("sensitive repository detail"), { code, failureClass }),
      );

      await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
        ok: false,
        stage: "provision",
        code,
        failureClass,
      });
      expect(api.list).not.toHaveBeenCalled();
    },
  );

  // A refused EXISTING workspace (POINTER_DRIFT) names no workspace on the wire; the row is
  // resolved from the inventory and its persisted finding and executable hint ride on the result.
  it("attaches the refused workspace and its automatic strategy on a pointer-drift refusal", async () => {
    api.provision.mockRejectedValue(pointerDrift());
    api.list.mockResolvedValue([
      refusedRow([
        { strategy: "operator-repair", operatorActionRequired: true },
        { strategy: "reconcile-pointer", operatorActionRequired: false },
      ]),
    ]);

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "provision",
      code: "POINTER_DRIFT",
      failureClass: "repairable",
      repair: {
        workspaceId: "ws-refused",
        driftMarkers: ["identity-schema-retired"],
        strategy: "reconcile-pointer",
      },
    });
    expect(api.list).toHaveBeenCalledWith("/repo");
    expect(api.reconcile).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("offers no strategy when every recovery hint needs an operator first", async () => {
    api.provision.mockRejectedValue(pointerDrift());
    api.list.mockResolvedValue([
      refusedRow([{ strategy: "operator-repair", operatorActionRequired: true }]),
    ]);

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toMatchObject({
      repair: { workspaceId: "ws-refused", strategy: null },
    });
  });

  it("returns the bounded refusal without an offer when the inventory cannot be read", async () => {
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    api.provision.mockRejectedValue(pointerDrift());
    api.list.mockRejectedValue(new Error("HTTP 503 /repo"));

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "provision",
      code: "POINTER_DRIFT",
      failureClass: "repairable",
    });
    expect(diagnostics.some((line) => line.includes("bind repair-lookup failed"))).toBe(true);
  });

  it("returns the bounded refusal without an offer when no row matches the task", async () => {
    api.provision.mockRejectedValue(pointerDrift());
    api.list.mockResolvedValue([{ ...(refusedRow([]) as object), taskId: "someone-else" }]);

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "provision",
      code: "POINTER_DRIFT",
      failureClass: "repairable",
    });
  });
});

describe("repairAndBindVerifiedTaskWorkspace", () => {
  const REPAIR = {
    root: "/repo",
    workspaceId: "ws-refused",
    strategy: "reconcile-pointer",
    requestedBy: "studio-operator",
  } as const;

  beforeEach(() => {
    api.reconcile.mockReset();
    api.activate.mockReset();
    api.repair.mockReset();
  });

  afterEach(() => {
    resetClientDiagnosticWriter();
  });

  it("repairs with explicit operator approval, then verifies and only then activates", async () => {
    const order: string[] = [];
    api.repair.mockImplementation(() => {
      order.push("repair");
      return Promise.resolve({ applied: true, driftMarkers: [] });
    });
    api.reconcile.mockImplementation(() => {
      order.push("verify");
      return Promise.resolve({ entries: [{ workspaceId: "ws-refused", status: "healthy" }] });
    });
    api.activate.mockImplementation(() => {
      order.push("activate");
      return Promise.resolve({});
    });

    await expect(
      repairAndBindVerifiedTaskWorkspace({
        ...REPAIR,
        onRepaired: () => {
          order.push("repaired");
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(order).toEqual(["repair", "repaired", "verify", "activate"]);
    expect(api.repair).toHaveBeenCalledWith({
      workspaceId: "ws-refused",
      requestedBy: "studio-operator",
      strategy: "reconcile-pointer",
      operatorApproved: true,
    });
    expect(api.reconcile).toHaveBeenCalledWith({ root: "/repo" });
    expect(api.activate).toHaveBeenCalledWith({
      workspaceId: "ws-refused",
      requestedBy: "studio-operator",
    });
  });

  it("reports a repair the server did not apply as operator-required without activating", async () => {
    api.repair.mockResolvedValue({ applied: false, driftMarkers: ["head-moved"] });

    await expect(repairAndBindVerifiedTaskWorkspace(REPAIR)).resolves.toEqual({
      ok: false,
      stage: "repair",
      repair: { workspaceId: "ws-refused", driftMarkers: ["head-moved"], strategy: null },
    });
    expect(api.reconcile).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("fails closed when the repaired workspace does not reconcile healthy", async () => {
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    api.repair.mockResolvedValue({ applied: true, driftMarkers: [] });
    api.reconcile.mockResolvedValue({
      entries: [{ workspaceId: "ws-refused", status: "drifted" }],
    });

    await expect(repairAndBindVerifiedTaskWorkspace(REPAIR)).resolves.toEqual({
      ok: false,
      stage: "verify",
    });
    expect(api.activate).not.toHaveBeenCalled();
    // The repair APPLIED and the post-repair pass still refused: without the status the operator
    // cannot tell `drifted` (uncommitted work) from a workspace the report never mentioned.
    expect(diagnostics).toContain("[keiko] task workspace bind verify failed: status=drifted");
  });

  it("returns the bounded repair failure when the route rejects", async () => {
    api.repair.mockRejectedValue(
      Object.assign(new Error("sensitive detail"), {
        code: "LOCK_CONTENTION",
        failureClass: "retryable",
      }),
    );

    await expect(repairAndBindVerifiedTaskWorkspace(REPAIR)).resolves.toEqual({
      ok: false,
      stage: "repair",
      code: "LOCK_CONTENTION",
      failureClass: "retryable",
    });
    expect(api.reconcile).not.toHaveBeenCalled();
  });
});

// Release-audit F-09b: the reconciliation pass may be skipped for ONE workspace identity — the one
// the caller already holds a verification for. Scoping it to the identity rather than to the
// session is what stops a later activation (`switchTo`, which routes through the same reload) from
// claiming a binding this pass never granted; `setActiveTaskWorkspace` does not reconcile.
describe("restoreVerifiedActiveTaskWorkspace", () => {
  function activeView(workspaceId: string, health = "healthy"): unknown {
    return {
      instance: { workspaceId, repositoryRoot: "/repo", health },
      binding: { workspaceId },
    };
  }

  beforeEach(() => {
    api.getActive.mockReset();
    api.reconcile.mockReset();
  });

  it("runs the pass when no verified identity is held", async () => {
    api.getActive.mockResolvedValue(activeView("ws-1"));
    api.reconcile.mockResolvedValue({ entries: [{ workspaceId: "ws-1", status: "healthy" }] });

    await expect(restoreVerifiedActiveTaskWorkspace()).resolves.toMatchObject({
      instance: { workspaceId: "ws-1" },
    });
    expect(api.reconcile).toHaveBeenCalledOnce();
  });

  it("skips the pass only for the identity the caller already verified", async () => {
    api.getActive.mockResolvedValue(activeView("ws-1"));

    await expect(
      restoreVerifiedActiveTaskWorkspace({ verifiedWorkspaceId: "ws-1" }),
    ).resolves.toMatchObject({ instance: { workspaceId: "ws-1" } });
    expect(api.reconcile).not.toHaveBeenCalled();
  });

  it("verifies an active workspace that differs from the held identity", async () => {
    api.getActive.mockResolvedValue(activeView("ws-2"));
    api.reconcile.mockResolvedValue({ entries: [{ workspaceId: "ws-2", status: "healthy" }] });

    await expect(
      restoreVerifiedActiveTaskWorkspace({ verifiedWorkspaceId: "ws-1" }),
    ).resolves.toMatchObject({ instance: { workspaceId: "ws-2" } });
    expect(api.reconcile).toHaveBeenCalledOnce();
  });

  it("fails closed when the pass rejects a workspace the view still claims healthy", async () => {
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    api.getActive.mockResolvedValue(activeView("ws-2"));
    api.reconcile.mockResolvedValue({
      entries: [{ workspaceId: "ws-2", status: "stale-pointer" }],
    });

    await expect(
      restoreVerifiedActiveTaskWorkspace({ verifiedWorkspaceId: "ws-1" }),
    ).rejects.toMatchObject({ name: "TaskWorkspaceRestoreVerificationError" });
    // The refusal names the live status it saw, so a restore that failed for a customer can be
    // matched to the server's reconcile line without a screenshot (AGENTS.md §8).
    expect(
      diagnostics.some((line) => line.includes("restore-verify failed: status=stale-pointer")),
    ).toBe(true);
  });
});
