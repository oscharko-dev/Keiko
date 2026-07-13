import {
  buildWrappedCommand,
  planIsolatedRun,
  planStrictDebugCapsule,
} from "@oscharko-dev/keiko-sandbox";
import { describe, expect, it } from "vitest";
import { inspectSeparateDebugWrappers } from "./debugLaunchTopology.js";

const isolatedPlan = {
  command: "/usr/bin/node",
  args: ["app.js"],
  cwd: "/workspace",
  network: "none",
  filesystem: "execution-root",
} as const;

describe("managed debug capsule topology", () => {
  it.each(["bubblewrap", "container-docker"] as const)(
    "proves separately wrapped %s processes cannot establish sibling reachability",
    (backend) => {
      const adapter = buildWrappedCommand(backend, isolatedPlan);
      const debuggee = buildWrappedCommand(backend, isolatedPlan);
      expect(adapter?.args).toContain(
        backend === "bubblewrap" ? "--unshare-net" : "--network=none",
      );
      expect(debuggee?.args).toContain(
        backend === "bubblewrap" ? "--unshare-net" : "--network=none",
      );
      const availability =
        backend === "bubblewrap"
          ? { bubblewrap: true, unshare: false, seatbelt: false, docker: false, podman: false }
          : { bubblewrap: false, unshare: false, seatbelt: false, docker: true, podman: false };
      const adapterDecision = planIsolatedRun(isolatedPlan, availability, "linux");
      const debuggeeDecision = planIsolatedRun(isolatedPlan, availability, "linux");
      expect(inspectSeparateDebugWrappers(adapterDecision, debuggeeDecision)).toEqual({
        capsuleCount: 2,
        mutuallyReachable: false,
        accepted: false,
      });
    },
  );

  it("uses the real Linux execution-root planner without a host listener", () => {
    const decision = planIsolatedRun(
      isolatedPlan,
      { bubblewrap: true, unshare: false, seatbelt: false, docker: false, podman: false },
      "linux",
    );
    expect(decision.kind).toBe("wrapped");
    expect(decision.attestation).toMatchObject({
      backend: "bubblewrap",
      networkEnforced: true,
      filesystemEnforced: true,
    });
    const strict = planStrictDebugCapsule({
      platform: "linux",
      availability: {
        bubblewrap: true,
        unshare: false,
        seatbelt: false,
        docker: false,
        podman: false,
      },
      backendExecutables: { bubblewrap: "/usr/bin/bwrap" },
      backendExecutableIdentityDigests: { bubblewrap: "e".repeat(64) },
      executionRoot: "/workspace",
      runtimeHostDirectory: "/private/runtime",
      runtimeCapsuleDirectory: "/run/keiko-debug",
      runtimeMountIdentityDigest: "c".repeat(64),
      runtimeMountQualified: true,
      executionRootIdentityDigest: "d".repeat(64),
      containerImage: `registry.example/keiko-debug@sha256:${"1".repeat(64)}`,
      adapterCapsuleExecutable: "/opt/keiko/adapter",
      adapterArgs: ["--server", "/run/keiko-debug/adapter.sock"],
      immutableMounts: [
        {
          hostPath: "/provisioned/adapter",
          capsulePath: "/opt/keiko/adapter",
          identityDigest: "a".repeat(64),
        },
      ],
      runtimeIdentityDigest: "b".repeat(64),
    });
    expect(strict).toMatchObject({
      backend: "linuxNamespace",
      network: "none",
      filesystem: "executionRoot",
      descendantScope: "qualifiedCapsuleInit",
      initMechanism: "bubblewrapPid1Reaper",
      runtimeMount: {
        hostPath: "/private/runtime",
        capsulePath: "/run/keiko-debug",
        mode: "0700",
        writable: true,
      },
    });
    expect(strict.args).not.toEqual(decision.kind === "wrapped" ? decision.args : []);
    expect(strict.args.join(" ")).not.toMatch(/(?:--publish|-p\s+\d|0\.0\.0\.0|127\.0\.0\.1)/u);
  });

  it("rejects a passthrough or fail-closed wrapper as unproven topology", () => {
    const passthrough = planIsolatedRun(
      { ...isolatedPlan, network: "inherit" },
      { bubblewrap: false, unshare: false, seatbelt: false, docker: false, podman: false },
      "linux",
    );
    const closed = planIsolatedRun(
      isolatedPlan,
      { bubblewrap: false, unshare: false, seatbelt: false, docker: false, podman: false },
      "linux",
    );
    expect(() => inspectSeparateDebugWrappers(passthrough, closed)).toThrow(
      "DEBUG_TOPOLOGY_UNPROVEN",
    );
    expect(() => inspectSeparateDebugWrappers(closed, passthrough)).toThrow(
      "DEBUG_TOPOLOGY_UNPROVEN",
    );
    const wrapped = planIsolatedRun(
      isolatedPlan,
      { bubblewrap: true, unshare: false, seatbelt: false, docker: false, podman: false },
      "linux",
    );
    if (wrapped.kind !== "wrapped") throw new Error("expected wrapped fixture");
    const unattested = {
      ...wrapped,
      attestation: { ...wrapped.attestation, networkEnforced: false },
    };
    expect(() => inspectSeparateDebugWrappers(unattested, wrapped)).toThrow(
      "DEBUG_TOPOLOGY_UNPROVEN",
    );
    expect(() => inspectSeparateDebugWrappers(wrapped, unattested)).toThrow(
      "DEBUG_TOPOLOGY_UNPROVEN",
    );
  });
});
