import { afterEach, expect, it, vi, type Mock } from "vitest";
import type {
  ExternalMcpConnection,
  ManagedMcpInvocationContext,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { connectExternalMcp } from "./external-client.js";
import { createMcpRelayEndpoint } from "./relay-endpoint.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const inputSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;
interface Fixture {
  readonly endpoint: ReturnType<typeof createMcpRelayEndpoint>;
  readonly context: ManagedMcpInvocationContext;
  readonly call: Mock<ExternalMcpConnection["call"]>;
  readonly revoke: () => void;
}
function fixture(): Fixture {
  let allowed = true;
  const context: ManagedMcpInvocationContext = {
    invocationId: "private-invocation",
    correlationId: "relay-test",
    signal: new AbortController().signal,
    beforeEffect: () => allowed,
  };
  const call = vi.fn<ExternalMcpConnection["call"]>((_name, args) =>
    Promise.resolve({
      content: [{ type: "text", text: typeof args.text === "string" ? args.text : "invalid" }],
    }),
  );
  const connection: ExternalMcpConnection = {
    signal: new AbortController().signal,
    tools: [
      { name: "echo", inputSchema },
      { name: "unadmitted", inputSchema },
    ],
    call,
    close: () => Promise.resolve(),
  };
  const endpoint = createMcpRelayEndpoint(connection, { echo: "read" });
  cleanup.push(endpoint.close);
  return {
    endpoint,
    context,
    call,
    revoke: (): void => {
      allowed = false;
    },
  };
}
async function clientFor(f: Fixture): Promise<ExternalMcpConnection> {
  const client = await connectExternalMcp({
    transport: {
      kind: "remote",
      url: "https://relay.example.test/mcp",
      transport: "streamable-http",
      fetch: (input, init) => f.endpoint.fetch(new Request(input, init), f.context),
    },
    signal: f.context.signal,
    correlationId: "relay-test",
    log: { write: () => undefined },
  });
  cleanup.push(() => client.close());
  return client;
}
async function legacy(
  f: ReturnType<typeof fixture>,
  method: string,
  params: unknown,
  context = f.context,
): Promise<{ result?: { content?: { text?: string }[]; isError?: boolean }; error?: unknown }> {
  const response = await f.endpoint.fetch(
    new Request("https://relay.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    context,
  );
  const text = await response.text();
  const json = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
  return JSON.parse(json ?? "null") as {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: unknown;
  };
}

it("exposes only admitted tools to the real SDK and preserves MCP results and private context", async () => {
  const f = fixture();
  const client = await clientFor(f);
  expect(client.tools.map((tool) => tool.name)).toEqual(["echo"]);
  expect(await client.call("echo", { text: "synthetic response" }, f.context)).toMatchObject({
    content: [{ type: "text", text: "synthetic response" }],
  });
  expect(f.call).toHaveBeenCalledOnce();
  expect(f.call.mock.calls[0]?.[2].invocationId).toBe("private-invocation");
});
it("serves native legacy JSON-RPC and ignores caller-supplied invocation metadata", async () => {
  const f = fixture();
  const result = await legacy(f, "tools/call", {
    name: "echo",
    arguments: { text: "legacy" },
    _meta: { invocationId: "forged" },
  });
  expect(result.result?.content).toEqual([{ type: "text", text: "legacy" }]);
  expect(f.call.mock.calls[0]?.[2].invocationId).toBe("private-invocation");
});
it("rejects invalid arguments and unavailable tools before invoking the provider", async () => {
  const f = fixture();
  await legacy(f, "tools/call", { name: "echo", arguments: { text: 7 } });
  await legacy(f, "tools/call", { name: "unadmitted", arguments: { text: "no" } });
  expect(f.call).not.toHaveBeenCalled();
});
it("isolates concurrent invocation contexts and suppresses a response after authority loss", async () => {
  const f = fixture();
  await Promise.all(
    ["first", "second"].map((invocationId) =>
      legacy(
        f,
        "tools/call",
        { name: "echo", arguments: { text: invocationId } },
        { ...f.context, invocationId },
      ),
    ),
  );
  expect(f.call.mock.calls.map(([, , context]) => context.invocationId).sort()).toEqual([
    "first",
    "second",
  ]);
  f.call.mockImplementationOnce(() => {
    f.revoke();
    return Promise.resolve({ content: [{ type: "text", text: "must not escape" }] });
  });
  const result = await legacy(f, "tools/call", { name: "echo", arguments: { text: "late" } });
  expect(result.result?.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("must not escape");
  expect(f.call).toHaveBeenCalledTimes(3);
});
