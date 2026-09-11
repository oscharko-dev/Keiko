import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registryEgressEnv,
  startRegistryEgressProxy,
  type RegistryEgressProxy,
} from "./registryEgress.js";

const REGISTRY = "https://registry.npmjs.org/";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function listenLoopback(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  cleanups.push(() => closeServer(server));
  return address.port;
}

// Stands for any destination the install must never reach; it counts every connection that arrives.
async function recordingListener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  return { port: await listenLoopback(server), connections: () => connections };
}

// Stands for the registry, so an approved tunnel is proven end to end without leaving the machine.
async function echoUpstream(): Promise<number> {
  const server = createServer((socket) => {
    socket.pipe(socket);
  });
  return listenLoopback(server);
}

async function proxyWith(
  connectUpstream?: (host: string, port: number) => Socket,
): Promise<RegistryEgressProxy> {
  const proxy = await startRegistryEgressProxy({ registry: REGISTRY, connectUpstream });
  cleanups.push(() => proxy.close());
  return proxy;
}

// Sends a raw CONNECT and resolves with the status line the proxy answered and the open socket.
async function connectThrough(
  proxy: RegistryEgressProxy,
  authority: string,
): Promise<{ status: string; socket: Socket }> {
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
  cleanups.push(() => {
    socket.destroy();
    return Promise.resolve();
  });
  await once(socket, "connect");
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const [chunk] = (await once(socket, "data")) as [Buffer];
  return { status: chunk.toString("latin1").split("\r\n")[0] ?? "", socket };
}

describe("startRegistryEgressProxy", () => {
  it("tunnels a CONNECT to the approved registry and relays both directions", async () => {
    const upstreamPort = await echoUpstream();
    const dialled: string[] = [];
    const proxy = await proxyWith((host, port) => {
      dialled.push(`${host}:${String(port)}`);
      return connect({ host: "127.0.0.1", port: upstreamPort });
    });

    const { status, socket } = await connectThrough(proxy, "registry.npmjs.org:443");
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    socket.write("ping");
    const [echoed] = (await once(socket, "data")) as [Buffer];

    expect(echoed.toString()).toBe("ping");
    expect(dialled).toEqual(["registry.npmjs.org:443"]);
    expect(proxy.counts()).toEqual({ allowed: 1, refused: 0 });
  });

  it("forwards bytes a client pipelined behind its CONNECT", async () => {
    const upstreamPort = await echoUpstream();
    const proxy = await proxyWith(() => connect({ host: "127.0.0.1", port: upstreamPort }));
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    cleanups.push(() => {
      socket.destroy();
      return Promise.resolve();
    });
    await once(socket, "connect");
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });

    // The first bytes of the tunnel travel in the same write as the request, as a client that
    // does not wait for the 200 sends its TLS ClientHello.
    socket.write(
      "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\nping",
    );

    await vi.waitFor(() => {
      expect(received).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
    });
  });

  it("refuses a loopback destination without ever connecting to it", async () => {
    const listener = await recordingListener();
    const dialled: string[] = [];
    const proxy = await proxyWith((host, port) => {
      dialled.push(`${host}:${String(port)}`);
      return connect({ host, port });
    });

    const { status } = await connectThrough(proxy, `127.0.0.1:${String(listener.port)}`);

    expect(status).toBe("HTTP/1.1 403 Forbidden");
    expect(listener.connections()).toBe(0);
    expect(dialled).toEqual([]);
    expect(proxy.counts()).toEqual({ allowed: 0, refused: 1 });
  });

  it("refuses every other host, port and spelling of an address", async () => {
    const dialled: string[] = [];
    const proxy = await proxyWith((host, port) => {
      dialled.push(`${host}:${String(port)}`);
      return connect({ host, port });
    });
    const others = [
      "example.com:443",
      "registry.npmjs.org:80",
      "registry.npmjs.org.:443",
      "registry.npmjs.org",
      "104.16.0.35:443",
      "[::1]:443",
    ];

    for (const authority of others) {
      const { status } = await connectThrough(proxy, authority);
      expect(status, authority).toBe("HTTP/1.1 403 Forbidden");
    }

    expect(dialled).toEqual([]);
    expect(proxy.counts()).toEqual({ allowed: 0, refused: others.length });
  });

  it("accepts the registry host in any letter case, as DNS does", async () => {
    const upstreamPort = await echoUpstream();
    const proxy = await proxyWith(() => connect({ host: "127.0.0.1", port: upstreamPort }));

    const { status } = await connectThrough(proxy, "Registry.NPMJS.org:443");

    expect(status).toBe("HTTP/1.1 200 Connection Established");
  });

  it("refuses a plain-HTTP request without forwarding it", async () => {
    const listener = await recordingListener();
    const proxy = await proxyWith();

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: Number(new URL(proxy.url).port),
        method: "GET",
        path: `http://127.0.0.1:${String(listener.port)}/dependency.tgz`,
      });
      request.once("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once("error", reject);
      request.end();
    });

    expect(status).toBe(403);
    expect(listener.connections()).toBe(0);
    expect(proxy.counts()).toEqual({ allowed: 0, refused: 1 });
  });

  it("answers 502 when the registry cannot be reached", async () => {
    // A port that was just released: nothing listens on it any more.
    const released = createServer();
    released.listen(0, "127.0.0.1");
    await once(released, "listening");
    const address = released.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    await closeServer(released);
    const proxy = await proxyWith(() => connect({ host: "127.0.0.1", port: address.port }));

    const { status } = await connectThrough(proxy, "registry.npmjs.org:443");

    expect(status).toBe("HTTP/1.1 502 Bad Gateway");
    expect(proxy.counts()).toEqual({ allowed: 1, refused: 0 });
  });

  it("survives a client that resets while it is being refused", async () => {
    const proxy = await proxyWith();
    const port = Number(new URL(proxy.url).port);
    const socket = connect({ host: "127.0.0.1", port });
    await once(socket, "connect");
    socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    socket.resetAndDestroy();
    await once(socket, "close");

    const { status } = await connectThrough(proxy, "example.com:443");

    expect(status).toBe("HTTP/1.1 403 Forbidden");
  });

  // A malformed request never reaches a CONNECT or request handler: the parser's clientError path
  // destroys that one socket and the proxy keeps serving (PR #3452 review).
  it("drops a malformed request and keeps serving", async () => {
    const proxy = await proxyWith();
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    cleanups.push(() => {
      socket.destroy();
      return Promise.resolve();
    });
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write("\u0000\u0001 not an HTTP request\r\n\r\n");

    await expect(closed).resolves.toBeDefined();
    const { status } = await connectThrough(proxy, "example.com:443");
    expect(status).toBe("HTTP/1.1 403 Forbidden");
    expect(proxy.counts()).toEqual({ allowed: 0, refused: 1 });
  });

  // A server-level fault (a failed accept, EMFILE) must close this proxy and name the fault, never
  // surface as an uncaught exception in the process hosting it (PR #3452 review).
  it("closes itself and names a server-level fault instead of throwing", async () => {
    let server: import("node:http").Server | undefined;
    const proxy = await startRegistryEgressProxy({
      registry: REGISTRY,
      inspectServer: (listening) => {
        server = listening;
      },
    });
    cleanups.push(() => proxy.close());

    server?.emit("error", Object.assign(new Error("accept failed"), { code: "EMFILE" }));

    expect(proxy.fault()).toBe("EMFILE");
    await vi.waitFor(() => {
      expect(server?.listening).toBe(false);
    });
  });

  it("closes a live tunnel when the proxy closes", async () => {
    const upstreamPort = await echoUpstream();
    const proxy = await startRegistryEgressProxy({
      registry: REGISTRY,
      connectUpstream: () => connect({ host: "127.0.0.1", port: upstreamPort }),
    });
    const { socket } = await connectThrough(proxy, "registry.npmjs.org:443");
    const closed = once(socket, "close");

    await proxy.close();

    await expect(closed).resolves.toBeDefined();
  });

  it("refuses to start for a registry that is not a credential-free https URL", async () => {
    await expect(
      startRegistryEgressProxy({ registry: "http://registry.npmjs.org/" }),
    ).rejects.toThrow(TypeError);
    await expect(
      startRegistryEgressProxy({ registry: "https://user:secret@registry.npmjs.org/" }),
    ).rejects.toThrow(TypeError);
  });
});

describe("registryEgressEnv", () => {
  it("routes every npm fetch through the proxy, bypasses nothing and refuses Git", () => {
    expect(registryEgressEnv("http://127.0.0.1:4873", REGISTRY)).toEqual({
      npm_config_proxy: "http://127.0.0.1:4873",
      npm_config_https_proxy: "http://127.0.0.1:4873",
      npm_config_noproxy: "",
      npm_config_allow_git: "none",
      npm_config_registry: REGISTRY,
    });
  });
});
