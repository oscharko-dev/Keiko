// TEST-ONLY loopback server lifecycle support.
//
// This file is excluded from the package build and coverage. It binds the real UI server exactly
// once on an OS-selected ephemeral port, then aligns the mutable construction descriptor with that
// bound authority before returning control to a test. This avoids both port-reservation TOCTOU races
// and stale HTTP keep-alive sockets reconnecting to a replacement server on the same authority.

import type { Server } from "node:http";
import { createUiServer, UI_HOST, type UiServerDeps } from "../server.js";

export interface StartedUiTestServer {
  readonly port: number;
  readonly server: Server;
}

type UiTestServerDeps = Omit<UiServerDeps, "port">;
const RECENT_PORT_LIMIT = 256;
const recentPorts: number[] = [];

function listenOnEphemeralPort(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rejectListen = (error: Error): void => {
      reject(error);
    };
    server.once("error", rejectListen);
    server.listen(0, UI_HOST, (): void => {
      server.off("error", rejectListen);
      resolve();
    });
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("UI test server did not bind a TCP authority");
  }
  return address.port;
}

function rememberPort(port: number): void {
  recentPorts.push(port);
  if (recentPorts.length > RECENT_PORT_LIMIT) {
    recentPorts.shift();
  }
}

export async function startUiTestServer(
  dependencies: UiTestServerDeps,
): Promise<StartedUiTestServer> {
  for (let attempt = 0; attempt <= RECENT_PORT_LIMIT; attempt += 1) {
    const serverDeps = { ...dependencies, port: 0 };
    const server = createUiServer(serverDeps);
    await listenOnEphemeralPort(server);
    const port = boundPort(server);
    if (recentPorts.includes(port)) {
      await closeUiTestServer(server);
      continue;
    }
    rememberPort(port);
    serverDeps.port = port;
    return { port, server };
  }
  throw new Error("Unable to bind a fresh UI test server authority");
}

export function closeUiTestServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}
