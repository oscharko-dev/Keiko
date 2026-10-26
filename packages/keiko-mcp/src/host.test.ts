import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanonicalToolId,
  CatalogDigest,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpHost,
  ManagedMcpInvocationContext,
  ManagedMcpLogPort,
  ManagedMcpTool,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { activityLogLossCounters } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createManagedMcpHost } from "./index.js";
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
  options: { durationMs?: number; risk?: "read" | "write" } = {},
): {
  host: ManagedMcpHost<Context>;
  execute: ManagedMcpTool<Context>["execute"];
  change: () => void;
} {
  const run =
    execute ??
    vi.fn<ManagedMcpTool<Context>["execute"]>((args, ctx) =>
      Promise.resolve({ data: { text: args.text ?? "", binding: ctx.binding } }),
    );
  let current: ToolDescriptor = {
    ...descriptor,
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
    change: (): void => {
      current = { ...descriptor, description: "Changed provider declaration" };
    },
  };
}

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
