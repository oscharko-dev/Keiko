import { describe, it, expect } from "vitest";
import { planIsolatedRun } from "./plan.js";
import type { BackendAvailability, IsolatedRunPlan } from "./types.js";

const NONE: BackendAvailability = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};

const basePlan: IsolatedRunPlan = {
  command: "node",
  args: ["-e", "process.exit(0)"],
  cwd: "/work/root",
  network: "none",
};

describe("planIsolatedRun", () => {
  it("passes through an inherited-network run with no enforcement", () => {
    const decision = planIsolatedRun({ ...basePlan, network: "inherit" }, NONE, "linux");
    expect(decision.kind).toBe("passthrough");
    if (decision.kind !== "passthrough") {
      throw new Error("expected passthrough");
    }
    expect(decision.command).toBe("node");
    expect(decision.args).toEqual(["-e", "process.exit(0)"]);
    expect(decision.attestation).toEqual({
      backend: "none",
      networkEnforced: false,
      filesystemEnforced: false,
      platform: "linux",
    });
  });

  it("wraps a network:'none' run when an enforcing backend exists, attesting enforcement", () => {
    const decision = planIsolatedRun(basePlan, { ...NONE, bubblewrap: true }, "linux");
    expect(decision.kind).toBe("wrapped");
    if (decision.kind !== "wrapped") {
      throw new Error("expected wrapped");
    }
    expect(decision.command).toBe("bwrap");
    expect(decision.args).toContain("--unshare-net");
    expect(decision.attestation).toEqual({
      backend: "bubblewrap",
      networkEnforced: true,
      filesystemEnforced: false,
      platform: "linux",
    });
  });

  it("fails closed when network:'none' is requested but no backend can enforce it", () => {
    const decision = planIsolatedRun(basePlan, NONE, "linux");
    expect(decision.kind).toBe("fail-closed");
    if (decision.kind !== "fail-closed") {
      throw new Error("expected fail-closed");
    }
    expect(decision.reason).toContain('network: "none"');
    expect(decision.attestation.networkEnforced).toBe(false);
    expect(decision.attestation.filesystemEnforced).toBe(false);
    expect(decision.attestation.backend).toBe("none");
  });

  it("requires a filesystem-capable backend for execution-root isolation", () => {
    const decision = planIsolatedRun(
      { ...basePlan, filesystem: "execution-root" },
      { ...NONE, unshare: true, seatbelt: true },
      "linux",
    );
    expect(decision.kind).toBe("fail-closed");
  });

  it("attests filesystem enforcement for strict bubblewrap execution-root runs", () => {
    const decision = planIsolatedRun(
      { ...basePlan, filesystem: "execution-root" },
      { ...NONE, bubblewrap: true },
      "linux",
    );
    expect(decision.kind).toBe("wrapped");
    if (decision.kind !== "wrapped") {
      throw new Error("expected wrapped");
    }
    expect(decision.attestation).toEqual({
      backend: "bubblewrap",
      networkEnforced: true,
      filesystemEnforced: true,
      platform: "linux",
    });
  });

  it("selects the container fallback on a platform without a native primitive", () => {
    const decision = planIsolatedRun(basePlan, { ...NONE, docker: true }, "win32");
    expect(decision.kind).toBe("wrapped");
    if (decision.kind !== "wrapped") {
      throw new Error("expected wrapped");
    }
    expect(decision.command).toBe("docker");
    expect(decision.attestation.backend).toBe("container-docker");
    expect(decision.attestation.networkEnforced).toBe(true);
    expect(decision.attestation.filesystemEnforced).toBe(false);
  });
});
