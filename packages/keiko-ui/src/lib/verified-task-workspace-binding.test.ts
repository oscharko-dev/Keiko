import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindVerifiedTaskWorkspace,
  restoreVerifiedActiveTaskWorkspace,
} from "./verified-task-workspace-binding";

const api = vi.hoisted(() => ({
  provision: vi.fn(),
  reconcile: vi.fn(),
  activate: vi.fn(),
  getActive: vi.fn(),
}));

vi.mock("./task-workspace-api", () => ({
  getActiveTaskWorkspace: api.getActive,
  provisionTaskWorkspace: api.provision,
  reconcileTaskWorkspaces: api.reconcile,
  setActiveTaskWorkspace: api.activate,
}));

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
    api.provision.mockResolvedValue({ instance: { workspaceId: "ws-1" } });
    api.reconcile.mockResolvedValue({
      entries: [{ workspaceId: "ws-other", status: "healthy" }],
    });

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "verify",
    });
    expect(api.activate).not.toHaveBeenCalled();
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
      reason: "branch-conflict",
      failureClass: "blocked",
    });
    expect(api.reconcile).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("drops branch-conflict metadata with an invalid failure class", async () => {
    api.provision.mockRejectedValue(
      Object.assign(new Error("sensitive repository detail"), {
        code: "BRANCH_CONFLICT",
        failureClass: "unknown",
      }),
    );

    await expect(bindVerifiedTaskWorkspace(INPUT)).resolves.toEqual({
      ok: false,
      stage: "provision",
    });
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
    api.getActive.mockResolvedValue(activeView("ws-2"));
    api.reconcile.mockResolvedValue({
      entries: [{ workspaceId: "ws-2", status: "stale-pointer" }],
    });

    await expect(
      restoreVerifiedActiveTaskWorkspace({ verifiedWorkspaceId: "ws-1" }),
    ).rejects.toMatchObject({ name: "TaskWorkspaceRestoreVerificationError" });
  });
});
