// ADR-0043 D17: the dependency install is the one verification command that keeps host network,
// and npm offers no destination allowlist of its own. This module is that allowlist. The install is
// pointed at a loopback proxy that tunnels a CONNECT to the approved registry's own host and port
// and refuses every other destination: another host or port, an IP literal, a plain-HTTP request.
// Git dependencies never reach it (git would not use npm's proxy), so npm is told to refuse them
// outright. What flows through a tunnel is npm's TLS session with the registry, verified by npm
// against the registry's certificate; the proxy only decides where a connection may go.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";

// npm opens at most `maxsockets` (15) connections per origin; the ceiling leaves room for that and
// refuses a flood rather than queueing it.
const MAX_PROXY_CONNECTIONS = 64;
// An upstream that does not answer, or a tunnel that falls silent, is closed instead of held for
// the rest of the install's wall time.
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;
const TUNNEL_IDLE_TIMEOUT_MS = 60_000;
const REFUSED_RESPONSE = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const UPSTREAM_FAILED_RESPONSE =
  "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const ESTABLISHED_RESPONSE = "HTTP/1.1 200 Connection Established\r\n\r\n";

/** How the install used the proxy: tunnels opened to the registry, requests refused. */
export interface RegistryEgressCounts {
  readonly allowed: number;
  readonly refused: number;
}

export interface RegistryEgressProxy {
  // `http://127.0.0.1:<port>`, the value npm's `proxy` and `https-proxy` are set to.
  readonly url: string;
  readonly counts: () => RegistryEgressCounts;
  // Closes the listener and every live tunnel.
  readonly close: () => Promise<void>;
}

export interface RegistryEgressOptions {
  // The approved registry, a credential-free https URL; its host and port are the one destination.
  readonly registry: string;
  // Opens the upstream connection of an approved tunnel. Tests inject it so no test ever reaches
  // the real registry.
  readonly connectUpstream?: ((host: string, port: number) => Socket) | undefined;
}

/**
 * The npm configuration that routes every fetch of the install through the proxy: an empty
 * `noproxy` lets no destination bypass it, `allow-git=none` refuses a Git dependency before git
 * runs, and the registry is pinned to the approved one.
 */
export function registryEgressEnv(
  proxyUrl: string,
  registry: string,
): Readonly<Record<string, string>> {
  return {
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
    npm_config_noproxy: "",
    npm_config_allow_git: "none",
    npm_config_registry: registry,
  };
}

interface Destination {
  readonly host: string;
  readonly port: number;
  readonly authority: string;
}

function approvedDestination(registry: string): Destination {
  const url = new URL(registry);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("the approved registry must be a credential-free https URL");
  }
  const port = url.port === "" ? 443 : Number(url.port);
  const host = url.hostname.toLowerCase();
  return { host, port, authority: `${host}:${String(port)}` };
}

interface ProxyState {
  allowed: number;
  refused: number;
  readonly sockets: Set<Socket>;
}

// Every socket the proxy holds is closed with it, and none can raise an unhandled 'error': a peer
// that resets mid-response must end its own connection, never the server that hosts the proxy.
function track(state: ProxyState, socket: Socket): void {
  state.sockets.add(socket);
  socket.on("error", () => {
    socket.destroy();
  });
  socket.once("close", () => {
    state.sockets.delete(socket);
  });
}

function refuse(state: ProxyState, client: Socket): void {
  state.refused += 1;
  client.end(REFUSED_RESPONSE, () => {
    client.destroy();
  });
}

// Relays both directions once the upstream answers. Either side closing, failing or falling silent
// tears the tunnel down; a failure before the upstream answered is reported to npm as a 502.
function tunnel(state: ProxyState, client: Socket, head: Buffer, upstream: Socket): void {
  let established = false;
  let closed = false;
  const teardown = (): void => {
    if (closed) return;
    closed = true;
    upstream.destroy();
    if (established || client.destroyed) {
      client.destroy();
      return;
    }
    client.end(UPSTREAM_FAILED_RESPONSE, () => {
      client.destroy();
    });
  };
  track(state, upstream);
  upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS);
  upstream.once("connect", () => {
    established = true;
    upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
    client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
    client.write(ESTABLISHED_RESPONSE);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  for (const socket of [client, upstream]) {
    socket.on("error", teardown);
    socket.once("close", teardown);
    socket.once("timeout", teardown);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the registry egress proxy has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeProxy(server: Server, state: ProxyState): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

export async function startRegistryEgressProxy(
  options: RegistryEgressOptions,
): Promise<RegistryEgressProxy> {
  const destination = approvedDestination(options.registry);
  const connectUpstream =
    options.connectUpstream ?? ((host: string, port: number): Socket => connect({ host, port }));
  const state: ProxyState = { allowed: 0, refused: 0, sockets: new Set() };
  const server = createServer((_request, response) => {
    // A plain-HTTP request names its destination in the request line; none is approved.
    state.refused += 1;
    response.writeHead(403, { connection: "close" }).end();
  });
  server.maxConnections = MAX_PROXY_CONNECTIONS;
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    track(state, client);
    if ((request.url ?? "").toLowerCase() !== destination.authority) {
      refuse(state, client);
      return;
    }
    state.allowed += 1;
    tunnel(state, client, head, connectUpstream(destination.host, destination.port));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${String(port)}`,
    counts: () => ({ allowed: state.allowed, refused: state.refused }),
    close: () => closeProxy(server, state),
  };
}
