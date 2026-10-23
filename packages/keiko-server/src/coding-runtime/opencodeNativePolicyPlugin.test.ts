import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  createGeneratedOpenCodeNativePolicyPlugin,
  OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS,
  OPENCODE_NATIVE_POLICY_MAX_RESOURCES,
} from "./opencodeNativePolicyPlugin.js";

interface PermissionEvent {
  sessionID: string;
  action: string;
  resources: unknown;
  effect: "allow" | "ask" | "deny";
  message?: string;
  metadata?: Record<string, unknown>;
}

interface ShellEvent {
  env: Record<string, string>;
}

interface ToolEvent {
  tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  input: unknown;
}

interface PolicyPlugin {
  readonly setup: (context: {
    readonly permission: {
      readonly hook: (
        name: string,
        callback: (event: PermissionEvent) => Promise<void>,
      ) => Promise<void>;
    };
    readonly shell: {
      readonly hook: (name: string, callback: (event: ShellEvent) => void) => Promise<void>;
    };
    readonly tool: {
      readonly hook: (name: string, callback: (event: ToolEvent) => Promise<void>) => Promise<void>;
    };
  }) => Promise<void>;
}

function isPolicyPlugin(value: unknown): value is PolicyPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "setup" in value &&
    typeof value.setup === "function"
  );
}

interface Harness {
  readonly evaluate: (event: PermissionEvent) => Promise<void>;
  readonly shell: (event: ShellEvent) => void;
  readonly toolBefore: (event: ToolEvent) => Promise<void>;
  readonly requests: unknown[];
}

/** Runs the generated plugin against a fetch stub that answers `allow` to every request it sees. */
async function pluginHarness(
  mode = "supervised-coding",
  answer: { readonly effect: "allow" | "deny"; readonly message?: string } = { effect: "allow" },
): Promise<Harness> {
  const requests: unknown[] = [];
  const fetch = (_url: string, init: { body: string }): Promise<Response> => {
    requests.push(JSON.parse(init.body));
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
  };
  const source = createGeneratedOpenCodeNativePolicyPlugin();
  const value: unknown = new Script(
    source.replace("export default", "const plugin =") + "\nplugin;",
  ).runInNewContext({
    process: {
      env: {
        KEIKO_TOOL_FACADE_URL: "http://127.0.0.1:9/facade",
        KEIKO_TOOL_FACADE_CAPABILITY: "capability",
        KEIKO_CODING_RUN_ID: "run-plugin",
        KEIKO_CODING_MODE: mode,
      },
    },
    fetch,
    AbortSignal,
    JSON,
    Set,
    Array,
    String,
    Object,
  });
  if (!isPolicyPlugin(value)) throw new TypeError("native policy plugin invalid");
  let evaluate: ((event: PermissionEvent) => Promise<void>) | undefined;
  let shell: ((event: ShellEvent) => void) | undefined;
  let toolBefore: ((event: ToolEvent) => Promise<void>) | undefined;
  await value.setup({
    permission: {
      hook: (name, callback): Promise<void> => {
        if (name === "evaluate") evaluate = callback;
        return Promise.resolve();
      },
    },
    shell: {
      hook: (name, callback): Promise<void> => {
        if (name === "create.before") shell = callback;
        return Promise.resolve();
      },
    },
    tool: {
      hook: (name, callback): Promise<void> => {
        if (name === "execute.before") toolBefore = callback;
        return Promise.resolve();
      },
    },
  });
  if (evaluate === undefined || shell === undefined || toolBefore === undefined)
    throw new Error("hooks missing");
  return { evaluate, shell, toolBefore, requests };
}

function event(resources: unknown): PermissionEvent {
  return { sessionID: "ses_plugin", action: "edit", resources, effect: "allow" };
}

describe("generated native policy plugin resource bounds (#3897)", () => {
  it("forwards a complete in-bounds resource list unchanged", async () => {
    const harness = await pluginHarness();
    const resources = Array.from(
      { length: OPENCODE_NATIVE_POLICY_MAX_RESOURCES },
      (_, i) => `src/file-${String(i)}.ts`,
    );
    const evaluated = event(resources);
    await harness.evaluate(evaluated);
    expect(evaluated.effect).toBe("allow");
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ resources });
  });

  it("refuses an oversized resource list instead of clipping the authority input", async () => {
    const harness = await pluginHarness();
    const resources = [
      ...Array.from(
        { length: OPENCODE_NATIVE_POLICY_MAX_RESOURCES },
        (_, i) => `src/file-${String(i)}.ts`,
      ),
      ".env",
    ];
    const evaluated = event(resources);
    await harness.evaluate(evaluated);
    expect(evaluated.effect).toBe("deny");
    expect(harness.requests).toHaveLength(0);
  });

  it("refuses an over-long or non-string resource without asking policy", async () => {
    for (const resources of [
      ["x".repeat(OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS + 1)],
      [42],
      "not-a-list",
    ]) {
      const harness = await pluginHarness();
      const evaluated = event(resources);
      await harness.evaluate(evaluated);
      expect(evaluated.effect).toBe("deny");
      expect(harness.requests).toHaveLength(0);
    }
    const harness = await pluginHarness();
    const atBound = event(["x".repeat(OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS)]);
    await harness.evaluate(atBound);
    expect(atBound.effect).toBe("allow");
    expect(harness.requests).toHaveLength(1);
  });
});

describe("generated native policy plugin forwarding and precedence (#3897 audit)", () => {
  it("forwards the searched directory of glob and grep from the permission metadata", async () => {
    const harness = await pluginHarness();
    const evaluated = {
      ...event(["// TODO"]),
      action: "grep",
      metadata: { path: "/work/ws/src", pattern: "// TODO" },
    };
    await harness.evaluate(evaluated);
    expect(harness.requests[0]).toMatchObject({
      searchPath: "/work/ws/src",
      resources: ["// TODO"],
    });
  });

  it("keeps an earlier hook's deny without asking policy", async () => {
    const harness = await pluginHarness();
    const denied: PermissionEvent = { ...event(["src/a.ts"]), effect: "deny", message: "managed" };
    await harness.evaluate(denied);
    expect(denied.effect).toBe("deny");
    expect(denied.message).toBe("managed");
    expect(harness.requests).toHaveLength(0);
  });

  it("explains an oversized request instead of blaming the policy service", async () => {
    const harness = await pluginHarness();
    const evaluated = event(["x".repeat(OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS + 1)]);
    await harness.evaluate(evaluated);
    expect(evaluated.effect).toBe("deny");
    expect(evaluated.message).toMatch(/too large to review/u);
  });

  it("strips Keiko bindings from every shell and lifts npm offline mode only at Full access", async () => {
    const env = (): Record<string, string> => ({
      PATH: "/usr/bin",
      KEIKO_TOOL_FACADE_CAPABILITY: "secret",
      OPENCODE_SERVER_PASSWORD: "secret",
      npm_config_offline: "true",
    });
    const supervised = await pluginHarness("supervised-coding");
    const below = { env: env() };
    supervised.shell(below);
    expect(below.env).toEqual({ PATH: "/usr/bin", npm_config_offline: "true" });
    const full = await pluginHarness("autonomous-delivery");
    const atFull = { env: env() };
    full.shell(atFull);
    expect(atFull.env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("generated native policy plugin Code Mode governance (#3897)", () => {
  const nested = (tool: string): ToolEvent => ({
    tool,
    sessionID: "ses_plugin",
    agent: "build",
    messageID: "msg_code_mode",
    id: "call_execute",
    input: { name: "feature" },
  });

  it("asks policy for a state-changing management tool and blocks it on refusal", async () => {
    const refused = await pluginHarness("autonomous-delivery", {
      effect: "deny",
      message: "managed by Keiko",
    });
    await expect(refused.toolBefore(nested("opencode_worktree_create"))).rejects.toThrow(
      "managed by Keiko",
    );
    expect(refused.requests[0]).toMatchObject({
      permission: "opencode_worktree_create",
      resources: [],
      source: { type: "tool", messageID: "msg_code_mode", id: "call_execute" },
    });
    const allowed = await pluginHarness("autonomous-delivery", { effect: "allow" });
    await expect(allowed.toolBefore(nested("opencode_session_move"))).resolves.toBeUndefined();
    expect(allowed.requests).toHaveLength(1);
  });

  // #3897 review: the producer asserts no permission for a Code Mode program, so without this the
  // mode policy never gated model-authored JavaScript (its `fetch` reaches loopback services) even in
  // Ask for approval. The program is decided like a command, before it starts.
  it("asks policy for a Code Mode program and blocks it before it starts on refusal", async () => {
    const refused = await pluginHarness("governed-assist", {
      effect: "deny",
      message: "needs approval",
    });
    await expect(
      refused.toolBefore({ ...nested("execute"), input: { code: "return 1 + 1;" } }),
    ).rejects.toThrow("needs approval");
    expect(refused.requests[0]).toMatchObject({
      permission: "execute",
      resources: [],
      source: { type: "tool", messageID: "msg_code_mode", id: "call_execute" },
    });
    expect(JSON.stringify(refused.requests)).not.toContain("return 1 + 1");
    const allowed = await pluginHarness("autonomous-delivery", { effect: "allow" });
    await expect(allowed.toolBefore(nested("execute"))).resolves.toBeUndefined();
    expect(allowed.requests).toHaveLength(1);
  });

  it("leaves Code Mode's read-only or self-asserting tools to the runtime", async () => {
    const harness = await pluginHarness("supervised-coding", { effect: "deny" });
    for (const tool of [
      "opencode_models",
      "opencode_worktree_list",
      "opencode_session_rename",
      "opencode_list_mcp_resources",
      "opencode_read_mcp_resource",
      "opencode_worktree_remove",
    ]) {
      await expect(harness.toolBefore(nested(tool)), tool).resolves.toBeUndefined();
    }
    expect(harness.requests).toHaveLength(0);
  });
});
