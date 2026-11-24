import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  createGeneratedOpenCodeNativePolicyPlugin,
  OPENCODE_NATIVE_NPM_RELAY_ENV,
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
  readonly requests: PolicyRequest[];
}

/** What the generated hook sends the facade, as far as these tests read it. */
interface PolicyRequest {
  readonly permission: string;
  readonly resources: readonly string[];
  readonly [field: string]: unknown;
}

/** Runs the generated plugin against a fetch stub that answers `allow` to every request it sees. */
async function pluginHarness(
  mode = "supervised-coding",
  answer: { readonly effect: "allow" | "deny"; readonly message?: string } = { effect: "allow" },
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<Harness> {
  const requests: PolicyRequest[] = [];
  const fetch = (_url: string, init: { body: string }): Promise<Response> => {
    requests.push(JSON.parse(init.body) as PolicyRequest);
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
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { servers: { synthetic: {} } } }),
        ...extraEnv,
      },
    },
    fetch,
    AbortSignal,
    TextEncoder,
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

  it("forwards only the UTF-8 size of the producer's diff of an edit, never the diff", async () => {
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+n\u00e9w\n";
    const harness = await pluginHarness();
    const edit = { ...event(["src/a.ts"]), metadata: { files: [{ file: "src/a.ts", patch }] } };
    await harness.evaluate(edit);
    expect(harness.requests[0]).toMatchObject({ patchBytes: Buffer.byteLength(patch, "utf8") });
    expect(JSON.stringify(harness.requests[0])).not.toContain("+n\u00e9w");
    const patched = {
      ...event(["src/a.ts", "src/b.ts"]),
      metadata: { filepath: "src/a.ts, src/b.ts", diff: [patch, patch] },
    };
    await harness.evaluate(patched);
    expect(harness.requests[1]).toMatchObject({ patchBytes: 2 * Buffer.byteLength(patch, "utf8") });
  });

  it("reports an edit without a diff as unmeasured and one it cannot measure as -1", async () => {
    const harness = await pluginHarness();
    await harness.evaluate(event(["src/a.ts"]));
    await harness.evaluate({ ...event(["src/a.ts"]), metadata: { files: [{ file: "src/a.ts" }] } });
    await harness.evaluate({ ...event(["**"]), action: "read", metadata: { files: [] } });
    const sizes = (harness.requests as readonly { readonly patchBytes?: unknown }[]).map(
      (request) => request.patchBytes,
    );
    expect(sizes).toEqual([null, -1, null]);
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
      // #3903 AC3: the server-owned binding carries every relayed MCP server's capability.
      OPENCODE_CONFIG_CONTENT: '{"mcp":{"servers":{}}}',
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

  it("lifts npm offline mode below Full access only when an npm registry is bound to the relay (#4530)", async () => {
    const env = (): Record<string, string> => ({
      PATH: "/usr/bin",
      npm_config_offline: "true",
      [OPENCODE_NATIVE_NPM_RELAY_ENV]: "bound",
    });
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
      const bound = await pluginHarness(
        mode,
        { effect: "allow" },
        { [OPENCODE_NATIVE_NPM_RELAY_ENV]: "bound" },
      );
      const shell = { env: env() };
      bound.shell(shell);
      // The offline setting is gone and the marker itself never reaches the shell.
      expect(shell.env).toEqual({ PATH: "/usr/bin" });
    }
    // Any other value of the marker binds nothing: the shell stays offline below Full access.
    const other = await pluginHarness(
      "supervised-coding",
      { effect: "allow" },
      { [OPENCODE_NATIVE_NPM_RELAY_ENV]: "yes" },
    );
    const shell = { env: env() };
    other.shell(shell);
    expect(shell.env).toEqual({ PATH: "/usr/bin", npm_config_offline: "true" });
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
      resources: ["feature"],
      source: { type: "tool", messageID: "msg_code_mode", id: "call_execute" },
    });
    const allowed = await pluginHarness("autonomous-delivery", { effect: "allow" });
    await expect(allowed.toolBefore(nested("opencode_session_move"))).resolves.toBeUndefined();
    expect(allowed.requests).toHaveLength(1);
  });

  // #3903 AC4: a move is decided by the directory it names and the session it moves.
  it("sends a session move's directory and target session, and a new worktree's name", async () => {
    const harness = await pluginHarness("supervised-coding", { effect: "allow" });
    await harness.toolBefore({
      ...nested("opencode_session_move"),
      input: { directory: "/workspace/src" },
    });
    await harness.toolBefore({
      ...nested("opencode_session_move"),
      input: { directory: "/workspace", sessionID: "ses_other" },
    });
    await harness.toolBefore({ ...nested("opencode_session_move"), input: { directory: 7 } });
    await harness.toolBefore({ ...nested("opencode_worktree_create"), input: { name: "/x" } });
    expect(harness.requests).toMatchObject([
      { resources: ["/workspace/src"], targetSessionID: null },
      { resources: ["/workspace"], targetSessionID: "ses_other" },
      { resources: [], targetSessionID: null },
      { permission: "opencode_worktree_create", resources: ["/x"], targetSessionID: null },
    ]);
  });

  // #4271, #4546: the producer's automation tools assert no permission, so the hook asks for one.
  it("asks policy for every automation change and names a refusal alone", async () => {
    const harness = await pluginHarness("supervised-coding", { effect: "allow" });
    await harness.toolBefore({
      ...nested("automation_create"),
      input: {
        name: "Build",
        trigger: { type: "every", every: "30 minutes" },
        action: { type: "prompt", prompt: "run the build" },
        expires: "in 8 hours",
      },
    });
    const refusedInputs = [
      {
        trigger: { type: "in", in: "1m" },
        action: { type: "prompt", prompt: "p" },
      },
      {
        trigger: { type: "event", server: "ci", event: "done" },
        action: { type: "prompt", prompt: "p" },
      },
      { trigger: { type: "at", at: "in 1m" }, action: { type: "shell", command: "id" } },
      { trigger: { type: "at", at: "in 1m" }, action: { type: "code", code: "return" } },
      {
        trigger: { type: "at", at: "in 1m" },
        action: { type: "prompt", prompt: "p", to: { subagent: "build" } },
      },
      {
        trigger: { type: "at", at: "in 1m" },
        action: { type: "prompt", prompt: "p", to: { session: "ses_other" } },
      },
      { trigger: "at", action: "prompt" },
      {},
    ];
    for (const input of refusedInputs)
      await harness.toolBefore({ ...nested("automation_create"), input });
    await harness.toolBefore({ ...nested("automation_delete"), input: { id: "aut_1" } });
    await harness.toolBefore({ ...nested("automation_list"), input: {} });
    // The 2.2.5 schedule tools are gone: their names are no governed management tools any more.
    await harness.toolBefore({ ...nested("schedule_create"), input: {} });

    expect(harness.requests).toHaveLength(1 + refusedInputs.length + 1);
    expect(harness.requests[0]).toMatchObject({
      permission: "opencode_schedule",
      resources: expect.arrayContaining([
        "create",
        'when:{"type":"every","every":"30 minutes"}',
        'expires:"in 8 hours"',
        "name:Build",
      ]) as unknown,
    });
    expect(harness.requests.slice(1, -1).map((request) => request.resources)).toEqual([
      ["create", "refused:trigger"],
      ["create", "refused:trigger"],
      ["create", "refused:action"],
      ["create", "refused:action"],
      ["create", "refused:target"],
      ["create", "refused:target"],
      ["create", "refused:trigger"],
      ["create", "refused:trigger"],
    ]);
    expect(harness.requests.at(-1)).toMatchObject({
      permission: "opencode_schedule",
      resources: ["delete", "aut_1"],
    });
  });

  // The producer drops keys its schema does not name, but a later pin may read one (another
  // recipient, a working folder): only the 2.4.1 request keys pass, each trigger with its own value
  // and `tz`, the prompt with `prompt` and the refused `to` (#4546 review).
  it("refuses an automation creation that carries a key outside the reviewed request shape", async () => {
    const harness = await pluginHarness("supervised-coding");
    const at = { type: "at", at: "in 1m" };
    const prompt = { type: "prompt", prompt: "p" };
    const inputs = [
      {
        name: "n",
        trigger: { type: "cron", cron: "0 9 * * 1-5", tz: "Europe/Berlin" },
        action: prompt,
      },
      { name: "n", trigger: at, action: prompt, directory: "/elsewhere" },
      { name: "n", trigger: at, action: prompt, sessionID: "ses_other" },
      { name: "n", trigger: { ...at, server: "ci" }, action: prompt },
      { name: "n", trigger: { type: "every", every: "1 hour", at: "x" }, action: prompt },
      { name: "n", trigger: at, action: { ...prompt, session: "ses_other" } },
      { name: "n", trigger: at, action: { ...prompt, agent: "build" } },
    ];
    for (const input of inputs) await harness.toolBefore({ ...nested("automation_create"), input });

    expect(harness.requests.map((request) => request.resources[1])).toEqual([
      'when:{"type":"cron","cron":"0 9 * * 1-5","tz":"Europe/Berlin"}',
      "refused:shape",
      "refused:shape",
      "refused:shape",
      "refused:shape",
      "refused:shape",
      "refused:shape",
    ]);
  });

  // An automation tool a later pin adds (an update, a run-now) is refused until it is reviewed,
  // rather than passing undecided; the listing only reads.
  it("refuses an automation tool it does not know, and leaves the listing undecided", async () => {
    const harness = await pluginHarness("autonomous-delivery");
    await harness.toolBefore({ ...nested("automation_list"), input: {} });
    await harness.toolBefore({ ...nested("automation_update"), input: { id: "aut_1" } });
    await harness.toolBefore({ ...nested("automation_run"), input: { id: "aut_1" } });

    expect(harness.requests.map((request) => [request.permission, request.resources])).toEqual([
      ["opencode_schedule", ["update", "aut_1"]],
      ["opencode_schedule", ["run", "aut_1"]],
    ]);
  });

  it("blocks an automation change the policy refuses", async () => {
    const refused = await pluginHarness("governed-assist", {
      effect: "deny",
      message: "no schedule",
    });

    await expect(
      refused.toolBefore({ ...nested("automation_pause"), input: { id: "aut_1" } }),
    ).rejects.toThrow("no schedule");
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
    // The human reviews the program itself: its text is the ask's resource (never logged).
    expect(refused.requests[0]).toMatchObject({
      permission: "execute",
      resources: ["return 1 + 1;"],
      source: { type: "tool", messageID: "msg_code_mode", id: "call_execute" },
    });
    const allowed = await pluginHarness("autonomous-delivery", { effect: "allow" });
    await expect(allowed.toolBefore(nested("execute"))).resolves.toBeUndefined();
    expect(allowed.requests).toHaveLength(1);
  });

  it("splits a long program at line breaks into bounded review resources", async () => {
    const harness = await pluginHarness("supervised-coding", { effect: "allow" });
    const line = "x".repeat(1_500);
    const code = [line, line, "return 1;"].join("\n");
    await harness.toolBefore({ ...nested("execute"), input: { code } });
    const resources = (harness.requests[0] as { readonly resources?: readonly string[] }).resources;
    expect(resources).toEqual([line, `${line}\nreturn 1;`]);
    expect(resources?.join("\n")).toBe(code);
  });

  it("refuses a program with a line too long to review without asking policy", async () => {
    const harness = await pluginHarness("autonomous-delivery", { effect: "allow" });
    await expect(
      harness.toolBefore({ ...nested("execute"), input: { code: "y".repeat(2_049) } }),
    ).rejects.toThrow(/too large to review/u);
    expect(harness.requests).toHaveLength(0);
  });

  // #4359: a rename asserted no permission and was decided by nothing; it is now governed like a
  // move, by the title it sets and the session it renames.
  it("sends a session rename's title and target session, and blocks it on refusal", async () => {
    const harness = await pluginHarness("supervised-coding", { effect: "allow" });
    await harness.toolBefore({ ...nested("opencode_session_rename"), input: { title: "Plan" } });
    await harness.toolBefore({
      ...nested("opencode_session_rename"),
      input: { title: "Other", sessionID: "ses_other" },
    });
    expect(harness.requests).toMatchObject([
      { permission: "opencode_session_rename", resources: ["Plan"], targetSessionID: null },
      { permission: "opencode_session_rename", resources: ["Other"], targetSessionID: "ses_other" },
    ]);
    const refused = await pluginHarness("supervised-coding", { effect: "deny", message: "no" });
    await expect(
      refused.toolBefore({ ...nested("opencode_session_rename"), input: { title: "x" } }),
    ).rejects.toThrow("no");
  });

  it("leaves Code Mode's read-only or self-asserting tools to the runtime", async () => {
    const harness = await pluginHarness("supervised-coding", { effect: "deny" });
    for (const tool of [
      "opencode_models",
      "opencode_worktree_list",
      "opencode_list_mcp_resources",
      "opencode_read_mcp_resource",
      "opencode_worktree_remove",
    ]) {
      await expect(harness.toolBefore(nested(tool)), tool).resolves.toBeUndefined();
    }
    expect(harness.requests).toHaveLength(0);
  });
});

it("forwards MCP input only for the server-owned configured namespace", async () => {
  const harness = await pluginHarness();
  const input = { text: "private synthetic text" };
  await harness.evaluate({
    sessionID: "ses_plugin",
    action: "synthetic_create_note",
    resources: [],
    effect: "allow",
    metadata: { input },
  });
  expect(harness.requests[0]).toMatchObject({ mcpInput: input });
  await harness.evaluate({ ...event([]), metadata: { input } });
  expect(harness.requests[1]).not.toHaveProperty("mcpInput");
});
