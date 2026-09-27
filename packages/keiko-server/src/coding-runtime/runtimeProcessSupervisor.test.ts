import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { planLongLivedRuntimeSandbox } from "@oscharko-dev/keiko-sandbox";

import {
  createRuntimeProcessSupervisor,
  verifyRuntimeReapReceipt,
  type RuntimeProcessBackend,
  type RuntimeProcessTree,
  type RuntimeQualificationIdentity,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";
import type {
  LongLivedRuntimeSandboxDecision,
  LongLivedRuntimeSandboxRequest,
} from "@oscharko-dev/keiko-sandbox";

function launchRequest(platform: "darwin" | "win32" = "win32"): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-1",
    recoveryHandle: "d".repeat(32),
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
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    authorityEnvelopeDigest: "e".repeat(64),
    egressPolicy: {
      kind: "loopback-only",
      reviewedEgressReceipt: `sha256:${"f".repeat(64)}`,
    },
  };
}

function enforcingSandbox(
  request: LongLivedRuntimeSandboxRequest,
): LongLivedRuntimeSandboxDecision {
  return planLongLivedRuntimeSandbox(
    request,
    { bubblewrap: false, unshare: false, seatbelt: true, docker: false, podman: false },
    "darwin",
  );
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

  it("performs zero spawn for a qualified Windows tree when egress is unenforceable", () => {
    const request = launchRequest("win32");
    const fake = backend(true, request.qualification);
    const supervisor = createRuntimeProcessSupervisor({
      backend: fake.value,
      qualifications: [request.qualification],
    });

    expect(supervisor.spawnOwnedTree(request)).toEqual({
      ok: false,
      failureCode: "runtime-egress-unenforceable",
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("performs zero spawn when no backend can enforce the reviewed egress profile", () => {
    const request = launchRequest();
    const fake = backend(true);
    const supervisor = createRuntimeProcessSupervisor({
      backend: fake.value,
      qualifications: [request.qualification],
      planSandbox: (): LongLivedRuntimeSandboxDecision => ({
        kind: "fail-closed",
        reason: "policy-unenforceable",
      }),
    });

    expect(supervisor.spawnOwnedTree(request)).toEqual({
      ok: false,
      failureCode: "runtime-egress-unenforceable",
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("performs zero spawn when a planner attests another authority", () => {
    const request = launchRequest();
    const fake = backend(true);
    const supervisor = createRuntimeProcessSupervisor({
      backend: fake.value,
      qualifications: [request.qualification],
      planSandbox: (sandboxRequest) => {
        const planned = enforcingSandbox(sandboxRequest);
        if (planned.kind !== "wrapped") return planned;
        return {
          ...planned,
          attestation: {
            ...planned.attestation,
            authorityEnvelopeDigest: "0".repeat(64),
          },
        };
      },
    });

    expect(supervisor.spawnOwnedTree(request)).toEqual({
      ok: false,
      failureCode: "runtime-egress-unenforceable",
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("performs zero spawn when the prepared wrapper exceeds native protocol bounds", () => {
    const request = launchRequest();
    const fake = backend(true);
    const supervisor = createRuntimeProcessSupervisor({
      backend: fake.value,
      qualifications: [request.qualification],
      planSandbox: (sandboxRequest) => {
        const planned = enforcingSandbox(sandboxRequest);
        return planned.kind === "wrapped"
          ? { ...planned, args: Array.from({ length: 65 }, () => "argument") }
          : planned;
      },
    });

    expect(supervisor.spawnOwnedTree(request)).toEqual({
      ok: false,
      failureCode: "runtime-egress-unenforceable",
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("rejects an incomplete launch profile at runtime", () => {
    const fake = backend(true);
    const request = launchRequest();
    const supervisor = createRuntimeProcessSupervisor({
      backend: fake.value,
      qualifications: [request.qualification],
      planSandbox: enforcingSandbox,
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
      planSandbox: enforcingSandbox,
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
        planSandbox: enforcingSandbox,
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
      planSandbox: enforcingSandbox,
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
