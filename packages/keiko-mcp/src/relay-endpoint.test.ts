import { afterEach, expect, it, vi, type Mock } from "vitest";
import type {
  ExternalMcpConnection,
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError, noEffectError } from "./definitions.js";
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
  readonly recover: Mock<() => void>;
}
function fixture(
  risk: "read" | "write" = "read",
  instructions?: string,
  dispatchGate = true,
): Fixture {
  let allowed = true;
  const recover = vi.fn(() => {
    allowed = false;
  });
  const context: ManagedMcpInvocationContext = {
    invocationId: "private-invocation",
    correlationId: "relay-test",
    signal: new AbortController().signal,
    beforeEffect: () => allowed,
    onUncertainMutation: recover,
    beginMutation: () => ({
      invocationId: "durable-native-call",
      acknowledge: () => undefined,
      fail: () => undefined,
    }),
  };
  const call = vi.fn<ExternalMcpConnection["call"]>((_name, args) =>
    Promise.resolve({
      content: [{ type: "text", text: typeof args.text === "string" ? args.text : "invalid" }],
    }),
  );
  const connection: ExternalMcpConnection = {
    signal: new AbortController().signal,
    ...(instructions === undefined ? {} : { instructions }),
    ...(dispatchGate ? { dispatchGate: true } : {}),
    tools: [
      { name: "echo", inputSchema },
      { name: "unadmitted", inputSchema },
    ],
    call,
    close: () => Promise.resolve(),
  };
  const endpoint = createMcpRelayEndpoint(connection, { echo: risk });
  cleanup.push(endpoint.close);
  return {
    endpoint,
    recover,
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
): Promise<{
  result?: { content?: { text?: string }[]; isError?: boolean; instructions?: string; structuredContent?: unknown };
  error?: unknown;
}> {
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
    result?: { content?: { text?: string }[]; isError?: boolean; instructions?: string; structuredContent?: unknown };
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
it("announces server-owned instructions on initialize and none when the connection has none", async () => {
  const initialize = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "relay-test", version: "1" },
  };
  const guided = await legacy(
    fixture("read", "Synthetic shared tool rules."),
    "initialize",
    initialize,
  );
  expect(guided.result?.instructions).toBe("Synthetic shared tool rules.");
  const plain = await legacy(fixture(), "initialize", initialize);
  expect(plain.result).toBeDefined();
  expect(plain.result?.instructions).toBeUndefined();
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

it.each(["lost-response", "provider-error", "malformed-result"])(
  "revokes the run before a possibly committed write can replay after %s",
  async (failure) => {
    const f = fixture("write");
    f.call.mockImplementation(() => {
      if (failure === "lost-response")
        return Promise.reject(new TypeError("synthetic committed-then-lost response"));
      return Promise.resolve(
        failure === "provider-error"
          ? { isError: true, content: [{ type: "text", text: "synthetic failure" }] }
          : { content: "synthetic malformed result" },
      );
    });
    const client = await clientFor(f);
    await expect(
      client.call(
        "echo",
        { text: "synthetic note" },
        { ...f.context, invocationId: "write-first" },
      ),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      client.call(
        "echo",
        { text: "synthetic note" },
        { ...f.context, invocationId: "model-retry" },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.call).toHaveBeenCalledOnce();
    expect(f.recover).toHaveBeenCalledOnce();
  },
);
it("requires a recovery owner before dispatching a native write", async () => {
  const f = fixture("write");
  const result = await legacy(
    f,
    "tools/call",
    { name: "echo", arguments: { text: "synthetic note" } },
    { ...f.context, onUncertainMutation: undefined },
  );
  expect(result.result?.isError).toBe(true);
  expect(f.call).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});

function retainingPermit(f: Fixture) {
  const dispatch = vi.fn(() => true);
  const release = vi.fn();
  const acknowledge = vi.fn();
  const fail = vi.fn();
  const retained: ManagedMcpToolResult[] = [];
  const retainProviderResult = vi.fn((result: ManagedMcpToolResult) => {
    retained.push(result);
    return result;
  });
  const context: ManagedMcpInvocationContext = { ...f.context,
    beginMutation: () => ({ invocationId: "durable-native-call", dispatch, release,
      acknowledge, fail, retainProviderResult }),
  };
  return { context, dispatch, release, acknowledge, fail, retained, retainProviderResult };
}

it("returns retained correctable Jira data only when the actual dispatch gate never opened", async () => {
  const f = fixture("write");
  const p = retainingPermit(f);
  const data = { outcome: "rejected", reason: "field-validation",
    fieldErrors: [{ fieldId: "summary", message: "Synthetic required field" }] };
  f.call.mockImplementation(async (_name, _args, context) => {
    context.retainProviderResult?.({ data, isError: true });
    return { content: [{ type: "text", text: "not authoritative provider prose" }],
      structuredContent: data, isError: true };
  });
  const response = await legacy(f, "tools/call", { name: "echo", arguments: { text: "value" } }, p.context);
  expect(response.result).toMatchObject({ isError: true, structuredContent: data });
  expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(data));
  expect(p.retained).toHaveLength(1);
  expect(p.release).toHaveBeenCalledOnce();
  expect(p.acknowledge).not.toHaveBeenCalled();
  expect(p.fail).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});

it("retains an uncertain Jira receipt before recovery and never acknowledges or replays the error", async () => {
  const f = fixture("write");
  const p = retainingPermit(f);
  const data = { outcome: "succeeded-unconfirmed", issueKey: "SYN-1" };
  f.recover.mockImplementation(() => {
    expect(p.retained).toEqual([{ data, isError: true }]);
    f.revoke();
  });
  f.call.mockImplementation(async (_name, _args, context) => {
    expect(context.beforeDispatch?.()).toBe(true);
    context.retainProviderResult?.({ data, isError: true });
    return { content: [], structuredContent: data, isError: true };
  });
  await writeText(f, p.context);
  await expect(legacy(f, "tools/call", { name: "echo", arguments: { text: "retry" } }, p.context))
    .rejects.toBeInstanceOf(Error);
  expect(p.acknowledge).not.toHaveBeenCalled();
  expect(p.fail).toHaveBeenCalledOnce();
  expect(f.recover).toHaveBeenCalledOnce();
  expect(f.call).toHaveBeenCalledOnce();
});

it("persists valid success before acknowledging it and suppresses late data after authority loss", async () => {
  const f = fixture("write");
  const p = retainingPermit(f);
  const data = { outcome: "succeeded", issueKey: "SYN-1" };
  p.acknowledge.mockImplementation(() => expect(p.retained).toEqual([{ data }]));
  f.call.mockImplementation(async (_name, _args, context) => {
    context.beforeDispatch?.();
    context.retainProviderResult?.({ data });
    f.revoke();
    return { content: [{ type: "text", text: "private late result" }], structuredContent: data };
  });
  const response = await legacy(f, "tools/call", { name: "echo", arguments: { text: "value" } }, p.context);
  expect(p.retained).toEqual([{ data }]);
  expect(p.acknowledge).toHaveBeenCalledOnce();
  expect(p.fail).toHaveBeenCalledOnce();
  expect(f.recover).toHaveBeenCalledOnce();
  expect(JSON.stringify(response)).not.toContain("private late result");
});

it("does not expose returned data that differs from the private captured snapshot", async () => {
  const f = fixture("write");
  const p = retainingPermit(f);
  f.call.mockImplementation(async (_name, _args, context) => {
    context.retainProviderResult?.({ data: { outcome: "rejected" }, isError: true });
    return { content: [], structuredContent: { outcome: "succeeded", secret: "unbound-value" }, isError: true };
  });
  const response = await legacy(f, "tools/call", { name: "echo", arguments: { text: "value" } }, p.context);
  expect(response.result?.isError).toBe(true);
  expect(JSON.stringify(response)).not.toContain("unbound-value");
  expect(p.acknowledge).not.toHaveBeenCalled();
  expect(f.recover).toHaveBeenCalledOnce();
});

it("keeps recovery and no ACK when persistence fails after a successful upstream write", async () => {
  const f = fixture("write");
  const p = retainingPermit(f);
  p.retainProviderResult.mockImplementation(() => { throw new Error("Synthetic store failure"); });
  f.call.mockImplementation(async (_name, _args, context) => {
    context.beforeDispatch?.();
    context.retainProviderResult?.({ data: { outcome: "succeeded", issueKey: "SYN-1" } });
    return { content: [], structuredContent: { outcome: "succeeded" } };
  });
  const response = await legacy(f, "tools/call", { name: "echo", arguments: { text: "value" } }, p.context);
  expect(response.result?.isError).toBe(true);
  expect(p.acknowledge).not.toHaveBeenCalled();
  expect(p.fail).toHaveBeenCalledOnce();
  expect(f.recover).toHaveBeenCalledOnce();
  expect(f.call).toHaveBeenCalledOnce();
});
it("does not enter recovery for confirmed successful writes or failed reads", async () => {
  const write = fixture("write");
  const writer = await clientFor(write);
  await expect(
    writer.call("echo", { text: "synthetic note" }, write.context),
  ).resolves.toMatchObject({ content: [{ type: "text", text: "synthetic note" }] });
  expect(write.recover).not.toHaveBeenCalled();
  const read = fixture();
  read.call.mockRejectedValue(new TypeError("synthetic read failure"));
  const reader = await clientFor(read);
  await expect(
    reader.call("echo", { text: "synthetic read" }, read.context),
  ).resolves.toMatchObject({ isError: true });
  expect(read.recover).not.toHaveBeenCalled();
});

it("binds the real legacy MCP session metadata and preserves the durable invocation identity", async () => {
  const f = fixture("write");
  const begin = vi.fn(() => ({
    invocationId: "durable-legacy-call",
    acknowledge: (): void => undefined,
    fail: (): void => undefined,
  }));
  const context = { ...f.context, beginMutation: begin };
  await legacy(
    f,
    "tools/call",
    {
      name: "echo",
      arguments: { text: "synthetic legacy mutation" },
      _meta: { "ai.opencode/sessionID": "ses_legacy" },
    },
    context,
  );
  expect(begin).toHaveBeenCalledWith({
    sessionId: "ses_legacy",
    toolName: "echo",
    argumentsValue: { text: "synthetic legacy mutation" },
  });
  expect(f.call).toHaveBeenCalledWith(
    "echo",
    { text: "synthetic legacy mutation" },
    expect.objectContaining({ invocationId: "durable-legacy-call" }),
  );
});

function permitFixture(f: Fixture): {
  readonly dispatch: Mock<() => boolean>;
  readonly release: Mock<() => void>;
  readonly fail: Mock<() => void>;
  readonly context: ManagedMcpInvocationContext;
} {
  const dispatch = vi.fn(() => true);
  const release = vi.fn();
  const fail = vi.fn();
  return {
    dispatch,
    release,
    fail,
    context: {
      ...f.context,
      beginMutation: () => ({
        invocationId: "durable-native-call",
        dispatch,
        release,
        acknowledge: () => undefined,
        fail,
      }),
    },
  };
}
async function writeText(f: Fixture, context: ManagedMcpInvocationContext): Promise<string> {
  const result = await legacy(
    f,
    "tools/call",
    {
      name: "echo",
      arguments: { text: "synthetic note" },
      _meta: { "ai.opencode/sessionID": "s" },
    },
    context,
  );
  expect(result.result?.isError).toBe(true);
  return result.result?.content?.[0]?.text ?? "";
}

it("treats a write that failed before its frame left as effect-free: no run revocation, record released", async () => {
  const f = fixture("write");
  const permit = permitFixture(f);
  f.call.mockRejectedValue(noEffectError("deadline-exceeded"));
  const text = await writeText(f, permit.context);
  expect(permit.release).toHaveBeenCalledOnce();
  expect(permit.fail).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  expect(text).toContain("did not answer in time");
  expect(text).toContain("Nothing was changed");
  // The durable record is dispatched at the transport gate, never earlier.
  expect(permit.dispatch).not.toHaveBeenCalled();
  expect(f.call.mock.calls[0]?.[2].beforeDispatch?.()).toBe(true);
  expect(permit.dispatch).toHaveBeenCalledOnce();
});
it("dispatches the record before calling a connection that has no transport gate", async () => {
  // A connection without its own gate could reach the server without consulting one: the record
  // must be dispatched before the call starts, or an effect could exist with no record behind it.
  const f = fixture("write", undefined, false);
  const permit = permitFixture(f);
  f.call.mockImplementation((_name, _args, context) => {
    expect(permit.dispatch).toHaveBeenCalledOnce();
    expect(context.beforeDispatch).toBeUndefined();
    return Promise.reject(new ManagedMcpError("closed", undefined, "possible"));
  });
  await writeText(f, permit.context);
  expect(f.call).toHaveBeenCalledOnce();
  expect(permit.fail).toHaveBeenCalledOnce();
  expect(permit.release).not.toHaveBeenCalled();
});
it("never calls a connection without a transport gate when the record refuses dispatch", async () => {
  const f = fixture("write", undefined, false);
  const permit = permitFixture(f);
  permit.dispatch.mockReturnValue(false);
  const text = await writeText(f, permit.context);
  expect(f.call).not.toHaveBeenCalled();
  expect(permit.release).toHaveBeenCalledOnce();
  expect(permit.fail).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  expect(text).toContain("Nothing was changed");
});
it("still revokes the run when the frame may have left", async () => {
  const f = fixture("write");
  const permit = permitFixture(f);
  f.call.mockRejectedValue(new ManagedMcpError("closed", undefined, "possible"));
  const text = await writeText(f, permit.context);
  expect(permit.fail).toHaveBeenCalledOnce();
  expect(permit.release).not.toHaveBeenCalled();
  expect(f.recover).toHaveBeenCalledOnce();
  expect(text).toContain("connection to the tool server closed");
  expect(text).toContain("may or may not have been applied");
});
it("never trusts an effect-free claim from a permit that dispatched at admission", async () => {
  const f = fixture("write");
  f.call.mockRejectedValue(noEffectError("not-admitted"));
  await writeText(f, f.context);
  expect(f.recover).toHaveBeenCalledOnce();
});
it("tells the model in fixed words why an oversized result was refused", async () => {
  const f = fixture();
  f.call.mockRejectedValue(new ManagedMcpError("result-too-large"));
  const result = await legacy(f, "tools/call", { name: "echo", arguments: { text: "q" } });
  expect(result.result?.isError).toBe(true);
  expect(result.result?.content?.[0]?.text).toContain("exceeded the size limit");
  expect(f.recover).not.toHaveBeenCalled();
});
it("bounds the description the relay forwards to a model", async () => {
  const f = fixture();
  const long: ExternalMcpConnection = {
    signal: new AbortController().signal,
    tools: [{ name: "echo", description: "\u00e9".repeat(5000), inputSchema }],
    call: f.call,
    close: () => Promise.resolve(),
  };
  const endpoint = createMcpRelayEndpoint(long, { echo: "read" });
  cleanup.push(endpoint.close);
  const response = await endpoint.fetch(
    new Request("https://relay.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    f.context,
  );
  const text = await response.text();
  const description = (/"description":"([^"]*)"/u.exec(text) ?? [])[1] ?? "";
  expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(2048);
  expect(description.length).toBeGreaterThan(0);
});


it("explains a missing connector scope without claiming a changed Pod or reconnect", async () => {
  const f = fixture("write");
  const permit = permitFixture(f);
  f.call.mockRejectedValue(new ManagedMcpError("connector-scope-missing", undefined, "none"));
  const text = await writeText(f, permit.context);
  expect(text).toContain("connector access");
  expect(text).toContain("Full access mode alone does not grant Jira administration");
  expect(text).toContain("Nothing was changed");
  expect(text).not.toMatch(/reconnect|credential|Pod changed/iu);
  expect(permit.release).toHaveBeenCalledOnce();
  expect(f.recover).not.toHaveBeenCalled();
});

it("keeps missing-scope guidance uncertain after a possible effect", async () => {
  const f = fixture("write");
  const permit = permitFixture(f);
  f.call.mockRejectedValue(new ManagedMcpError("connector-scope-missing", undefined, "possible"));
  const text = await writeText(f, permit.context);
  expect(text).toContain("connector access");
  expect(text).toContain("may or may not have been applied");
  expect(text).not.toContain("Nothing was changed");
  expect(permit.release).not.toHaveBeenCalled();
  expect(permit.fail).toHaveBeenCalledOnce();
  expect(f.recover).toHaveBeenCalledOnce();
});
