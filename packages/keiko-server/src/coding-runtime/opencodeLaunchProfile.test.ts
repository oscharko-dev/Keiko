import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOpenCodeLaunchProfile,
  createFixedOpenCodeV2Config,
  OPENCODE_GOVERNED_COMPACTION_PROMPT,
  OPENCODE_GOVERNED_SYSTEM_PROMPT,
  OPENCODE_GOVERNED_V2_SYSTEM_PROMPT,
  resolveOpenCodeContextGeometry,
  type OpenCodeLaunchProfileInput,
} from "./opencodeLaunchProfile.js";
import {
  OPENCODE_GOVERNED_ACTION_PERMISSION,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  OPENCODE_PINNED_BUILT_IN_TOOLS,
} from "./opencodeToolSchemas.js";
import { CODING_TOOL_MAX_BODY_BYTES } from "./codingToolIpc.js";

const CONTEXT_GEOMETRY = {
  contextWindowTokens: 65_536,
  maxInputTokens: 61_440,
  maxOutputTokens: 4_096,
} as const;
const CONTEXT_INPUT = { contextGeometry: CONTEXT_GEOMETRY } as const;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function finalPermissionAction(
  rules: readonly { readonly action: string; readonly effect: string }[],
  tool: string,
): string | undefined {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule !== undefined && (rule.action === "*" || rule.action === tool)) {
      return rule.effect;
    }
  }
  return undefined;
}

function v2Rules(config: Readonly<Record<string, unknown>>): readonly {
  readonly action: string;
  readonly effect: string;
}[] {
  if (!Array.isArray(config.permissions)) throw new Error("expected V2 permissions");
  return config.permissions as readonly { readonly action: string; readonly effect: string }[];
}

describe("OpenCode launch profile", () => {
  it("distinguishes ready delivery proposals from proposals requiring human approval", () => {
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain("approval-required");
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain("ready");
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).not.toContain(
      "A proposal needs a human approval through the operator's own approval channel before it can proceed.",
    );
  });
  it("disables upstream snapshots with a deterministic server-owned config digest", () => {
    const input = {
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      ...CONTEXT_INPUT,
      randomBytes: (): Buffer => Buffer.alloc(32, 7),
      snapshot: true,
    } satisfies OpenCodeLaunchProfileInput & { readonly snapshot: boolean };
    const first = buildOpenCodeLaunchProfile(input);
    const second = buildOpenCodeLaunchProfile({ ...input, randomBytes: () => Buffer.alloc(32, 9) });
    if (!first.ok || !second.ok) throw new Error("expected fixed managed launch profiles");
    const config = JSON.parse(first.config) as Readonly<Record<string, unknown>>;
    expect(config.snapshots).toBe(false);
    expect(second.config).toBe(first.config);
    const digest = (value: string): string =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const legacyShape = { ...config };
    Reflect.deleteProperty(legacyShape, "snapshots");
    expect(digest(first.config)).toBe(digest(second.config));
    expect(digest(first.config)).not.toBe(digest(JSON.stringify(legacyShape)));
  });

  it("emits the pinned V2 model/provider and exact model-visible permission configuration", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      ...CONTEXT_INPUT,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    if (!profile.ok) throw new Error("expected fixed managed launch profile");
    const config = JSON.parse(profile.config) as {
      readonly model: string;
      readonly agents: Readonly<Record<string, unknown>>;
      readonly providers: Readonly<Record<string, unknown>>;
      readonly permissions: readonly { readonly action: string; readonly effect: string }[];
    };
    expect(config.model).toBe("keiko-runtime/coding");
    expect(Object.keys(config.agents)).toEqual(["build", "compaction"]);
    expect(record(config.agents.build)).toEqual({ system: OPENCODE_GOVERNED_V2_SYSTEM_PROMPT });
    expect(record(config.agents.compaction)).toEqual({
      system: OPENCODE_GOVERNED_COMPACTION_PROMPT,
    });
    const provider = record(config.providers["keiko-runtime"]);
    expect(provider).toMatchObject({
      name: "Keiko Governed Coding Gateway",
      package: "@opencode/ai/providers/openai-compatible",
    });
    expect(Object.keys(record(provider.models))).toEqual(["coding"]);
    expect(record(record(provider.models).coding)).toEqual({
      name: "Keiko Governed Coding",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 65_536, input: 61_440, output: 4_096 },
      cost: { input: 0, output: 0 },
    });
    const settings = record(provider.settings);
    expect(settings.baseURL).toBe("{env:KEIKO_MODEL_GATEWAY_URL}");
    expect(settings.chunkTimeout).toBe(30 * 60_000);
    expect(provider.headers).toEqual({
      Authorization: "Bearer {env:KEIKO_MODEL_GATEWAY_CAPABILITY}",
    });
    expect(config.permissions[0]).toMatchObject({ action: "*", effect: "deny" });
    for (const tool of OPENCODE_PINNED_BUILT_IN_TOOLS) {
      expect(finalPermissionAction(config.permissions, tool)).toBe(
        tool === "todowrite" ? "allow" : "deny",
      );
    }
    for (const tool of OPENCODE_MODEL_VISIBLE_TOOL_NAMES) {
      expect(finalPermissionAction(config.permissions, tool)).toBe("allow");
    }
    expect(finalPermissionAction(config.permissions, OPENCODE_GOVERNED_ACTION_PERMISSION)).toBe(
      "deny",
    );
    expect(finalPermissionAction(config.permissions, "keiko_repository_read")).toBe("deny");
    expect(finalPermissionAction(config.permissions, "keiko_submit_changeset")).toBe("deny");
  });

  it("documents every model-visible tool and the built-in prohibition in the agent prompt", () => {
    // The V2 child resolves the coding model with its default agent; the governed system
    // override is what live models actually receive, so every
    // projected tool must be taught there and the removed built-ins must be named as absent.
    for (const tool of OPENCODE_MODEL_VISIBLE_TOOL_NAMES) {
      expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain(tool);
    }
    for (const builtIn of ["bash", "grep", "glob", "webfetch", "apply_patch", "git"]) {
      expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain(builtIn);
    }
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain("must never be called");
    // The pinned built-in "skill" collides with the governed keiko_skill by name; the prompt must
    // disambiguate instead of leaving the built-in unmentioned.
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain("skills run only through keiko_skill");
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain("expectedContentHash");
    // #3390: a message-policy block must be self-correctable from the tool result alone -- the
    // model must read `violations` and fix the message itself, never ask the operator for a
    // format.
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain("violations");
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain("never ask the operator which commit format");
    for (const verifier of ["test", "targeted-test", "typecheck", "lint", "build"]) {
      expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).toContain(verifier);
    }
  });

  it("uses only fixed server-owned loopback arguments and isolated state", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      ...CONTEXT_INPUT,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    expect(profile.ok).toBe(true);
    if (profile.ok) {
      expect(profile.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
      expect(profile.env.OPENCODE_SERVER_PASSWORD).toHaveLength(43);
      expect(profile.env.PATH).toBeUndefined();
      expect(profile.env.HOME).toContain("/private/run");
      expect(profile.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
      expect(profile.env.npm_config_offline).toBe("true");
      expect(profile.env.OPENCODE_CONFIG_DIR).toBe("/private/run/config/opencode");
      expect(profile.env.OPENCODE_CONFIG).toBeUndefined();
      const config = JSON.parse(profile.config) as {
        readonly permissions: readonly { readonly action: string; readonly effect: string }[];
      };
      expect(finalPermissionAction(config.permissions, "bash")).toBe("deny");
    }
  });

  it("aligns native tool-output truncation with the governed response ceiling", () => {
    const config = createFixedOpenCodeV2Config(CONTEXT_GEOMETRY);
    expect(config.tool_output).toEqual({ max_bytes: CODING_TOOL_MAX_BODY_BYTES });
  });

  it("keeps wildcard denial before exact governed allows in the V2 permission list", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      ...CONTEXT_INPUT,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    if (!profile.ok) throw new Error("expected fixed managed launch profile");
    const config = JSON.parse(profile.config) as {
      readonly permissions: readonly { readonly action: string; readonly effect: string }[];
    };
    expect(config.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(finalPermissionAction(config.permissions, "question")).toBe("allow");
    expect(finalPermissionAction(config.permissions, "keiko_workspace_read")).toBe("allow");
    expect(finalPermissionAction(config.permissions, "keiko_changeset_edit")).toBe("allow");
    expect(finalPermissionAction(config.permissions, OPENCODE_GOVERNED_ACTION_PERMISSION)).toBe(
      "deny",
    );
    for (const tool of ["bash", "read", "edit", "unknown_tool"]) {
      expect(finalPermissionAction(config.permissions, tool)).toBe("deny");
    }
  });

  // #3414-AC9: an optional tool whose handler/readiness/policy prerequisite is unavailable for
  // this run must be ABSENT from what the model is told exists (no allow rule),
  // not merely denied when called -- static catalog membership alone
  // must never make it appear ready.
  it("denies an unavailable optional tool in the V2 permission list (#3414-AC9)", () => {
    const config = createFixedOpenCodeV2Config(
      CONTEXT_GEOMETRY,
      new Set(["keiko_research_fetch", "keiko_skill_discover", "keiko_skill"]),
    );
    const rules = v2Rules(config);
    expect(finalPermissionAction(rules, "keiko_research_fetch")).toBe("deny");
    expect(finalPermissionAction(rules, "keiko_skill")).toBe("deny");
    // #3417: skill discovery is absent together with the skill it would list.
    expect(finalPermissionAction(rules, "keiko_skill_discover")).toBe("deny");
    // A sibling optional tool with no unavailability entry stays available.
    expect(finalPermissionAction(rules, "keiko_child_agent")).toBe("allow");
    // A required (non-optional) tool is never affected by this mechanism.
    expect(finalPermissionAction(rules, "keiko_workspace_read")).toBe("allow");
  });

  it("leaves every optional tool available, and the config byte-identical, when omitted", () => {
    const withoutInput = JSON.stringify(createFixedOpenCodeV2Config(CONTEXT_GEOMETRY));
    const withEmptySet = JSON.stringify(createFixedOpenCodeV2Config(CONTEXT_GEOMETRY, new Set()));
    expect(withoutInput).toBe(withEmptySet);
    const parsed = JSON.parse(withoutInput) as Readonly<Record<string, unknown>>;
    expect(finalPermissionAction(v2Rules(parsed), "keiko_research_fetch")).toBe("allow");
    expect(finalPermissionAction(v2Rules(parsed), "keiko_skill")).toBe("allow");
    expect(finalPermissionAction(v2Rules(parsed), "keiko_child_agent")).toBe("allow");
  });

  it("threads unavailableOptionalTools from buildOpenCodeLaunchProfile into the launched config", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/managed/opencode",
      stateRoot: "/private/run",
      ...CONTEXT_INPUT,
      randomBytes: () => Buffer.alloc(32, 7),
      unavailableOptionalTools: new Set(["keiko_child_agent"]),
    });
    if (!profile.ok) throw new Error("expected fixed managed launch profile");
    const config = JSON.parse(profile.config) as {
      readonly permissions: readonly { readonly action: string; readonly effect: string }[];
    };
    expect(finalPermissionAction(config.permissions, "keiko_child_agent")).toBe("deny");
  });

  it("fails closed for non-absolute executable or insufficient secret entropy", () => {
    expect(
      buildOpenCodeLaunchProfile({ executable: "opencode", stateRoot: "/x", ...CONTEXT_INPUT }),
    ).toEqual({
      ok: false,
      reason: "invalid-launch-input",
    });
    expect(
      buildOpenCodeLaunchProfile({
        executable: "/x",
        stateRoot: "/x",
        ...CONTEXT_INPUT,
        randomBytes: () => Buffer.alloc(31),
      }),
    ).toEqual({ ok: false, reason: "secret-generation-failed" });
  });

  it("derives model-specific limits below the raw JSON transport ceiling", () => {
    const smaller = resolveOpenCodeContextGeometry({
      maxPromptTokens: 64_000,
      maxOutputTokens: 4_000,
      maxInputMessages: 512,
      maxRequestBytes: 1_048_576,
    });
    const larger = resolveOpenCodeContextGeometry({
      maxPromptTokens: 1_050_000,
      maxOutputTokens: 32_000,
      maxInputMessages: 512,
      maxRequestBytes: 1_048_576,
    });

    expect(smaller).toEqual({
      contextWindowTokens: 44_960,
      maxInputTokens: 40_960,
      maxOutputTokens: 4_000,
    });
    expect(larger).toEqual({
      contextWindowTokens: 72_960,
      maxInputTokens: 40_960,
      maxOutputTokens: 32_000,
    });
    if (smaller === undefined) throw new Error("expected admitted context geometry");
    const escapedTranscript = JSON.stringify({
      messages: [{ role: "user", content: "\0".repeat(smaller.maxInputTokens * 4) }],
    });
    expect(Buffer.byteLength(escapedTranscript, "utf8")).toBeLessThan(1_048_576);
  });

  it("fails closed when admitted model or transport geometry is unknown or contradictory", () => {
    expect(buildOpenCodeLaunchProfile({ executable: "/x", stateRoot: "/x" })).toEqual({
      ok: false,
      reason: "invalid-launch-input",
    });
    expect(
      resolveOpenCodeContextGeometry({
        maxPromptTokens: 4_096,
        maxOutputTokens: 4_096,
        maxInputMessages: 512,
        maxRequestBytes: 1_048_576,
      }),
    ).toBeUndefined();
  });
});
