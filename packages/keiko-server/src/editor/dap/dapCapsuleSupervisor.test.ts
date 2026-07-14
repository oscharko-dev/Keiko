import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  superviseCapsuleTermination,
  type DebugCapsuleScopeInspection,
  type QualifiedDebugCapsuleHandle,
} from "./dapCapsuleSupervisor.js";

const qualification = { backend: "linuxNamespace" as const, runtimeIdentityDigest: "a".repeat(64) };

function handle(inspections: readonly DebugCapsuleScopeInspection[]): {
  readonly value: QualifiedDebugCapsuleHandle;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly contain: ReturnType<typeof vi.fn>;
  readonly cleanup: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  let exited = false;
  const kill = vi.fn(() => {
    exited = true;
  });
  const contain = vi.fn(() => Promise.resolve());
  const cleanup = vi.fn(() => Promise.resolve());
  return {
    value: {
      planId: "plan_a",
      source: new PassThrough(),
      sink: { write: vi.fn() },
      processGroup: { pid: 42, kill },
      exited: () => exited,
      inspectScope: () => Promise.resolve(selectInspection(inspections, index++)),
      terminateContainment: contain,
      cleanup,
    },
    kill,
    contain,
    cleanup,
  };
}

function selectInspection(
  inspections: readonly DebugCapsuleScopeInspection[],
  index: number,
): DebugCapsuleScopeInspection {
  const selected = inspections[Math.min(index, inspections.length - 1)];
  if (selected === undefined) throw new Error("missing inspection fixture");
  return selected;
}

function inspection(
  overrides: Partial<DebugCapsuleScopeInspection> = {},
): DebugCapsuleScopeInspection {
  return {
    qualified: true,
    backend: "linuxNamespace",
    runtimeIdentityDigest: "a".repeat(64),
    descendants: 0,
    ...overrides,
  };
}

describe("qualified DAP capsule supervisor", () => {
  it("reuses TERM escalation and verifies the independently inspected scope", async () => {
    const current = handle([inspection({ descendants: 1 }), inspection()]);
    await expect(superviseCapsuleTermination(current.value, qualification)).resolves.toStrictEqual({
      terminated: true,
      cleanupComplete: true,
    });
    expect(current.kill).toHaveBeenCalledWith("SIGTERM");
    expect(current.contain).not.toHaveBeenCalled();
  });

  it("kills containment descendants that escaped the detached process group", async () => {
    const current = handle([
      inspection({ descendants: 2 }),
      inspection({ descendants: 1 }),
      inspection(),
    ]);
    await expect(superviseCapsuleTermination(current.value, qualification)).resolves.toStrictEqual({
      terminated: true,
      cleanupComplete: true,
    });
    expect(current.contain).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it.each([
    inspection({ qualified: false }),
    inspection({ backend: "oci" }),
    inspection({ runtimeIdentityDigest: "b".repeat(64) }),
    inspection({ descendants: -1 }),
  ])("fails closed when the host scope is unqualified or identity drifts", async (unsafe) => {
    const current = handle([unsafe]);
    await expect(superviseCapsuleTermination(current.value, qualification)).resolves.toStrictEqual({
      terminated: false,
      cleanupComplete: false,
    });
    expect(current.kill).toHaveBeenCalledWith("SIGTERM");
    expect(current.cleanup).not.toHaveBeenCalled();
  });

  it("retries only unfinished termination and cleanup stages", async () => {
    const current = handle([inspection({ descendants: 1 }), inspection()]);
    await expect(
      superviseCapsuleTermination(current.value, qualification, {
        terminated: true,
        cleanupComplete: false,
      }),
    ).resolves.toStrictEqual({ terminated: true, cleanupComplete: true });
    expect(current.kill).not.toHaveBeenCalled();
    expect(current.cleanup).toHaveBeenCalledTimes(1);

    const alreadyClean = handle([inspection({ descendants: 1 }), inspection()]);
    await expect(
      superviseCapsuleTermination(alreadyClean.value, qualification, {
        terminated: false,
        cleanupComplete: true,
      }),
    ).resolves.toStrictEqual({ terminated: true, cleanupComplete: true });
    expect(alreadyClean.kill).toHaveBeenCalledWith("SIGTERM");
    expect(alreadyClean.cleanup).toHaveBeenCalledTimes(1);

    const complete = handle([inspection()]);
    await expect(
      superviseCapsuleTermination(complete.value, qualification, {
        terminated: true,
        cleanupComplete: true,
      }),
    ).resolves.toStrictEqual({ terminated: true, cleanupComplete: true });
    expect(complete.kill).not.toHaveBeenCalled();
    expect(complete.cleanup).not.toHaveBeenCalled();
  });

  it("retains pending status when containment or cleanup throws", async () => {
    const current = handle([inspection({ descendants: 1 }), inspection({ descendants: 1 })]);
    current.contain.mockRejectedValue(new Error("private"));
    await expect(superviseCapsuleTermination(current.value, qualification)).resolves.toStrictEqual({
      terminated: false,
      cleanupComplete: false,
    });
    expect(current.cleanup).not.toHaveBeenCalled();

    const cleanupFailure = handle([inspection({ descendants: 1 }), inspection()]);
    cleanupFailure.cleanup.mockRejectedValue(new Error("private"));
    await expect(
      superviseCapsuleTermination(cleanupFailure.value, qualification),
    ).resolves.toStrictEqual({ terminated: true, cleanupComplete: false });
  });

  it("requires qualification both before and immediately after process-group termination", async () => {
    const unsafeBefore = handle([inspection({ qualified: false }), inspection()]);
    await expect(superviseCapsuleTermination(unsafeBefore.value, qualification)).resolves.toEqual({
      terminated: false,
      cleanupComplete: false,
    });
    expect(unsafeBefore.contain).not.toHaveBeenCalled();

    const unsafeAfter = handle([
      inspection(),
      inspection({ runtimeIdentityDigest: "b".repeat(64), descendants: 1 }),
      inspection(),
    ]);
    await expect(superviseCapsuleTermination(unsafeAfter.value, qualification)).resolves.toEqual({
      terminated: false,
      cleanupComplete: false,
    });
    expect(unsafeAfter.contain).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Number.POSITIVE_INFINITY])(
    "rejects an invalid initial descendant count %s even if the scope later looks healthy",
    async (descendants) => {
      const current = handle([inspection({ descendants }), inspection()]);
      await expect(superviseCapsuleTermination(current.value, qualification)).resolves.toEqual({
        terminated: false,
        cleanupComplete: false,
      });
    },
  );

  it("requires zero descendants and stable qualification after containment", async () => {
    const remaining = handle([
      inspection(),
      inspection({ descendants: 1 }),
      inspection({ descendants: 1 }),
    ]);
    await expect(superviseCapsuleTermination(remaining.value, qualification)).resolves.toEqual({
      terminated: false,
      cleanupComplete: false,
    });

    const drifted = handle([
      inspection(),
      inspection({ descendants: 1 }),
      inspection({ runtimeIdentityDigest: "b".repeat(64) }),
    ]);
    await expect(superviseCapsuleTermination(drifted.value, qualification)).resolves.toEqual({
      terminated: false,
      cleanupComplete: false,
    });
  });

  it("rejects hostile descendant counts after containment", async () => {
    for (const descendants of [-1, 0.5, Number.NaN]) {
      const current = handle([
        inspection(),
        inspection({ descendants: 1 }),
        inspection({ descendants }),
      ]);
      await expect(superviseCapsuleTermination(current.value, qualification)).resolves.toEqual({
        terminated: false,
        cleanupComplete: false,
      });
    }
  });
});
