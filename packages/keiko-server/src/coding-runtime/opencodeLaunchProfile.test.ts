import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOpenCodeLaunchProfile,
  type OpenCodeLaunchProfileInput,
} from "./opencodeLaunchProfile.js";
import {
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  OPENCODE_PINNED_BUILT_IN_TOOLS,
} from "./opencodeToolSchemas.js";

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function migratedPermissionRules(config: {
  readonly tools: Readonly<Record<string, boolean>>;
  readonly permission: Readonly<Record<string, string>>;
}): readonly { readonly permission: string; readonly action: string }[] {
  const migrated: Record<string, string> = {};
  for (const [tool, enabled] of Object.entries(config.tools)) {
    const permission = tool === "write" || tool === "edit" || tool === "patch" ? "edit" : tool;
    migrated[permission] = enabled ? "allow" : "deny";
  }
  for (const [permission, action] of Object.entries(config.permission)) {
    migrated[permission] = action;
  }
  return Object.entries(migrated).map(([permission, action]) => ({ permission, action }));
}

function finalPermissionAction(
  rules: ReturnType<typeof migratedPermissionRules>,
  tool: string,
): string | undefined {
  const permission = ["edit", "write", "apply_patch"].includes(tool) ? "edit" : tool;
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule !== undefined && (rule.permission === "*" || rule.permission === permission)) {
      return rule.action;
    }
  }
  return undefined;
}

describe("OpenCode launch profile", () => {
  it("disables upstream snapshots with a deterministic server-owned config digest", () => {
    const input = {
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      randomBytes: (): Buffer => Buffer.alloc(32, 7),
      snapshot: true,
    } satisfies OpenCodeLaunchProfileInput & { readonly snapshot: boolean };
    const first = buildOpenCodeLaunchProfile(input);
    const second = buildOpenCodeLaunchProfile({ ...input, randomBytes: () => Buffer.alloc(32, 9) });
    if (!first.ok || !second.ok) throw new Error("expected fixed managed launch profiles");
    const config = JSON.parse(first.config) as Readonly<Record<string, unknown>>;
    expect(config.snapshot).toBe(false);
    expect(second.config).toBe(first.config);
    const digest = (value: string): string =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const legacyShape = { ...config };
    Reflect.deleteProperty(legacyShape, "snapshot");
    expect(digest(first.config)).toBe(digest(second.config));
    expect(digest(first.config)).not.toBe(digest(JSON.stringify(legacyShape)));
  });

  it("emits the pinned v1.17.17 model/provider and exact model-visible tool configuration", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      randomBytes: () => Buffer.alloc(32, 7),
    });
    if (!profile.ok) throw new Error("expected fixed managed launch profile");
    const config = JSON.parse(profile.config) as {
      readonly model: string;
      readonly provider: Readonly<Record<string, unknown>>;
      readonly tools: Readonly<Record<string, boolean>>;
      readonly permission: Readonly<Record<string, string>>;
    };
    expect(config.model).toBe("keiko-runtime/coding");
    const provider = record(config.provider["keiko-runtime"]);
    expect(provider).toMatchObject({
      name: "Keiko Governed Coding Gateway",
      env: [],
    });
    expect(Object.keys(record(provider.models))).toEqual(["coding"]);
    expect(record(record(provider.models).coding)).toEqual({
      name: "Keiko Governed Coding",
      tool_call: true,
      limit: { context: 32_768, output: 4_096 },
      cost: { input: 0, output: 0 },
    });
    const options = record(provider.options);
    expect(options.baseURL).toBe("{env:KEIKO_MODEL_GATEWAY_URL}");
    expect(Object.keys(options)).toEqual(["baseURL", "headers"]);
    expect(provider.env).toEqual([]);
    for (const tool of OPENCODE_PINNED_BUILT_IN_TOOLS) {
      expect(config.tools[tool]).toBe(false);
      expect(config.permission[tool]).toBe("deny");
    }
    for (const tool of OPENCODE_MODEL_VISIBLE_TOOL_NAMES) {
      expect(config.tools[tool]).toBe(true);
      expect(config.permission[tool]).toBe("allow");
    }
    expect(config.tools.keiko_repository_read).toBeUndefined();
    expect(config.tools.keiko_submit_changeset).toBeUndefined();
    expect(config.permission.keiko_repository_read).toBeUndefined();
    expect(config.permission.keiko_submit_changeset).toBeUndefined();
    expect(config.permission).toMatchObject({ "*": "deny" });
  });

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
      expect(profile.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
      expect(profile.env.OPENCODE_CONFIG_DIR).toBe("/private/run/config/opencode");
      expect(profile.env.OPENCODE_CONFIG).toBeUndefined();
      expect((JSON.parse(profile.config) as { permission: { bash: string } }).permission.bash).toBe(
        "deny",
      );
    }
  });

  it("keeps wildcard denial before exact governed allows through v1.17.17 tools migration", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      randomBytes: () => Buffer.alloc(32, 7),
    });
    if (!profile.ok) throw new Error("expected fixed managed launch profile");
    const config = JSON.parse(profile.config) as {
      readonly tools: Readonly<Record<string, boolean>>;
      readonly permission: Readonly<Record<string, string>>;
    };
    expect(Object.keys(config.tools)[0]).toBe("*");
    const rules = migratedPermissionRules(config);
    expect(finalPermissionAction(rules, "question")).toBe("allow");
    expect(finalPermissionAction(rules, "keiko_workspace_read")).toBe("allow");
    expect(finalPermissionAction(rules, "keiko_changeset_edit")).toBe("allow");
    for (const tool of ["bash", "read", "edit", "unknown_tool"]) {
      expect(finalPermissionAction(rules, tool)).toBe("deny");
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
