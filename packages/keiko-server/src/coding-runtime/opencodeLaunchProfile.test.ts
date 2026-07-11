import { describe, expect, it } from "vitest";
import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";

describe("OpenCode launch profile", () => {
  it("uses only fixed server-owned loopback arguments and isolated state", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      randomBytes: () => Buffer.alloc(32, 7),
    });
    expect(profile.ok).toBe(true);
    if (profile.ok) {
      expect(profile.args).toEqual([
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
        "--no-mdns",
      ]);
      expect(profile.env.OPENCODE_SERVER_PASSWORD).toHaveLength(43);
      expect(profile.env.PATH).toBeUndefined();
      expect(profile.env.HOME).toContain("/private/run");
      expect((JSON.parse(profile.config) as { permission: { bash: string } }).permission.bash).toBe(
        "deny",
      );
    }
  });
  it("fails closed for non-absolute executable or insufficient secret entropy", () => {
    expect(buildOpenCodeLaunchProfile({ executable: "opencode", stateRoot: "/x" })).toEqual({
      ok: false,
      reason: "invalid-launch-input",
    });
    expect(
      buildOpenCodeLaunchProfile({
        executable: "/x",
        stateRoot: "/x",
        randomBytes: () => Buffer.alloc(31),
      }),
    ).toEqual({ ok: false, reason: "secret-generation-failed" });
  });
});
