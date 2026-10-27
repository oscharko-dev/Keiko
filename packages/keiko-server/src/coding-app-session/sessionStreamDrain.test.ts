// A real loopback HTTP stream, so `res.write()` answers from Node's own buffer accounting rather than
// from a test double (Keiko 1.3.0 test, #3897). The client pauses until the server's buffer passes
// its high-water mark, which is exactly what one near-capacity activity snapshot does to an idle
// local browser on Node 24, and then reads normally.
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSessionPairingPort, fakePairingRequestBody } from "./_support.js";
import { CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS } from "./channelContract.js";
import { openCodingAppSessionStream } from "./codingAppSessionRoutes.js";
import {
  createCodingAppSessionChannel,
  type CodingAppSessionContentSource,
} from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";

const MAX_PUBLISHES_TO_FILL = 20_000;
const WAIT_DEADLINE_MS = 5_000;

interface Fixture {
  readonly server: Server;
  readonly emit: (body: string) => void;
  readonly record: ReturnType<typeof vi.fn>;
  readonly serverResponse: () => ServerResponse | undefined;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function probeSource(): {
  readonly source: CodingAppSessionContentSource;
  readonly emit: (body: string) => void;
} {
  type SubscribeContent = NonNullable<CodingAppSessionContentSource["subscribeContent"]>;
  type Listener = Parameters<SubscribeContent>[0];
  const listeners = new Set<Listener>();
  return {
    source: {
      contentFor: () => ({ kind: "probe", body: "initial" }),
      subscribeContent: (listener): ReturnType<SubscribeContent> => {
        listeners.add(listener);
        return { admitted: true, detach: (): void => void listeners.delete(listener) };
      },
    },
    emit: (body): void => {
      for (const listener of [...listeners]) listener({ kind: "probe", body });
    },
  };
}

async function startFixture(): Promise<Fixture & { readonly cookieToken: string }> {
  const probe = probeSource();
  const record = vi.fn();
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
    diagnostics: { record },
    contentSource: probe.source,
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("pairing failed");
  let streamResponse: ServerResponse | undefined;
  const server = createServer((req, res) => {
    streamResponse = res;
    openCodingAppSessionStream(res, req, channel, paired.cookieToken, "drain-real", { record });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    emit: probe.emit,
    record,
    serverResponse: () => streamResponse,
    cookieToken: paired.cookieToken,
  };
}

function openClient(server: Server): Promise<IncomingMessage> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/stream", method: "GET" }, resolve);
    req.once("error", reject);
    req.end();
  });
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`stream never delivered ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("app-session stream on a real loopback socket", () => {
  it("waits for drain instead of closing when a frame passes the high-water mark", async () => {
    const fixture = await startFixture();
    const client = await openClient(fixture.server);
    cleanup = async (): Promise<void> => {
      client.destroy();
      fixture.server.closeAllConnections();
      fixture.server.close();
      await once(fixture.server, "close");
    };
    let received = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      received += chunk;
    });
    await waitFor(() => received.includes("initial"), "the initial snapshot");
    client.pause();
    const response = fixture.serverResponse();
    if (response === undefined) throw new Error("stream response missing");

    const body = (index: number): string =>
      `${String(index).padStart(6, "0")}${"x".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS - 6)}`;
    let published = 0;
    while (!response.writableNeedDrain && published < MAX_PUBLISHES_TO_FILL) {
      fixture.emit(body(published));
      published += 1;
    }
    expect(response.writableNeedDrain).toBe(true);
    fixture.emit("superseded-while-draining");
    fixture.emit("newest-while-draining");
    client.resume();

    await waitFor(() => received.includes("newest-while-draining"), "the newest snapshot");
    expect(fixture.record).not.toHaveBeenCalled();
    expect(received).not.toContain("superseded-while-draining");
    expect(response.writableEnded).toBe(false);

    fixture.emit("after-drain");
    await waitFor(() => received.includes("after-drain"), "a snapshot after the drain");
    expect(fixture.record).not.toHaveBeenCalled();
  });
});
