import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanonicalToolId,
  CatalogJsonObject,
  CatalogDigest,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpHost,
  ManagedMcpInvocationContext,
  ManagedMcpLogPort,
  ManagedMcpTool,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { activityLogLossCounters } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createManagedMcpHost, ManagedMcpError } from "./index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const exchanges = vi.hoisted(() => [] as { method: string; meta: unknown }[]);
vi.mock("@modelcontextprotocol/server", async (original) => {
  const sdk = await original<typeof import("@modelcontextprotocol/server")>();
  return {
    ...sdk,
    createMcpHandler: (
      ...args: Parameters<typeof sdk.createMcpHandler>
    ): ReturnType<typeof sdk.createMcpHandler> => {
      const handler = sdk.createMcpHandler(...args);
      return {
        ...handler,
        fetch: async (request, options): Promise<Response> => {
          const rpc = (await request.clone().json()) as {
            method: string;
            params?: { _meta?: unknown };
          };
          exchanges.push({ method: rpc.method, meta: rpc.params?._meta });
          return handler.fetch(request, options);
        },
      };
    },
  };
});

interface Context extends ManagedMcpInvocationContext {
  readonly binding: string;
}
const descriptor: ToolDescriptor = {
  toolRef: { canonicalId: "fixture.echo" as CanonicalToolId, contractVersion: 1 },
  descriptorDigest: "a".repeat(64) as CatalogDigest,
  description: "Echo a synthetic value inside the bound consumer.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 100 } },
    required: ["text"],
    additionalProperties: false,
  },
  resultSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: 100 },
      binding: { type: "string", maxLength: 100 },
    },
    required: ["text", "binding"],
    additionalProperties: false,
  },
  effects: ["workspace-read"],
  actionMapping: [{ action: "fixture.echo", effects: ["workspace-read"] }],
  policyReferences: ["fixture"],
  handlerRequirement: { id: "fixture", contractVersion: 1 },
  bounds: { maxArgumentBytes: 1024, maxResultBytes: 1024, maxResultCount: 1, maxDurationMs: 1000 },
  idempotency: "read-only",
  cancellation: "before-effect",
};
function context(binding: string, signal = new AbortController().signal): Context {
  return {
    binding,
    signal,
    invocationId: `invocation-${binding}`,
    correlationId: `correlation-${binding}`,
    beforeEffect: () => !signal.aborted,
  };
}
const hosts: ManagedMcpHost<Context>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  exchanges.length = 0;
  vi.restoreAllMocks();
});

function fixture(
  execute?: ManagedMcpTool<Context>["execute"],
  log: ManagedMcpLogPort = { write: () => undefined },
  options: { durationMs?: number; risk?: "read" | "write"; inputSchema?: CatalogJsonObject } = {},
): {
  host: ManagedMcpHost<Context>;
  execute: ManagedMcpTool<Context>["execute"];
  change: () => void;
  changeHandler: (replacement: ManagedMcpTool<Context>["execute"]) => void;
} {
  let run =
    execute ??
    vi.fn<ManagedMcpTool<Context>["execute"]>((args, ctx) =>
      Promise.resolve({ data: { text: args.text ?? "", binding: ctx.binding } }),
    );
  let current: ToolDescriptor = {
    ...descriptor,
    inputSchema: options.inputSchema ?? descriptor.inputSchema,
    bounds: { ...descriptor.bounds, maxDurationMs: options.durationMs ?? 1000 },
    idempotency: options.risk === "write" ? "server-key-required" : "read-only",
  };
  const host = createManagedMcpHost<Context>({
    providers: [
      {
        id: "fixture",
        tools: (): readonly ManagedMcpTool<Context>[] => [
          { name: "fixture.echo", risk: options.risk ?? "read", descriptor: current, execute: run },
        ],
      },
    ],
    log,
  });
  hosts.push(host);
  return {
    host,
    execute: run,
    changeHandler: (replacement): void => {
      run = replacement;
    },
    change: (): void => {
      current = { ...descriptor, description: "Changed provider declaration" };
    },
  };
}

it.each([
  { name: "untrusted/tool" },
  { risk: "write" as const },
  { descriptor: { ...descriptor, inputSchema: { type: "array" } } },
  {
    descriptor: {
      ...descriptor,
      inputSchema: { ...descriptor.inputSchema, additionalProperties: true },
    },
  },
  { descriptor: { ...descriptor, resultSchema: { type: "array" } } },
])("rejects unsafe provider declarations before discovery or execution: %j", (overrides) => {
  const execute = vi.fn<ManagedMcpTool<Context>["execute"]>();
  expect(() =>
    createManagedMcpHost<Context>({
      providers: [
        {
          id: "fixture",
          tools: (): readonly ManagedMcpTool<Context>[] => [
            { name: "fixture.echo", risk: "read", descriptor, execute, ...overrides },
          ],
        },
      ],
      log: { write: () => undefined },
    }),
  ).toThrow(new ManagedMcpError("invalid-arguments"));
  expect(execute).not.toHaveBeenCalled();
  expect(exchanges).toEqual([]);
});

it.each([0, 321])("refuses a provider registry of %i tools before protocol work", (count) => {
  const execute = vi.fn<ManagedMcpTool<Context>["execute"]>();
  expect(() =>
    createManagedMcpHost<Context>({
      providers: [
        {
          id: "fixture",
          tools: (): readonly ManagedMcpTool<Context>[] =>
            Array.from({ length: count }, (_, index) => ({
              name: `fixture.tool-${String(index)}`,
              risk: "read",
              descriptor,
              execute,
            })),
        },
      ],
      log: { write: () => undefined },
    }),
  ).toThrow(new ManagedMcpError("descriptor-drift"));
  expect(execute).not.toHaveBeenCalled();
  expect(exchanges).toEqual([]);
});

it.each(["provider", "tool"] as const)(
  "refuses duplicate %s identity before discovery",
  (duplicate) => {
    const execute = vi.fn<ManagedMcpTool<Context>["execute"]>();
    expect(() =>
      createManagedMcpHost<Context>({
        providers: ["first", "second"].map((id) => ({
          id: duplicate === "provider" ? "same-provider" : id,
          tools: (): readonly ManagedMcpTool<Context>[] => [
            {
              name: duplicate === "tool" ? "same-tool" : `fixture.${id}`,
              risk: "read",
              descriptor,
              execute,
            },
          ],
        })),
        log: { write: () => undefined },
      }),
    ).toThrow(new ManagedMcpError("descriptor-drift"));
    expect(execute).not.toHaveBeenCalled();
    expect(exchanges).toEqual([]);
  },
);

it("admits two distinct providers through SDK discovery without executing either", async () => {
  const execute = vi.fn<ManagedMcpTool<Context>["execute"]>();
  const host = createManagedMcpHost<Context>({
    providers: ["second", "first"].map((id) => ({
      id,
      tools: (): readonly ManagedMcpTool<Context>[] => [
        {
          name: `fixture.${id}`,
          risk: "read",
          descriptor,
          execute,
        },
      ],
    })),
    log: { write: () => undefined },
  });
  hosts.push(host);
  await host.admit("multiple-providers");
  expect(host.catalog().map((tool) => tool.name)).toEqual(["fixture.second", "fixture.first"]);
  expect(host.protocolEra()).toBe("modern");
  expect(execute).not.toHaveBeenCalled();
});

function sourceHost(source: { descriptor: ToolDescriptor }): {
  host: ManagedMcpHost<Context>;
  execute: ManagedMcpTool<Context>["execute"];
} {
  const execute = vi.fn<ManagedMcpTool<Context>["execute"]>((args, ctx) =>
    Promise.resolve({ data: { text: args.text ?? "", binding: ctx.binding } }),
  );
  const host = createManagedMcpHost<Context>({
    providers: [
      {
        id: "fixture",
        tools: (): readonly ManagedMcpTool<Context>[] => [
          { name: "fixture.echo", risk: "read", descriptor: source.descriptor, execute },
        ],
      },
    ],
    log: { write: () => undefined },
  });
  hosts.push(host);
  return { host, execute };
}

it("serves an unchanged frozen descriptor and still refuses a replaced one", async () => {
  const source = { descriptor: deepFreeze(structuredClone(descriptor)) };
  const { host, execute } = sourceHost(source);
  await host.admit("frozen-admission");
  await expect(
    host.call("fixture.echo", { text: "one" }, context("frozen")),
  ).resolves.toBeDefined();
  expect(host.catalog().map((tool) => tool.name)).toEqual(["fixture.echo"]);
  source.descriptor = deepFreeze({ ...structuredClone(descriptor), description: "Replaced" });
  await expect(
    host.call("fixture.echo", { text: "two" }, context("frozen-drift")),
  ).rejects.toMatchObject({ reason: "descriptor-drift" });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("refuses an in-place change of a descriptor that was not deeply frozen", async () => {
  // Only the top level is frozen: the nested bounds object stays writable, so identity alone
  // proves nothing and the canonical comparison must still see the change.
  const shallow = structuredClone(descriptor);
  const source = { descriptor: Object.freeze(shallow) };
  const { host, execute } = sourceHost(source);
  await host.admit("shallow-admission");
  (shallow.bounds as { maxDurationMs: number }).maxDurationMs += 1;
  await expect(
    host.call("fixture.echo", { text: "one" }, context("shallow-drift")),
  ).rejects.toMatchObject({ reason: "descriptor-drift" });
  expect(execute).not.toHaveBeenCalled();
});

it("refuses a replacement effect handler even when all admitted metadata is identical", async () => {
  const f = fixture();
  const replacement = vi.fn<ManagedMcpTool<Context>["execute"]>(() =>
    Promise.resolve({ data: { text: "replacement", binding: "replacement" } }),
  );
  await f.host.admit("handler-admission");
  f.changeHandler(replacement);
  await expect(
    f.host.call("fixture.echo", { text: "fixture" }, context("handler-drift")),
  ).rejects.toMatchObject({ reason: "descriptor-drift" });
  expect(() => f.host.catalog()).toThrow();
  expect(f.execute).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
});

it("refuses handler replacement while the admitted handler waits before its effect", async () => {
  const entered = deferred();
  const release = deferred();
  let effects = 0;
  const f = fixture(async (args, ctx) => {
    entered.resolve();
    await release.promise;
    if (!ctx.beforeEffect()) throw new Error("Refused delayed effect");
    effects += 1;
    return { data: { text: args.text ?? "", binding: ctx.binding } };
  });
  const replacement = vi.fn<ManagedMcpTool<Context>["execute"]>(() =>
    Promise.resolve({ data: { text: "replacement", binding: "replacement" } }),
  );
  await f.host.admit("delayed-handler-admission");
  const pending = f.host.call(
    "fixture.echo",
    { text: "fixture" },
    context("delayed-handler-drift"),
  );
  await entered.promise;
  f.changeHandler(replacement);
  release.resolve();
  await expect(pending).rejects.toMatchObject({ reason: "tool-error" });
  expect(effects).toBe(0);
  expect(replacement).not.toHaveBeenCalled();
});

describe("admitted catalog metadata", () => {
  it("publishes only admitted immutable declarations and refuses drift or a closed host", async () => {
    const f = fixture();
    expect(() => f.host.catalog()).toThrow();
    await f.host.admit("catalog-admission");
    const tools = f.host.catalog();
    expect(tools).toHaveLength(1);
    expect(Object.keys(tools[0] ?? {}).sort()).toEqual(["descriptor", "name", "risk"]);
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(tools[0]?.descriptor.inputSchema)).toBe(true);
    f.change();
    expect(() => f.host.catalog()).toThrow();
    await f.host.close();
    expect(() => f.host.catalog()).toThrow();
  });
});

describe("managed MCP protocol", () => {
  it("uses real modern discovery, listing and calls without dialing a network endpoint", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network is forbidden"));
    const { host } = fixture();
    await host.admit("admission-fixture");
    expect(host.protocolEra()).toBe("modern");
    expect(await host.call("fixture.echo", { text: "one" }, context("first"))).toEqual({
      text: "one",
      binding: "first",
    });
    expect(exchanges.map((exchange) => exchange.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/list",
      "tools/call",
    ]);
    for (const exchange of exchanges) expect(JSON.stringify(exchange.meta)).toContain("2026-07-28");
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects schema and routing overrides before the provider runs", async () => {
    const { host, execute } = fixture();
    await host.admit("admission-fixture");
    await expect(host.call("fixture.echo", { text: 1 }, context("first"))).rejects.toThrow();
    for (const key of ["authRef", "baseUrl", "authority", "binding", "_meta"])
      await expect(
        host.call("fixture.echo", { text: "one", [key]: "override" }, context("first")),
      ).rejects.toMatchObject({ reason: "invalid-arguments" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses changed provider declarations before dispatch", async () => {
    const { host, change, execute } = fixture();
    await host.admit("admission-fixture");
    change();
    await expect(
      host.call("fixture.echo", { text: "one" }, context("first")),
    ).rejects.toMatchObject({ reason: "descriptor-drift" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps interleaved consumer context private through reordered completion", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host } = fixture(async (args, ctx) => {
      if (ctx.binding === "first") {
        entered?.();
        await blocked;
      }
      return { data: { text: args.text ?? "", binding: ctx.binding } };
    });
    await host.admit("admission-fixture");
    const first = host.call("fixture.echo", { text: "one" }, context("first"));
    await started;
    expect(await host.call("fixture.echo", { text: "two" }, context("second"))).toEqual({
      text: "two",
      binding: "second",
    });
    release?.();
    expect(await first).toEqual({ text: "one", binding: "first" });
    expect(JSON.stringify(exchanges)).not.toContain("correlation-first");
    expect(JSON.stringify(exchanges)).not.toContain("invocation-first");
  });

  it("discards provider error content and does not retry the handler", async () => {
    const execute = vi.fn((): Promise<never> =>
      Promise.reject(new Error("Synthetic confidential failure")),
    );
    const { host } = fixture(execute);
    await host.admit("admission-fixture");
    await expect(
      host.call("fixture.echo", { text: "one" }, context("first")),
    ).rejects.toMatchObject({ reason: "tool-error", message: "Managed MCP operation failed" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("records the registered admission and invocation lifecycle without content", async () => {
    const lines: string[] = [];
    const { host } = fixture(undefined, {
      write: (event) => {
        lines.push(formatActivityLogProofLine(event));
      },
    });
    await host.admit("admission-fixture");
    await host.call("fixture.echo", { text: "private-synthetic-text" }, context("first"));
    const proofs = lines.map((line) => expectActivityLogProof("mcp.managed.lifecycle.line", line));
    expect(proofs.map((proof) => proof.phase)).toEqual([
      "listed",
      "admitted",
      "started",
      "listed",
      "completed",
    ]);
    expect(lines.join()).not.toContain("private-synthetic-text");
    expect(lines.join()).not.toContain("fixture.echo");
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let finish = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      finish();
    },
  };
}

describe("managed MCP effect and evidence boundaries", () => {
  it.each(["admitted", "started"] as const)(
    "fails closed before effects when %s evidence cannot be written",
    async (phase) => {
      const before = activityLogLossCounters()["port-sink-failed"];
      const { host, execute } = fixture(undefined, {
        write: (event) => {
          const proof = expectActivityLogProof(
            "mcp.managed.lifecycle.line",
            formatActivityLogProofLine(event),
          );
          if (proof.phase === phase) throw new Error("private sink failure");
        },
      });
      if (phase === "admitted") {
        await expect(host.admit("admission-fixture")).rejects.toMatchObject({
          reason: "log-unavailable",
        });
        expect(host.protocolEra()).toBeUndefined();
      } else {
        await host.admit("admission-fixture");
        await expect(
          host.call("fixture.echo", { text: "one" }, context("first")),
        ).rejects.toMatchObject({ reason: "log-unavailable" });
      }
      expect(execute).not.toHaveBeenCalled();
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(before + 1);
    },
  );

  it("revokes a delayed provider before its effect after the actual SDK timeout", async () => {
    const entered = deferred();
    const release = deferred();
    const finished = deferred();
    let effects = 0;
    let aborted = false;
    const execute = vi.fn<ManagedMcpTool<Context>["execute"]>(async (args, ctx) => {
      entered.resolve();
      await release.promise;
      aborted = ctx.signal.aborted;
      if (ctx.beforeEffect()) effects += 1;
      finished.resolve();
      return { data: { text: args.text ?? "", binding: ctx.binding } };
    });
    const { host } = fixture(execute, undefined, { durationMs: 500, risk: "write" });
    await host.admit("admission-fixture");
    const outcome = host.call("fixture.echo", { text: "one" }, context("first")).then(
      () => "success",
      () => "refused",
    );
    await entered.promise;
    expect(await outcome).toBe("refused");
    release.resolve();
    await finished.promise;
    expect({ aborted, effects }).toEqual({ aborted: true, effects: 0 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("isolates caller cancellation from another invocation and stops the late effect", async () => {
    const entered = deferred();
    const release = deferred();
    const finished = deferred();
    const effects: string[] = [];
    const controller = new AbortController();
    const execute = vi.fn<ManagedMcpTool<Context>["execute"]>(async (args, ctx) => {
      if (ctx.binding === "first") {
        entered.resolve();
        await release.promise;
      }
      if (ctx.beforeEffect()) effects.push(ctx.binding);
      if (ctx.binding === "first") finished.resolve();
      return { data: { text: args.text ?? "", binding: ctx.binding } };
    });
    const { host } = fixture(execute, undefined, { risk: "write" });
    await host.admit("admission-fixture");
    const first = host
      .call("fixture.echo", { text: "one" }, context("first", controller.signal))
      .then(
        () => "success",
        () => "refused",
      );
    await entered.promise;
    expect(await host.call("fixture.echo", { text: "two" }, context("second"))).toEqual({
      text: "two",
      binding: "second",
    });
    controller.abort();
    expect(await first).toBe("refused");
    release.resolve();
    await finished.promise;
    expect(effects).toEqual(["second"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("preserves a confirmed mutation when its completed log fails and records the loss", async () => {
    const before = activityLogLossCounters()["port-sink-failed"];
    const phases: unknown[] = [];
    let effects = 0;
    const { host } = fixture(
      (args, ctx) => {
        if (ctx.beforeEffect()) effects += 1;
        return Promise.resolve({ data: { text: args.text ?? "", binding: ctx.binding } });
      },
      {
        write: (event) => {
          const proof = expectActivityLogProof(
            "mcp.managed.lifecycle.line",
            formatActivityLogProofLine(event),
          );
          phases.push(proof.phase);
          if (proof.phase === "completed") throw new Error("private sink failure");
        },
      },
      { risk: "write" },
    );
    await host.admit("admission-fixture");
    await expect(host.call("fixture.echo", { text: "one" }, context("first"))).resolves.toEqual({
      text: "one",
      binding: "first",
    });
    expect(effects).toBe(1);
    expect(phases).not.toContain("failed");
    expect(activityLogLossCounters()["port-sink-failed"]).toBe(before + 1);
  });
});

it("preserves a bounded structured provider error privately with one failed settlement", async () => {
  const lines: string[] = [];
  const execute = vi.fn<ManagedMcpTool<Context>["execute"]>((_args, ctx) =>
    Promise.resolve({
      data: { text: "private-provider-error", binding: ctx.binding },
      isError: true,
    }),
  );
  const { host } = fixture(execute, {
    write: (event) => {
      lines.push(formatActivityLogProofLine(event));
    },
  });
  await host.admit("admission-fixture");
  const error: unknown = await host
    .call("fixture.echo", { text: "one" }, context("first"))
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ManagedMcpError);
  if (!(error instanceof ManagedMcpError)) throw new Error("Expected managed failure");
  expect(error.reason).toBe("tool-error");
  expect(error.structuredResult).toEqual({ text: "private-provider-error", binding: "first" });
  expect(Object.isFrozen(error.structuredResult)).toBe(true);
  expect(JSON.stringify(error)).not.toContain("private-provider-error");
  expect(lines.join()).not.toContain("private-provider-error");
  expect(
    lines
      .map((line) => expectActivityLogProof("mcp.managed.lifecycle.line", line))
      .filter((event) => event.phase === "failed"),
  ).toHaveLength(1);
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  { data: { text: 42, binding: "first" } },
  { data: { text: "private-error", binding: "first", credential: "unwanted-field" } },
  { data: { text: "x".repeat(2048), binding: "first" } },
])("does not preserve invalid or oversized provider error data", async ({ data }) => {
  const { host } = fixture(() => Promise.resolve({ data, isError: true }));
  await host.admit("admission-fixture");
  const error: unknown = await host
    .call("fixture.echo", { text: "one" }, context("first"))
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ManagedMcpError);
  if (!(error instanceof ManagedMcpError)) throw new Error("Expected managed failure");
  expect(error.structuredResult).toBeUndefined();
  expect(JSON.stringify(error)).not.toMatch(/private-error|unwanted-field/u);
});

// Explicit external schemas preserve standard MCP openness and optional properties through the SDK.
it("executes an external open schema with a local reference and optional union without narrowing it", async () => {
  const run = vi.fn<ManagedMcpTool<Context>["execute"]>((args, ctx) =>
    Promise.resolve({ data: { text: args.text ?? "", binding: ctx.binding } }),
  );
  const f = fixture(
    run,
    { write: () => undefined },
    {
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        $defs: { text: { type: "string", maxLength: 100 } },
        properties: {
          text: { $ref: "#/$defs/text" },
          optional: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
        },
        required: ["text"],
      },
    },
  );
  await f.host.admit("synthetic-schema-admission");
  await f.host.call("fixture.echo", { text: "synthetic", extra: 7 }, context("external"));
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0]).toEqual({ text: "synthetic", extra: 7 });
});
