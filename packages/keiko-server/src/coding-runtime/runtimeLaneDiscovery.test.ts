import { beforeEach, describe, expect, it, vi } from "vitest";

interface LaneState {
  packaged: unknown;
  dev: unknown;
  npm: unknown;
  supervisor: unknown;
  calls: string[];
}

const lanes = vi.hoisted((): LaneState => ({
  packaged: undefined,
  dev: { outcome: "inactive" },
  npm: { outcome: "inactive" },
  supervisor: { outcome: "inactive" },
  calls: [] as string[],
}));

vi.mock("./productionPortableCodingRuntime.js", () => ({
  discoverPortableOpenCode: (): unknown => {
    lanes.calls.push("packaged");
    return lanes.packaged;
  },
}));
vi.mock("./devLanePortableCodingRuntime.js", () => ({
  discoverDevLaneOpenCode: (): unknown => {
    lanes.calls.push("dev-checkout");
    return lanes.dev;
  },
  discoverNpmLaneOpenCode: (): unknown => {
    lanes.calls.push("npm-runtime-package");
    return lanes.npm;
  },
  discoverNpmLaneRuntimeSupervisor: (): unknown => {
    lanes.calls.push("npm-supervisor");
    return lanes.supervisor;
  },
}));

import {
  discoverActivatedRuntime,
  discoverRuntimeLane,
  discoverSupervisorRuntime,
} from "./runtimeLaneDiscovery.js";

const RUNTIME = { target: "windows-x64" };

beforeEach(() => {
  lanes.packaged = undefined;
  lanes.dev = { outcome: "inactive" };
  lanes.npm = { outcome: "inactive" };
  lanes.supervisor = { outcome: "inactive" };
  lanes.calls = [];
});

describe("discoverRuntimeLane (#4491)", () => {
  it("falls through packaged and dev checkout to the npm runtime package, in that order", () => {
    lanes.npm = { outcome: "activated", runtime: RUNTIME };
    expect(discoverRuntimeLane({ env: {} })?.lane).toBe("npm-runtime-package");
    expect(lanes.calls).toEqual(["packaged", "dev-checkout", "npm-runtime-package"]);
    expect(discoverActivatedRuntime({ env: {} })).toBe(RUNTIME);
  });

  it("stops at a refused dev checkout instead of using a leftover npm package", () => {
    lanes.dev = { outcome: "refused", reason: "payload-tampered" };
    lanes.npm = { outcome: "activated", runtime: RUNTIME };
    expect(discoverRuntimeLane({ env: {} })?.lane).toBe("dev-checkout");
    expect(lanes.calls).toEqual(["packaged", "dev-checkout"]);
    expect(discoverActivatedRuntime({ env: {} })).toBeUndefined();
  });

  it("keeps a refused packaged install as the installation's outcome", () => {
    lanes.packaged = { unavailableReason: "volume" };
    lanes.npm = { outcome: "activated", runtime: RUNTIME };
    expect(discoverRuntimeLane({ env: {} })?.lane).toBe("packaged");
    expect(discoverActivatedRuntime({ env: {} })).toBeUndefined();
  });

  it("answers nothing when no lane is present", () => {
    expect(discoverRuntimeLane({ env: {} })).toBeUndefined();
  });
});

describe("discoverSupervisorRuntime (#4491)", () => {
  it("walks the lanes in the same order but locates only the npm lane's supervisor", () => {
    lanes.supervisor = { outcome: "found", supervisorPath: "S", sha256: "h", sizeBytes: 3 };
    // The full npm discovery would hash the whole OpenCode payload; it is never asked.
    lanes.npm = { outcome: "activated", runtime: RUNTIME };
    expect(discoverSupervisorRuntime({ env: {} })).toEqual({
      kind: "npm-supervisor",
      supervisorPath: "S",
      sha256: "h",
      sizeBytes: 3,
    });
    expect(lanes.calls).toEqual(["packaged", "dev-checkout", "npm-supervisor"]);
  });

  it("keeps the activated runtime of the packaged and dev-checkout lanes", () => {
    lanes.dev = { outcome: "activated", runtime: RUNTIME };
    expect(discoverSupervisorRuntime({ env: {} })).toEqual({
      kind: "activated-runtime",
      runtime: RUNTIME,
    });
    lanes.packaged = { runtime: RUNTIME };
    expect(discoverSupervisorRuntime({ env: {} })).toEqual({
      kind: "activated-runtime",
      runtime: RUNTIME,
    });
  });

  it("stops at a refused lane and answers nothing for a refused npm layout", () => {
    lanes.dev = { outcome: "refused", reason: "payload-tampered" };
    lanes.supervisor = { outcome: "found", supervisorPath: "S", sha256: "h", sizeBytes: 3 };
    expect(discoverSupervisorRuntime({ env: {} })).toBeUndefined();
    lanes.dev = { outcome: "inactive" };
    lanes.supervisor = { outcome: "refused" };
    expect(discoverSupervisorRuntime({ env: {} })).toBeUndefined();
  });
});
