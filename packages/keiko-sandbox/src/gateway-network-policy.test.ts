// #2951: the gateway-allowlist NetworkPolicy variant shares ONE policy-binding/argv core
// (backends.ts's buildGatewaySeatbeltCommand) across the direct `runtime-gateway.ts` API and the
// generic `planIsolatedRun`/`selectGatewayBackend` planning path. These tests cover the planning
// path directly; runtime-gateway.test.ts (owned by another change in flight) covers the direct API
// and the real macOS OS-level proof.
import { describe, expect, it } from "vitest";
import { buildWrappedCommand } from "./backends.js";
import { GATEWAY_UNSUPPORTED_ON_HOST_REASON, planIsolatedRun } from "./plan.js";
import { selectGatewayBackend } from "./select.js";
import type { BackendAvailability, IsolatedRunPlan, NetworkGatewayPolicy } from "./types.js";

const NONE: BackendAvailability = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};

const ALL: BackendAvailability = {
  bubblewrap: true,
  unshare: true,
  seatbelt: true,
  docker: true,
  podman: true,
};

const gateway: NetworkGatewayPolicy = { mode: "gateway", host: "127.0.0.1", port: 1983 };

const basePlan: IsolatedRunPlan = {
  command: "/trusted/opencode",
  args: ["serve"],
  cwd: "/work/root",
  network: gateway,
};

describe("selectGatewayBackend", () => {
  it("picks seatbelt on macOS when it is on PATH", () => {
    expect(selectGatewayBackend("darwin", ALL)).toBe("seatbelt");
  });

  // Failing-before: before this selector existed, gateway policy had no dedicated selection
  // function at all, so nothing distinguished "seatbelt is missing" from "seatbelt available".
  it("fails closed on macOS when seatbelt itself is unavailable", () => {
    expect(selectGatewayBackend("darwin", { ...ALL, seatbelt: false })).toBe("none");
  });

  // The critical "no weaker fallback" proof (#2951): Linux offers bubblewrap/unshare/docker/podman
  // for OTHER policies, but none of them can reach the host's loopback gateway from inside their
  // own network namespace, so gateway selection must never choose one of them.
  it("never selects a Linux or container backend for gateway policy even when all are available", () => {
    expect(selectGatewayBackend("linux", ALL)).toBe("none");
  });

  it("fails closed on win32, which has no confining backend at all for this policy", () => {
    expect(selectGatewayBackend("win32", ALL)).toBe("none");
  });
});

describe("planIsolatedRun with a gateway-allowlist network policy", () => {
  it("wraps under Seatbelt on macOS, attesting real enforcement", () => {
    const decision = planIsolatedRun(basePlan, ALL, "darwin");
    expect(decision.kind).toBe("wrapped");
    if (decision.kind !== "wrapped") throw new Error("expected wrapped");
    expect(decision.command).toBe("/usr/bin/sandbox-exec");
    expect(decision.args).toEqual(["-p", expect.any(String), "/trusted/opencode", "serve"]);
    expect(decision.attestation).toEqual({
      backend: "seatbelt",
      networkEnforced: true,
      filesystemEnforced: false,
      platform: "darwin",
    });
  });

  it("builds a profile that is port-specific, not the general any-localhost egress tier", () => {
    const decision = planIsolatedRun(basePlan, ALL, "darwin");
    if (decision.kind !== "wrapped") throw new Error("expected wrapped");
    const profile = decision.args[1];
    expect(profile).toContain('(remote tcp4 "localhost:1983")');
    // Regression pin: a profile that still allows ANY localhost port is a weaker policy than the
    // gateway allowlist promises and must fail this assertion.
    expect(profile).not.toContain('remote tcp4 "localhost:*"');
    expect(profile).not.toContain("remote ip");
  });

  it("fails closed on Linux with the shared unsupported-on-this-host reason, never a weaker run", () => {
    const decision = planIsolatedRun(basePlan, ALL, "linux");
    expect(decision.kind).toBe("fail-closed");
    if (decision.kind !== "fail-closed") throw new Error("expected fail-closed");
    expect(decision.reason).toBe(GATEWAY_UNSUPPORTED_ON_HOST_REASON);
    expect(decision.reason).toMatch(/^unsupported-on-this-host: /);
    expect(decision.attestation).toEqual({
      backend: "none",
      networkEnforced: false,
      filesystemEnforced: false,
      platform: "linux",
    });
  });

  it("fails closed on win32 with the identical reason keiko-server's native backend must match", () => {
    const decision = planIsolatedRun(basePlan, ALL, "win32");
    expect(decision.kind).toBe("fail-closed");
    if (decision.kind !== "fail-closed") throw new Error("expected fail-closed");
    expect(decision.reason).toBe(GATEWAY_UNSUPPORTED_ON_HOST_REASON);
  });

  it("fails closed on macOS itself when no seatbelt binary is present", () => {
    const decision = planIsolatedRun(basePlan, NONE, "darwin");
    expect(decision.kind).toBe("fail-closed");
  });
});

describe("buildWrappedCommand seatbelt case honours the network policy shape", () => {
  it("builds the gateway profile for a gateway policy", () => {
    const wrapped = buildWrappedCommand("seatbelt", basePlan);
    expect(wrapped?.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped?.args[1]).toContain('(remote tcp4 "localhost:1983")');
  });

  it('builds the general deny-egress profile unchanged for a plain "none" policy', () => {
    const wrapped = buildWrappedCommand("seatbelt", { ...basePlan, network: "none" });
    expect(wrapped?.command).toBe("sandbox-exec");
    expect(wrapped?.args).toEqual(["-p", expect.any(String), "/trusted/opencode", "serve"]);
    expect(wrapped?.args[1]).toContain("localhost:*");
  });

  it("carries the IPv6 loopback family through to the profile", () => {
    const wrapped = buildWrappedCommand("seatbelt", {
      ...basePlan,
      network: { mode: "gateway", host: "::1", port: 65_535 },
    });
    expect(wrapped?.args[1]).toContain('(remote tcp6 "localhost:65535")');
  });
});
