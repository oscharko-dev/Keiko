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
      port.resolve({ runId: "run-1", requestId: "per_1", decision: "approved" }),
    ).resolves.toBe(true);
    await expect(
      port.resolve({ runId: "run-1", requestId: "per_2", decision: "denied" }),
    ).resolves.toBe(true);
    expect(replyPermission.mock.calls).toEqual([
      ["run-1", "per_1", "once"],
      ["run-1", "per_2", "reject"],
    ]);
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
