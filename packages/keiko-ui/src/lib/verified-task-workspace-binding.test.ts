import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindVerifiedTaskWorkspace } from "./verified-task-workspace-binding";

const api = vi.hoisted(() => ({
  provision: vi.fn(),
  reconcile: vi.fn(),
  activate: vi.fn(),
}));

vi.mock("./task-workspace-api", () => ({
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
});
