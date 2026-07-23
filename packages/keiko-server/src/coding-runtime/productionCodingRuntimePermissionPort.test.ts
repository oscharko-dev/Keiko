import { describe, expect, it, vi } from "vitest";

import {
  createOpenCodeRuntimePermissionPort,
  createProductionRuntimePermissionPort,
} from "./productionCodingRuntimePermissionPort.js";

describe("production coding runtime permission port", () => {
  it("maps approved and denied decisions to exact OpenCode replies", async () => {
    const replyPermission = vi.fn(() => Promise.resolve(true));
    const port = createOpenCodeRuntimePermissionPort({ replyPermission });

    await expect(
      port.resolve({ runId: "run-1", requestId: "permission-123", decision: "approved" }),
    ).resolves.toBe(true);
    await expect(
      port.resolve({ runId: "run-1", requestId: "permission-456", decision: "denied" }),
    ).resolves.toBe(true);
    expect(replyPermission.mock.calls).toEqual([
      ["run-1", "permission-123", "once"],
      ["run-1", "permission-456", "reject"],
    ]);
  });

  it("settles a server-originated ask without demanding a child reply (#2387 research)", async () => {
    const replyPermission = vi.fn(() => Promise.resolve(false));
    const port = createOpenCodeRuntimePermissionPort({ replyPermission });

    // A research ask is minted by the server, never by the child, so there is no child
    // permission to reply to — treating it as unsettled used to flip the whole run to failed.
    await expect(
      port.resolve({ runId: "run-1", requestId: "research-approval-1", decision: "approved" }),
    ).resolves.toBe(true);
    expect(replyPermission).not.toHaveBeenCalled();
  });

  it("routes only to the bound run and fails closed on transport errors", async () => {
    const resolve = vi.fn(() => Promise.resolve(true));
    const port = createProductionRuntimePermissionPort(
      new Map([["run-1", { permissionPort: { resolve } }]]),
    );
    const request = { runId: "run-1", requestId: "per_1", decision: "approved" as const };

    await expect(port.resolve(request)).resolves.toBe(true);
    await expect(port.resolve({ ...request, runId: "missing" })).resolves.toBe(true);
    resolve.mockRejectedValueOnce(new Error("transport"));
    await expect(port.resolve(request)).resolves.toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
