import { describe, expect, it, vi } from "vitest";

describe("Node DAP adapter specification", () => {
  it("freshly loads the exact closed immutable defaults", async () => {
    vi.resetModules();
    const { createNodeDebugAdapterSpec } = await import("./nodeDebugAdapter.js");

    const result = createNodeDebugAdapterSpec(
      "fake-dap",
      ["--stdio"],
      ["/trusted"],
      "a".repeat(64),
    );

    expect(result).toStrictEqual({
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
    expect(Object.isFrozen(result)).toBe(true);
    for (const value of Object.values(result)) {
      if (typeof value === "object") expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("copies and freezes exact caller-supplied launch inputs", async () => {
    vi.resetModules();
    const { createNodeDebugAdapterSpec } = await import("./nodeDebugAdapter.js");
    const executableArgs = ["--stdio", "--fixed"];
    const trustedRoots = ["/adapter", "/runtime"];
    const envAllowlist = ["CUSTOM"];
    const fixedEnv = { DAP_MODE: "fixed" };

    const result = createNodeDebugAdapterSpec(
      "fake-dap",
      executableArgs,
      trustedRoots,
      "b".repeat(64),
      envAllowlist,
      fixedEnv,
    );

    expect(result.executableArgs).toStrictEqual(executableArgs);
    expect(result.trustedRoots).toStrictEqual(trustedRoots);
    expect(result.envAllowlist).toStrictEqual(envAllowlist);
    expect(result.fixedEnv).toStrictEqual(fixedEnv);
    expect(result.executableArgs).not.toBe(executableArgs);
    expect(result.trustedRoots).not.toBe(trustedRoots);
    expect(result.envAllowlist).not.toBe(envAllowlist);
    expect(result.fixedEnv).not.toBe(fixedEnv);
  });
});
