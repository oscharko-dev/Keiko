import { describe, expect, it } from "vitest";

import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";

import {
  CodexAppServerClient,
  type CodexAppServerScheduler,
  type CodexAppServerTransport,
} from "./codexAppServerClient.js";

interface FakeTransport {
  readonly transport: CodexAppServerTransport;
  readonly writes: string[];
  emit(chunk: string): void;
}
function transport(write?: (chunk: string) => void | Promise<void>): FakeTransport {
  const listeners = new Set<(chunk: string) => void>();
  const writes: string[] = [];
  return {
    transport: {
      write: (chunk: string): void | Promise<void> => {
        writes.push(chunk);
        return write?.(chunk);
      },
      onData: (listener): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    },
    writes,
    emit: (chunk): void => {
      listeners.forEach((listener) => {
        listener(chunk);
      });
    },
  };
}

function toolCall(id: number): string {
  return `${JSON.stringify({
    id,
    method: "item/tool/call",
    params: {
      threadId: "t1",
      turnId: "u1",
      callId: `call-${String(id)}`,
      tool: "keiko_lookup",
      arguments: {},
    },
  })}\n`;
}

describe("Codex app-server client", () => {
  it("emits the generated initialized notification without id or params", async () => {
    const fake = transport();
    const client = new CodexAppServerClient({ transport: fake.transport });
    await client.notify("initialized");
    expect(fake.writes).toEqual(['{"method":"initialized"}\n']);
    await expect(client.request("initialized", undefined)).rejects.toMatchObject({
      code: "method-denied",
    });
  });

  it("correlates pending methods and returns only closed account projections", async () => {
    const fake = transport();
    const client = new CodexAppServerClient({ transport: fake.transport });
    const account = client.request("account/read", {});
    expect(fake.writes).toEqual(['{"id":1,"method":"account/read","params":{}}\n']);
    fake.emit(
      '{"id":1,"result":{"account":{"type":"chatgpt","email":null,"planType":"team"},"requiresOpenaiAuth":true}}\n',
    );
    await expect(account).resolves.toEqual({
      authenticated: true,
      authMode: "chatgpt",
      requiresOpenaiAuth: true,
    });
    const drift = client.request("turn/start", {
      threadId: "t1",
      input: [{ type: "text", text: "x" }],
    });
    fake.emit('{"id":2,"result":{"turn":{"id":"u1"}}}\n');
    await expect(drift).rejects.toMatchObject({ code: "transport-failed" });
  });

  it("accepts remote-control status after initialization without projecting remote identity", async () => {
    const fake = transport();
    const projections: unknown[] = [];
    const client = new CodexAppServerClient({
      transport: fake.transport,
      onProjection: (projection): void => {
        projections.push(projection);
      },
    });
    const initialize = client.request("initialize", {
      clientInfo: { name: "keiko", version: KEIKO_PRODUCT_VERSION },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: [],
      },
    });
    fake.emit(
      '{"id":1,"result":{"codexHome":"/isolated","platformFamily":"unix","platformOs":"macos","userAgent":"codex-cli/0.144.1"}}\n',
    );
    await expect(initialize).resolves.toMatchObject({ codexHome: "/isolated" });
    await client.notify("initialized");
    fake.emit(
      '{"method":"remoteControl/status/changed","params":{"installationId":"private-installation","serverName":"private-server","environmentId":null,"status":"connected"}}\n',
    );
    const account = client.request("account/read", {});
    fake.emit('{"id":2,"result":{"requiresOpenaiAuth":false}}\n');
    await expect(account).resolves.toEqual({
      authenticated: false,
      authMode: null,
      requiresOpenaiAuth: false,
    });
    expect(projections).toEqual([]);
    expect(JSON.stringify(projections)).not.toContain("private-");
  });

  it("fails closed on malformed remote-control status notifications", async () => {
    const failures: string[] = [];
    const fake = transport();
    const client = new CodexAppServerClient({
      transport: fake.transport,
      onFailure: (code): void => {
        failures.push(code);
      },
    });
    fake.emit(
      '{"method":"remoteControl/status/changed","params":{"installationId":"i1","serverName":"s1","status":"unknown"}}\n',
    );
    expect(failures).toEqual(["protocol-invalid"]);
    await expect(client.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });
  });

  it("fails closed on oversized inbound chunks and batches without a large projection count", async () => {
    const failures: string[] = [];
    const projections: unknown[] = [];
    const fake = transport();
    const client = new CodexAppServerClient({
      transport: fake.transport,
      onFailure: (code): void => {
        failures.push(code);
      },
      onProjection: (projection): void => {
        projections.push(projection);
      },
    });
    const notification =
      '{"method":"account/updated","params":{"authMode":"chatgpt","planType":"team"}}\n';
    fake.emit(notification.repeat(257));
    expect(failures).toEqual(["protocol-invalid"]);
    expect(projections).toHaveLength(0);
    await expect(client.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });

    const oversizedFailures: string[] = [];
    const oversized = transport();
    const oversizedClient = new CodexAppServerClient({
      transport: oversized.transport,
      onFailure: (code): void => {
        oversizedFailures.push(code);
      },
    });
    oversized.emit("x".repeat(1024 * 1024 + 1));
    expect(oversizedFailures).toEqual(["protocol-invalid"]);
    await expect(oversizedClient.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });
  });

  it("fails closed on duplicate, unknown, and late response ids", async () => {
    const fake = transport();
    const client = new CodexAppServerClient({ transport: fake.transport });
    const request = client.request("account/read", {});
    fake.emit(
      '{"id":1,"result":{"requiresOpenaiAuth":false}}\n{"id":1,"result":{"requiresOpenaiAuth":false}}\n',
    );
    await expect(request).resolves.toMatchObject({ authenticated: false });
    await expect(client.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });
    const other = transport();
    const otherClient = new CodexAppServerClient({ transport: other.transport });
    other.emit('{"id":999,"result":{}}\n');
    await expect(otherClient.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });
  });

  it("enforces 64 pending and a 1 MiB unresolved async write queue", async () => {
    const never = new Promise<void>(() => undefined);
    const fake = transport(() => never);
    const client = new CodexAppServerClient({ transport: fake.transport });
    for (let index = 0; index < 64; index++)
      void client
        .request("turn/start", {
          threadId: "t",
          input: [{ type: "text", text: "x".repeat(16_200) }],
        })
        .catch(() => undefined);
    await expect(client.request("account/read", {})).rejects.toMatchObject({
      code: "pending-limit",
    });
    const queueFake = transport(() => never);
    const queueClient = new CodexAppServerClient({
      transport: queueFake.transport,
      maxPending: 100,
    });
    for (let index = 0; index < 64; index++)
      void queueClient
        .request("turn/start", {
          threadId: "t",
          input: [{ type: "text", text: "x".repeat(16_200) }],
        })
        .catch(() => undefined);
    await expect(
      queueClient.request("turn/start", {
        threadId: "t",
        input: [{ type: "text", text: "x".repeat(16_200) }],
      }),
    ).rejects.toMatchObject({ code: "queue-limit" });
  });

  it("cancels with AbortSignal and treats the response after cancellation as late", async () => {
    const fake = transport();
    const failures: string[] = [];
    const client = new CodexAppServerClient({
      transport: fake.transport,
      onFailure: (code): void => {
        failures.push(code);
      },
    });
    const abort = new AbortController();
    const pending = client.request("account/read", {}, { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "request-cancelled" });
    expect(failures).toEqual([]);
    fake.emit('{"id":1,"result":{"requiresOpenaiAuth":false}}\n');
    expect(failures).toEqual(["protocol-invalid"]);
    await expect(client.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });
  });

  it("reports an unusable protocol or transport once without raw content and suppresses post-close signals", async () => {
    const protocolFailures: string[] = [];
    const fake = transport();
    const client = new CodexAppServerClient({
      transport: fake.transport,
      onFailure: (code): void => {
        protocolFailures.push(code);
      },
    });
    fake.emit('{"method":"exec","params":{"private":"content"}}\n');
    fake.emit("not-json\n");
    expect(protocolFailures).toEqual(["protocol-invalid"]);
    client.close();

    const transportFailures: string[] = [];
    const broken = transport(() => {
      throw new Error("private transport detail");
    });
    const brokenClient = new CodexAppServerClient({
      transport: broken.transport,
      onFailure: (code): void => {
        transportFailures.push(code);
      },
    });
    await expect(brokenClient.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });
    expect(transportFailures).toEqual(["transport-failed"]);

    const closeFailures: string[] = [];
    const closed = transport();
    const closedClient = new CodexAppServerClient({
      transport: closed.transport,
      onFailure: (code): void => {
        closeFailures.push(code);
      },
    });
    closedClient.close();
    closed.emit("not-json\n");
    await expect(closedClient.request("account/read", {})).rejects.toMatchObject({
      code: "transport-failed",
    });
    expect(closeFailures).toEqual([]);
  });

  it("uses the injected deadline scheduler and content-free error codes", async () => {
    const fake = transport();
    const callbacks = new Map<number, () => void>();
    let next = 0;
    const scheduler: CodexAppServerScheduler = {
      setTimeout: (callback) => (callbacks.set(++next, callback), next),
      clearTimeout: (handle) => void callbacks.delete(handle as number),
    };
    const client = new CodexAppServerClient({
      transport: fake.transport,
      scheduler,
      requestDeadlineMs: 1,
    });
    const pending = client.request("account/read", {});
    callbacks.get(1)?.();
    await expect(pending).rejects.toMatchObject({
      code: "deadline-exceeded",
      message: "deadline-exceeded",
    });
  });

  it("responds exactly once to admitted dynamic tool calls with the generated result shape", async () => {
    const fake = transport();
    const client = new CodexAppServerClient({ transport: fake.transport });
    fake.emit(
      '{"id":9,"method":"item/tool/call","params":{"threadId":"t1","turnId":"u1","callId":"c1","tool":"keiko_lookup","arguments":{"query":"private"}}}\n',
    );
    await client.respondToolCall(9, {
      success: true,
      contentItems: [{ type: "inputText", text: "transient result" }],
    });
    expect(fake.writes.at(-1)).toBe(
      '{"id":9,"result":{"success":true,"contentItems":[{"type":"inputText","text":"transient result"}]}}\n',
    );
    await expect(client.respondToolCall(9, { success: false })).rejects.toMatchObject({
      code: "tool-response-denied",
    });
    await expect(client.respondToolCall(999, { success: false })).rejects.toMatchObject({
      code: "tool-response-denied",
    });
    fake.emit(
      '{"id":10,"method":"item/tool/call","params":{"threadId":"t1","turnId":"u1","callId":"c2","tool":"keiko_lookup","arguments":{}}}\n',
    );
    await client.respondToolCall(10, { success: false });
    expect(fake.writes.at(-1)).toBe('{"id":10,"result":{"success":false,"contentItems":[]}}\n');
    fake.emit(
      '{"id":11,"method":"item/tool/call","params":{"threadId":"t1","turnId":"u1","callId":"c3","tool":"keiko_lookup","arguments":{}}}\n',
    );
    await expect(
      client.respondToolCall(11, {
        success: true,
        contentItems: [{ type: "inputText", text: "x".repeat(64 * 1024) }],
      }),
    ).rejects.toMatchObject({ code: "queue-limit" });
    await client.respondToolCall(11, { success: false });
    client.close();
    await expect(client.respondToolCall(10, { success: false })).rejects.toMatchObject({
      code: "tool-response-denied",
    });
  });

  it("bounds only concurrent tool calls while denying recent replays", async () => {
    const failures: string[] = [];
    const sequential = transport();
    const client = new CodexAppServerClient({
      transport: sequential.transport,
      onFailure: (code): void => {
        failures.push(code);
      },
    });
    for (let id = 1; id <= 128; id += 1) {
      sequential.emit(toolCall(id));
      await expect(client.respondToolCall(id, { success: false })).resolves.toBeUndefined();
    }
    expect(failures).toEqual([]);
    sequential.emit(toolCall(128));
    expect(failures).toEqual(["protocol-invalid"]);

    const concurrentFailures: string[] = [];
    const concurrent = transport();
    const concurrentClient = new CodexAppServerClient({
      transport: concurrent.transport,
      onFailure: (code): void => {
        concurrentFailures.push(code);
      },
    });
    for (let id = 1; id <= 65; id += 1) concurrent.emit(toolCall(id));
    expect(concurrentFailures).toEqual(["protocol-invalid"]);
    await expect(concurrentClient.respondToolCall(1, { success: false })).rejects.toMatchObject({
      code: "tool-response-denied",
    });
  });

  it("retires an admitted tool call synchronously without a transport write", () => {
    const fake = transport();
    const client = new CodexAppServerClient({ transport: fake.transport });
    fake.emit(toolCall(77));

    expect(client.abandonToolCall(77)).toBe(true);
    expect(client.abandonToolCall(77)).toBe(false);
    expect(fake.writes).toEqual([]);
    fake.emit(toolCall(77));
  });
});
