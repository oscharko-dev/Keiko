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
  readonly requests: unknown[];
}

/** Runs the generated plugin against a fetch stub that answers `allow` to every request it sees. */
async function pluginHarness(mode = "supervised-coding"): Promise<Harness> {
  const requests: unknown[] = [];
  const fetch = (_url: string, init: { body: string }): Promise<Response> => {
    requests.push(JSON.parse(init.body));
    return Promise.resolve(new Response(JSON.stringify({ effect: "allow" }), { status: 200 }));
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
  });
  if (evaluate === undefined || shell === undefined) throw new Error("hooks missing");
  return { evaluate, shell, requests };
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
