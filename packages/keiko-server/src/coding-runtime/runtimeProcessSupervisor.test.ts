import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeProcessSupervisor,
  verifyRuntimeReapReceipt,
  type RuntimeProcessBackend,
  type RuntimeProcessTree,
  type RuntimeQualificationIdentity,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";

function launchRequest(platform: "darwin" | "win32" = "win32"): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-1",
    treeBindingId: "c".repeat(64),
    executable: "/managed/runtime",
    args: ["--stdio"],
    cwd: "/workspace",
    env: {},
    qualification: {
      platform,
      arch: platform === "darwin" ? "arm64" : "x64",
      backend: platform === "darwin" ? "macos-app-sandbox" : "windows-job-object",
      releaseReceipt: `sha256:${"a".repeat(64)}`,
    },
    launchProfile: {
      upstreamEditAuthority: false,
      upstreamShellAuthority: false,
      upstreamGitAuthority: false,
      upstreamDeliveryAuthority: false,
      upstreamConnectorAuthority: false,
      upstreamBrowserAuthority: false,
      unrestrictedNetworkAuthority: false,
    },
  };
}

function backend(
  exitProof: boolean,
  qualification: RuntimeQualificationIdentity = launchRequest().qualification,
): {
  readonly value: RuntimeProcessBackend;
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly signals: string[];
} {
  const signals: string[] = [];
  const spawn = vi.fn((): RuntimeProcessTree => ({
    treeId: "tree-1",
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    onTreeExit: (): void => undefined,
  }));
  return {
    spawn,
    signals,
    value: {
      identity: {
        platform: qualification.platform,
        arch: qualification.arch,
        backend: qualification.backend,
      },
      spawnOwnedTree: spawn,
      signalTree: (_tree, signal): void => {
        signals.push(signal);
      },
      waitForCompleteTreeExit: (): Promise<boolean> => Promise.resolve(exitProof),
      reconcileTreeExit: (): Promise<boolean> => Promise.resolve(exitProof),
    },
  };
}

describe("runtime process supervisor", () => {
  it("performs zero spawn without an exact release qualification", () => {
    const fake = backend(true);
    const supervisor = createRuntimeProcessSupervisor({ backend: fake.value });

    expect(supervisor.preflight(launchRequest())).toEqual({
      ok: false,
      failureCode: "runtime-unqualified",
    });
    expect(supervisor.spawnOwnedTree(launchRequest())).toEqual({
      ok: false,
      failureCode: "runtime-unqualified",
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("rejects an incomplete launch profile at runtime", () => {
    const fake = backend(true);
    const request = launchRequest();
    const supervisor = createRuntimeProcessSupervisor({
      backend: fake.value,
      qualifications: [request.qualification],
    });
    const incomplete = {
      ...request,
      launchProfile: { upstreamEditAuthority: false },
    } as unknown as RuntimeSupervisorLaunchRequest;

    expect(supervisor.preflight(incomplete)).toEqual({
      ok: false,
      failureCode: "runtime-profile-open",
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("binds qualification to the actual supervisor backend identity", () => {
    const request = launchRequest("darwin");
    const windowsBackend = backend(true);
    const supervisor = createRuntimeProcessSupervisor({
      backend: windowsBackend.value,
      qualifications: [request.qualification],
    });

    expect(supervisor.preflight(request)).toEqual({
      ok: false,
      failureCode: "runtime-unqualified",
    });
    expect(windowsBackend.spawn).not.toHaveBeenCalled();
  });

  it.each(["win32", "darwin"] as const)(
    "owns, signals, and proves complete tree exit on %s",
    async (platform) => {
      const request = launchRequest(platform);
      const fake = backend(true, request.qualification);
      const supervisor = createRuntimeProcessSupervisor({
        backend: fake.value,
        qualifications: [request.qualification],
      });

      const launched = supervisor.spawnOwnedTree(request);
      expect(launched.ok).toBe(true);
      if (!launched.ok) throw new Error("expected qualified launch");
      supervisor.terminate(launched.tree, "graceful");

      const result = await supervisor.waitForCompleteTreeExit(launched.tree, 50);
      expect(result).toMatchObject({
        status: "reaped",
        receipt: { runId: "run-1", treeId: "tree-1" },
      });
      if (result.status !== "reaped") throw new Error("expected reap proof");
      expect(verifyRuntimeReapReceipt(result.receipt, "run-1", "c".repeat(64))).toBe(true);
      expect(verifyRuntimeReapReceipt(result.receipt, "run-1", "d".repeat(64))).toBe(false);
      expect(verifyRuntimeReapReceipt({ ...result.receipt }, "run-1", "c".repeat(64))).toBe(false);
      expect(await supervisor.reconcile(launched.tree)).toEqual(result);
      expect(fake.signals).toEqual(["graceful"]);
    },
  );

  it("retains an unproven tree for explicit reconciliation", async () => {
    const request = launchRequest();
    const fake = backend(false);
    const supervisor = createRuntimeProcessSupervisor({
      backend: fake.value,
      qualifications: [request.qualification],
    });
    const launched = supervisor.spawnOwnedTree(request);
    if (!launched.ok) throw new Error("expected qualified launch");

    expect(await supervisor.waitForCompleteTreeExit(launched.tree, 50)).toEqual({
      status: "recovery-required",
    });
    expect(await supervisor.reconcile(launched.tree)).toEqual({
      status: "recovery-required",
    });
  });
});
