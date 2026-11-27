import { beforeEach, describe, expect, it, vi } from "vitest";

interface LaneState {
  packaged: unknown;
  dev: unknown;
  npm: unknown;
  calls: string[];
}

const lanes = vi.hoisted((): LaneState => ({
  packaged: undefined,
  dev: { outcome: "inactive" },
  npm: { outcome: "inactive" },
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
}));

import { discoverActivatedRuntime, discoverRuntimeLane } from "./runtimeLaneDiscovery.js";

const RUNTIME = { target: "windows-x64" };

beforeEach(() => {
  lanes.packaged = undefined;
  lanes.dev = { outcome: "inactive" };
  lanes.npm = { outcome: "inactive" };
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
