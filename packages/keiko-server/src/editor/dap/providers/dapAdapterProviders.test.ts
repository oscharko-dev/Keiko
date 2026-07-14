import { describe, expect, it } from "vitest";
import { createDapAdapterProviderCatalog, type DebugAdapterSpec } from "./dapAdapterProviders.js";
import { createNodeDebugAdapterSpec } from "./nodeDebugAdapter.js";

function spec(providerId = "node"): DebugAdapterSpec {
  return {
    ...createNodeDebugAdapterSpec("fake-dap", ["--stdio"], ["/trusted"], "a".repeat(64), ["LANG"], {
      DAP_MODE: "fixed",
    }),
    providerId,
  } as const;
}

function runtimeShapeWithCapabilities(): DebugAdapterSpec {
  return {
    ...spec("runtime-shape"),
    supportedAttachKinds: ["attach"] as unknown as readonly never[],
    reverseRequestAllowlist: ["runInTerminal"],
  };
}

describe("DAP adapter provider catalog", () => {
  it("catalogs and deep-freezes one complete DebugAdapterSpec", () => {
    const catalog = createDapAdapterProviderCatalog([spec("fake-node")]);
    const resolved = catalog.resolve("node", "fake-node");
    expect(resolved).toStrictEqual({
      runtime: "node",
      providerId: "fake-node",
      executableName: "fake-dap",
      executableArgs: ["--stdio"],
      requiredExecutables: ["fake-dap"],
      trustedRoots: ["/trusted"],
      provisioningDigest: "a".repeat(64),
      envAllowlist: ["LANG"],
      fixedEnv: { DAP_MODE: "fixed" },
      networkPolicy: "none",
      supportedTargetKinds: ["catalog", "file"],
      supportedLaunchKinds: ["launch"],
      supportedAttachKinds: [],
      reverseRequestAllowlist: [],
    });
    expect(catalog.forRuntime("node")).toBe(resolved);
    expect(catalog.forRuntime("python")).toBeUndefined();
    expect(catalog.resolve("node", "missing")).toBeUndefined();
    expect(catalog.resolve("python", "fake-node")).toBeUndefined();
    expect(Object.isFrozen(resolved)).toBe(true);
    for (const value of Object.values(resolved ?? {})) {
      if (typeof value === "object") expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("copies exact attach and reverse-request capability arrays from runtime input", () => {
    const input = runtimeShapeWithCapabilities();
    const catalog = createDapAdapterProviderCatalog([input]);
    const resolved = catalog.resolve("node", "runtime-shape");

    expect(resolved?.supportedAttachKinds).toStrictEqual(["attach"]);
    expect(resolved?.reverseRequestAllowlist).toStrictEqual(["runInTerminal"]);
    expect(resolved?.supportedAttachKinds).not.toBe(input.supportedAttachKinds);
    expect(resolved?.reverseRequestAllowlist).not.toBe(input.reverseRequestAllowlist);
  });

  it("creates the closed immutable Node defaults and an empty catalog", () => {
    const node = createNodeDebugAdapterSpec("fake-dap", ["--stdio"], ["/trusted"], "a".repeat(64));
    expect(node).toStrictEqual({
      runtime: "node",
      providerId: "node",
      executableName: "fake-dap",
      executableArgs: ["--stdio"],
      requiredExecutables: ["fake-dap"],
      trustedRoots: ["/trusted"],
      provisioningDigest: "a".repeat(64),
      envAllowlist: ["LANG", "LC_ALL", "LC_CTYPE"],
      fixedEnv: {},
      networkPolicy: "none",
      supportedTargetKinds: ["catalog", "file"],
      supportedLaunchKinds: ["launch"],
      supportedAttachKinds: [],
      reverseRequestAllowlist: [],
    });
    for (const value of Object.values(node)) {
      if (typeof value === "object") expect(Object.isFrozen(value)).toBe(true);
    }
    expect(createDapAdapterProviderCatalog([]).resolve("node", "node")).toBeUndefined();
  });
});
