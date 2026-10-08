import { Script } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { opencodeRegistrationSet } from "@oscharko-dev/keiko-tool-catalog";
import * as runtimeAdapter from "./opencodeRuntimeAdapter.js";
const { createGeneratedOpenCodeV2Plugins } = runtimeAdapter;

interface NativeContext {
  readonly sessionID: string;
  readonly id: string;
  readonly agent: string;
  readonly messageID: string;
}
interface GeneratedResult {
  readonly content: string;
  readonly output?: unknown;
}
interface GeneratedTool {
  readonly name: string;
  readonly output?: unknown;
  readonly options?: { readonly permission?: string; readonly codemode?: boolean };
  readonly execute: (
    input: Record<string, unknown>,
    context: NativeContext,
  ) => Promise<GeneratedResult>;
}
type Hook = (event: NativeContext & { readonly tool: string }) => void | Promise<void>;
interface Plugin {
  readonly setup: (context: {
    readonly tool: {
      readonly hook: (name: string, callback: Hook) => Promise<unknown>;
      readonly transform: (
        callback: (editor: { readonly add: (tool: GeneratedTool) => void }) => void,
      ) => Promise<unknown>;
    };
  }) => Promise<unknown>;
}
const CONTEXT = {
  sessionID: "ses_boundary",
  id: "call_native_outer",
  agent: "build",
  messageID: "msg_original",
};
const RESPONSE = {
  status: "completed",
  evidence: [{ kind: "governed-delegate", code: "completed" }],
};
async function registered(
  input: {
    readonly profile?: "direct" | "code-mode";
    readonly answer?: unknown;
    readonly mode?: string;
    readonly responseStatus?: number;
    readonly respond?: (body: Record<string, unknown>) => Promise<Response>;
  } = {},
): Promise<{
  readonly tools: Map<string, GeneratedTool>;
  readonly bodies: Record<string, unknown>[];
  readonly hook: (name: string, event: NativeContext & { readonly tool: string }) => Promise<void>;
  readonly dispose: () => void;
}> {
  const tools = new Map<string, GeneratedTool>();
  const hooks = new Map<string, Hook[]>();
  const bodies: Record<string, unknown>[] = [];
  const cleanups: (() => void)[] = [];
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins(input.profile))) {
    if (name === "keiko_native_context") continue;
    const plugin = new Script(
      `${source.replace("export default", "const generated =")}\ngenerated;`,
    ).runInNewContext({
      process: {
        env: {
          KEIKO_CODING_MODE: input.mode ?? "autonomous-delivery",
          KEIKO_CODING_RUN_ID: "run-boundary",
          KEIKO_TOOL_FACADE_URL: "http://127.0.0.1/fixture",
          KEIKO_TOOL_FACADE_CAPABILITY: "fixture",
        },
      },
      crypto: webcrypto,
      fetch: (_url: unknown, init: { readonly body: string }): Promise<Response> => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        bodies.push(body);
        if (input.respond !== undefined) return input.respond(body);
        return Promise.resolve(
          new Response(JSON.stringify(input.answer ?? RESPONSE), {
            status: input.responseStatus ?? 200,
          }),
        );
      },
      AbortController,
      AbortSignal,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      setTimeout,
      clearTimeout,
    }) as Plugin;
    const cleanup = await plugin.setup({
      tool: {
        hook: (eventName, callback): Promise<unknown> => {
          const all = hooks.get(eventName) ?? [];
          all.push(callback);
          hooks.set(eventName, all);
          return Promise.resolve({ dispose: (): void => undefined });
        },
        transform: (callback): Promise<unknown> => {
          callback({
            add: (value): void => {
              if (tools.has(value.name)) throw new Error("duplicate-native-tool");
              tools.set(value.name, value);
            },
          });
          return Promise.resolve();
        },
      },
    });
    if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
  }
  return {
    tools,
    bodies,
    dispose: (): void => {
      for (const cleanup of cleanups) cleanup();
    },
    hook: async (name, event): Promise<void> => {
      for (const callback of hooks.get(name) ?? []) await callback(event);
    },
  };
}
function tool(fixture: Awaited<ReturnType<typeof registered>>, name: string): GeneratedTool {
  const result = fixture.tools.get(name);
  if (result === undefined) throw new Error("missing-generated-tool");
  return result;
}
describe("native CodeMode adapter boundary without activation", () => {
  it("shares one registration closure while retaining every native tool name", async () => {
    const fixture = await registered();
    expect(
      Object.keys(createGeneratedOpenCodeV2Plugins()).filter(
        (name) => name !== "keiko_native_context",
      ),
    ).toHaveLength(1);
    expect([...fixture.tools.keys()].sort()).toEqual(
      opencodeRegistrationSet()
        .entries.map((entry) => entry.alias)
        .sort(),
    );
  });
  it("captures different sequential inner identities even when native context ID is reused", async () => {
    const fixture = await registered();
    await fixture.hook("execute.before", { ...CONTEXT, tool: "execute" });
    await tool(fixture, "keiko_git_status").execute({}, { ...CONTEXT });
    await tool(fixture, "keiko_git_diff").execute(
      { scope: "working-tree", paths: ["a.ts"] },
      { ...CONTEXT },
    );
    expect(new Set(fixture.bodies.map((body) => body.actionId)).size).toBe(2);
    expect(fixture.bodies.every((body) => body.actionId === body.idempotencyKey)).toBe(true);
  });
  it("keeps direct identity and supplies canonical structured result beside original content", async () => {
    const fixture = await registered();
    const result = await tool(fixture, "keiko_git_status").execute({}, CONTEXT);
    expect(fixture.bodies[0]).toMatchObject({
      actionId: "ses_boundary:call_native_outer",
      idempotencyKey: "ses_boundary:call_native_outer",
    });
    expect(result.content).toBe(JSON.stringify(RESPONSE));
    expect(result.output).toEqual(RESPONSE);
    expect(tool(fixture, "keiko_git_status").output).toEqual(
      opencodeRegistrationSet().entries.find((entry) => entry.alias === "keiko_git_status")
        ?.descriptor.resultSchema,
    );
  });
});

it("allocates each concurrent inner call before asynchronous transport and captures mutable arguments", async () => {
  const fixture = await registered();
  await fixture.hook("execute.before", { ...CONTEXT, tool: "execute" });
  const args = { scope: "working-tree", paths: ["before.ts"] };
  const pending = tool(fixture, "keiko_git_diff").execute(args, { ...CONTEXT });
  args.paths.push("after.ts");
  await Promise.all([
    pending,
    tool(fixture, "keiko_git_status").execute({}, { ...CONTEXT }),
    tool(fixture, "keiko_git_status").execute({}, { ...CONTEXT }),
  ]);
  expect(new Set(fixture.bodies.map((body) => body.actionId)).size).toBe(3);
  expect(fixture.bodies.find((body) => body.operation === "diff")).toMatchObject({
    paths: ["before.ts"],
  });
});
it("inner after hooks preserve the parent; outer completion refuses later calls and reused parent IDs", async () => {
  const fixture = await registered();
  await fixture.hook("execute.before", { ...CONTEXT, tool: "execute" });
  await tool(fixture, "keiko_git_status").execute({}, CONTEXT);
  await fixture.hook("execute.after", { ...CONTEXT, tool: "keiko_git_status" });
  await tool(fixture, "keiko_git_status").execute({}, CONTEXT);
  await fixture.hook("execute.after", { ...CONTEXT, tool: "execute" });
  await expect(tool(fixture, "keiko_git_status").execute({}, CONTEXT)).rejects.toThrow(
    "keiko-tool-invalid",
  );
  await expect(fixture.hook("execute.before", { ...CONTEXT, tool: "execute" })).rejects.toThrow(
    "keiko-tool-invalid",
  );
  expect(fixture.bodies).toHaveLength(2);
});
it("setup cleanup refuses all late calls without an assumed cancellation hook", async () => {
  const fixture = await registered();
  fixture.dispose();
  await expect(tool(fixture, "keiko_git_status").execute({}, CONTEXT)).rejects.toThrow(
    "keiko-tool-unavailable",
  );
  expect(fixture.bodies).toHaveLength(0);
});
it.each([{ agent: "different" }, { messageID: "msg_different" }])(
  "refuses an inner context whose producer parent binding changed: %s",
  async (drift) => {
    const fixture = await registered();
    await fixture.hook("execute.before", { ...CONTEXT, tool: "execute" });
    await expect(
      tool(fixture, "keiko_git_status").execute({}, { ...CONTEXT, ...drift }),
    ).rejects.toThrow("keiko-tool-invalid");
    expect(fixture.bodies).toHaveLength(0);
  },
);
it("approval and actual tool request share the same once-captured inner identity", async () => {
  const fixture = await registered({ mode: "governed-assist" });
  await fixture.hook("execute.before", { ...CONTEXT, tool: "execute" });
  await tool(fixture, "keiko_verification").execute(
    { verifierId: "typecheck", targetPath: "" },
    CONTEXT,
  );
  await tool(fixture, "keiko_verification").execute(
    { verifierId: "typecheck", targetPath: "" },
    { ...CONTEXT },
  );
  expect(fixture.bodies).toHaveLength(4);
  for (const index of [0, 2]) {
    const ask = fixture.bodies[index];
    const request = fixture.bodies[index + 1];
    expect(ask?.actionId).toBe(request?.actionId);
    expect((ask?.properties as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      actionId: request?.actionId,
      idempotencyKey: request?.idempotencyKey,
      approvalId: request?.actionId,
    });
  }
  expect(fixture.bodies[0]?.actionId).not.toBe(fixture.bodies[2]?.actionId);
});
it("a governed refusal retains structured result and invokes no effect request", async () => {
  const refused = { status: "denied", evidence: [] };
  const fixture = await registered({
    mode: "governed-assist",
    responseStatus: 409,
    answer: refused,
  });
  const result = await tool(fixture, "keiko_verification").execute(
    { verifierId: "typecheck", targetPath: "" },
    CONTEXT,
  );
  expect(result.output).toEqual(refused);
  expect(result.content).toBe(JSON.stringify(refused));
  expect(fixture.bodies).toHaveLength(1);
});
it.each([
  {},
  { status: "completed" },
  { status: "made-up", evidence: [] },
  { status: "completed", evidence: [{ kind: "governed-delegate" }] },
  {
    status: "completed",
    evidence: [{ kind: "governed-delegate", code: "completed", raw: "unexpected" }],
  },
])("rejects a non-canonical facade envelope: %s", async (answer) => {
  const fixture = await registered({ answer });
  await expect(tool(fixture, "keiko_git_status").execute({}, CONTEXT)).rejects.toThrow(
    "keiko-tool-invalid",
  );
});
it("preserves read facet refusal alongside canonical evidence", async () => {
  const fixture = await registered({ answer: RESPONSE });
  await expect(
    tool(fixture, "keiko_workspace_read").execute({ relativePath: "a.ts" }, CONTEXT),
  ).rejects.toThrow("keiko-tool-invalid");
});
it.each(["failed", "denied", "invalid", "cancelled", "timeout", "busy", "observed"])(
  "keeps a %s reply as structured output without requiring a successful read",
  async (status) => {
    const answer = { status, evidence: [] };
    const fixture = await registered({ answer });
    const result = await tool(fixture, "keiko_workspace_read").execute(
      { relativePath: "a.ts" },
      CONTEXT,
    );
    expect(result.output).toEqual(answer);
  },
);

it("a parent closed while approval waits never sends the later authorized effect", async () => {
  let announce = (): void => undefined;
  const asked = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let answer = (_response: Response): void => undefined;
  const response = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  const fixture = await registered({
    mode: "governed-assist",
    respond: () => {
      announce();
      return response;
    },
  });
  await fixture.hook("execute.before", { ...CONTEXT, tool: "execute" });
  const pending = tool(fixture, "keiko_verification").execute(
    { verifierId: "typecheck", targetPath: "" },
    CONTEXT,
  );
  await asked;
  await fixture.hook("execute.after", { ...CONTEXT, tool: "execute" });
  answer(new Response(JSON.stringify(RESPONSE), { status: 200 }));
  await expect(pending).rejects.toThrow("keiko-tool-unavailable");
  expect(fixture.bodies).toHaveLength(1);
  expect(fixture.bodies[0]?.action).toBe("permission-request");
});

it("binds an inactive fixed host factory to the same parent owner and lexical facade transport", async () => {
  const create = Reflect.get(runtimeAdapter, "createGeneratedOpenCodeV2HostFactory") as
    (() => string) | undefined;
  expect(create, "the default plugin cannot bind a private native host capability").toBeTypeOf(
    "function",
  );
  if (create === undefined) throw new Error("missing-fixed-host-factory");
  const tools = new Map<string, GeneratedTool>();
  const hooks = new Map<string, Hook>();
  const closed: string[] = [];
  let owner: { readonly close: (context: NativeContext) => boolean } | undefined;
  const factory = new Script(
    `${create().replace("export default", "const generated =")}\ngenerated;`,
  ).runInNewContext({
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    fetch: (): never => {
      throw new Error("ambient-fetch-denied");
    },
    process: new Proxy(
      {},
      {
        get: (): never => {
          throw new Error("ambient-process-denied");
        },
      },
    ),
  }) as (runtime: unknown) => Plugin;
  const plugin = factory({
    process: Object.freeze({
      env: Object.freeze({
        KEIKO_CODING_MODE: "autonomous-delivery",
        KEIKO_CODING_RUN_ID: "run-host-factory",
        KEIKO_TOOL_FACADE_URL: "http://127.0.0.1/fixture",
        KEIKO_TOOL_FACADE_CAPABILITY: "fixture",
      }),
    }),
    crypto: webcrypto,
    fetch: (): Promise<Response> => Promise.resolve(new Response(JSON.stringify(RESPONSE))),
    bindOwner: (value: typeof owner): void => {
      owner = value;
    },
    onParentClosed: (context: NativeContext): void => {
      closed.push(context.id);
    },
  });
  await plugin.setup({
    tool: {
      hook: (name, callback): Promise<unknown> => {
        hooks.set(name, callback);
        return Promise.resolve();
      },
      transform: (callback): Promise<unknown> => {
        callback({
          add: (value): void => {
            tools.set(value.name, value);
          },
        });
        return Promise.resolve();
      },
    },
  });
  expect([...tools.keys()]).toEqual(opencodeRegistrationSet().entries.map((value) => value.alias));
  const before = hooks.get("execute.before");
  if (before === undefined || owner === undefined) throw new Error("host-owner-unbound");
  await before({ ...CONTEXT, tool: "execute" });
  const selected = tools.get("keiko_git_status");
  if (selected === undefined) throw new Error("host-tool-missing");
  await expect(selected.execute({}, CONTEXT)).resolves.toMatchObject({ output: RESPONSE });
  expect(owner.close(CONTEXT)).toBe(true);
  expect(owner.close(CONTEXT)).toBe(false);
  await expect(selected.execute({}, CONTEXT)).rejects.toThrow("keiko-tool-invalid");
  expect(closed).toEqual([CONTEXT.id]);
});

it("registers every selected Code Mode handler with the original native catalog", async () => {
  const fixture = await registered({ profile: "code-mode" });
  expect([...fixture.tools.keys()]).toEqual(
    opencodeRegistrationSet("code-mode").entries.map((entry) => entry.alias),
  );
  for (const tool of fixture.tools.values()) {
    expect(tool.options).toEqual({ permission: tool.name, codemode: true });
  }
  fixture.dispose();
});

it("preserves the direct source while caching each immutable selected profile separately", () => {
  const direct = createGeneratedOpenCodeV2Plugins();
  const codeMode = createGeneratedOpenCodeV2Plugins("code-mode");
  expect(direct).toBe(createGeneratedOpenCodeV2Plugins("direct"));
  expect(codeMode).toBe(createGeneratedOpenCodeV2Plugins("code-mode"));
  expect(codeMode).not.toBe(direct);
  expect(codeMode.keiko_native_context).toBe(direct.keiko_native_context);
  expect(Object.isFrozen(codeMode)).toBe(true);
});

it("rejects unsupported generated profiles before constructing a plugin or host factory", () => {
  for (const factory of [
    createGeneratedOpenCodeV2Plugins,
    runtimeAdapter.createGeneratedOpenCodeV2HostFactory,
  ]) {
    expect(() => {
      Reflect.apply(factory, undefined, ["unsupported"]);
    }).toThrow(TypeError);
  }
});
