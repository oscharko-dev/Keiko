import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayFetch } from "./http.js";

const servers = new Set<Server>();
async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  servers.add(server);
  server.listen(0, host);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
  servers.clear();
});

describe("real outbound sockets use the normalized address policy", () => {
  it.each(["0.0.0.0", "[::]", "[::ffff:0:0]", "[::ffff:7f00:1]"])(
    "blocks local-service alias %s before credentials or socket contact",
    async (host) => {
      let contacts = 0;
      const origin = createServer((_req, res) => res.end("synthetic"));
      origin.on("connection", () => {
        contacts += 1;
      });
      const port = await listen(origin);
      const prepareHeaders = vi.fn(() => new Headers({ authorization: "Bearer synthetic-only" }));
      await expect(
        gatewayFetch(`http://${host}:${String(port)}/probe`, {
          timeoutMs: 1000,
          prepareHeaders,
          egress: { allowPrivateNetwork: true, denyLoopback: true, deniedLoopbackPorts: [port] },
        }),
      ).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
      expect(prepareHeaders).not.toHaveBeenCalled();
      expect(contacts).toBe(0);
    },
  );

  it.each(["127.0.0.1", "[::1]", "[::ffff:7f00:1]"])(
    "still reaches an explicitly permitted loopback service through %s",
    async (host) => {
      let authorization: string | undefined;
      const origin = createServer((req, res) => {
        authorization = req.headers.authorization;
        res.setHeader("connection", "close");
        res.end("synthetic");
      });
      const port = await listen(origin, "::");
      const prepareHeaders = vi.fn(() => new Headers({ authorization: "Bearer synthetic-only" }));
      const response = await gatewayFetch(`http://${host}:${String(port)}/probe`, {
        timeoutMs: 1000,
        prepareHeaders,
        egress: { requiredTargetClass: "loopback" },
      });
      expect(await response.text()).toBe("synthetic");
      expect(authorization).toBe("Bearer synthetic-only");
      expect(prepareHeaders).toHaveBeenCalledOnce();
    },
  );

  it("normalizes a permitted IPv6 literal before DNS and a pinned proxy request", async () => {
    const requests: string[] = [];
    const proxy = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("connection", "close");
      res.end("synthetic-proxy");
    });
    const port = await listen(proxy);
    const response = await gatewayFetch("http://[::1]:18443/probe", {
      timeoutMs: 1000,
      egress: {
        httpProxy: `http://127.0.0.1:${String(port)}`,
        pinProxiedConnectTarget: true,
        requiredTargetClass: "loopback",
      },
    });
    expect(await response.text()).toBe("synthetic-proxy");
    expect(requests).toEqual(["http://[::1]:18443/probe"]);
  });
});
