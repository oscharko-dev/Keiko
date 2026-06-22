import { describe, it, expect } from "vitest";
import * as sandbox from "./index.js";

describe("keiko-sandbox barrel", () => {
  it("exposes the planning, selection, builder, and probe surface", () => {
    expect(typeof sandbox.planIsolatedRun).toBe("function");
    expect(typeof sandbox.selectEnforcingBackend).toBe("function");
    expect(typeof sandbox.buildWrappedCommand).toBe("function");
    expect(typeof sandbox.probeBackends).toBe("function");
    expect(typeof sandbox.currentPlatform).toBe("function");
    expect(typeof sandbox.isExecutableOnPath).toBe("function");
    expect(typeof sandbox.SEATBELT_DENY_EGRESS_PROFILE).toBe("string");
    expect(typeof sandbox.DEFAULT_CONTAINER_IMAGE).toBe("string");
  });

  it("composes end-to-end into a wrapped decision", () => {
    const decision = sandbox.planIsolatedRun(
      { command: "node", args: ["-v"], cwd: "/tmp/x", network: "none" },
      { bubblewrap: false, unshare: false, seatbelt: true, docker: false, podman: false },
      "darwin",
    );
    expect(decision.kind).toBe("wrapped");
    if (decision.kind === "wrapped") {
      expect(decision.command).toBe("sandbox-exec");
      expect(decision.attestation.networkEnforced).toBe(true);
      expect(decision.attestation.filesystemEnforced).toBe(false);
    }
  });
});
