import type { Duplex } from "node:stream";
import type { WebSocket, RawData, WebSocketServer } from "ws";
import { resolveCorrelationId } from "./correlation.js";
import type { IncomingMessage } from "node:http";
import type { UiHandlerDeps } from "./deps.js";
import { isAllowedHost } from "./host-check.js";
import { isVoiceRealtimeCapable } from "./read-handlers.js";

export function rawDataToString(data: RawData, isBinary: boolean): string | undefined {
  if (isBinary) {
    return undefined;
  }
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

export function rawDataByteLength(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return Buffer.from(data).byteLength;
}

export function closeVoiceSockets(server: WebSocketServer): void {
  for (const client of server.clients) client.close(1001, "server shutting down");
  server.close();
}

// Both voice transports require a browser Origin, an allowed loopback Host/Origin pair,
// and the full realtime capability. Preserve the short-circuit order of these gates.
export function isVoiceUpgradeAllowed(
  req: IncomingMessage,
  port: number,
  deps: UiHandlerDeps,
): boolean {
  return (
    typeof req.headers.origin === "string" &&
    isAllowedHost(req, port) &&
    isVoiceRealtimeCapable(deps)
  );
}

interface VoiceUpgradeContext {
  readonly port: number;
  readonly handlerDeps: () => UiHandlerDeps;
}

export function acceptVoiceUpgrade(
  context: VoiceUpgradeContext,
  server: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  onConnection: (ws: WebSocket, deps: UiHandlerDeps, correlationId: string) => void,
): boolean {
  const deps = context.handlerDeps();
  if (!isVoiceUpgradeAllowed(req, context.port, deps)) return false;
  // Resolve once so every later negotiation diagnostic retains the same request identity.
  const correlationId = resolveCorrelationId(req);
  server.handleUpgrade(req, socket, head, (ws) => {
    onConnection(ws, deps, correlationId);
  });
  return true;
}

export type VoiceUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

export function createVoiceUpgradeHandler(
  context: VoiceUpgradeContext,
  server: WebSocketServer,
  matches: (req: IncomingMessage) => boolean,
  onConnection: (ws: WebSocket, deps: UiHandlerDeps, correlationId: string) => void,
): VoiceUpgradeHandler {
  return (req, socket, head) =>
    matches(req) && acceptVoiceUpgrade(context, server, req, socket, head, onConnection);
}
