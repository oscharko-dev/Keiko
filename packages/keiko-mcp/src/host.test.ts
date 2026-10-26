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
  let current = descriptor;
  const host = createManagedMcpHost<Context>({
    providers: [
      {
        id: "fixture",
        tools: (): readonly ManagedMcpTool<Context>[] => [
          { name: "fixture.echo", risk: "read", descriptor: current, execute: run },
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
