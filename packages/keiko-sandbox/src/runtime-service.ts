import type { ChildProcess } from "node:child_process";
import { createConnection, createServer, type Server, Socket } from "node:net";

/** Only the trusted original service launcher opts in; ordinary gateway commands never do. */
export const LINUX_GATEWAY_SERVICE_ENV = "KEIKO_LINUX_GATEWAY_SERVICE";
const CONNECTION_LIMIT = 64;
const OUTPUT_LIMIT = 64 * 1024;
type Output = "stdout" | "stderr";
type ServiceOutputWriter = (output: Output, line: string) => void;

/** The producer's closed, body-free loopback announcement, shared with its protocol client. */
export function parseRuntimeLoopbackServiceEndpoint(output: string): string | undefined {
  if (output.length > 1024) return undefined;
  const match =
    /^(?:server listening on |\{"url":")http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:"\})?\n$/u.exec(
      output,
    );
  if (match === null || output.startsWith("{") !== output.endsWith('"}\n')) return undefined;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port <= 65_535
    ? `http://127.0.0.1:${String(port)}`
    : undefined;
}

export function relayRuntimeSockets(client: Socket, upstream: Socket, onError: () => void): void {
  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.once("error", close);
  client.once("close", close);
  upstream.once("close", close);
  upstream.once("error", () => {
    close();
    onError();
  });
  client.pipe(upstream);
  upstream.pipe(client);
}

interface HostServiceState {
  readonly child: ChildProcess;
  readonly gatewayPort: number;
  readonly onFatal: () => void;
  readonly write: ServiceOutputWriter;
  readonly pending: Set<Socket>;
  readonly buffers: Record<Output, string>;
  readonly output: Record<Output, (bytes: Buffer) => void>;
  server: Server | undefined;
  targetPort: number | undefined;
  nextConnectionId: number;
  queuedBytes: number;
  jobs: Promise<void>;
  readonly ready: Promise<void>;
  closed: boolean;
}

function serviceClosed(state: HostServiceState): boolean {
  return state.closed;
}

function serviceSocket(state: HostServiceState, socket: Socket): void {
  if (
    serviceClosed(state) ||
    state.pending.size >= CONNECTION_LIMIT ||
    state.targetPort === undefined
  ) {
    socket.destroy();
    state.onFatal();
    return;
  }
  const connectionId = state.nextConnectionId++;
  if (!Number.isSafeInteger(connectionId)) {
    socket.destroy();
    state.onFatal();
    return;
  }
  state.pending.add(socket);
  socket.once("error", state.onFatal);
  socket.once("close", () => state.pending.delete(socket));
  void transferServiceSocket(state.child, socket, {
    kind: "service-socket",
    connectionId,
    port: state.targetPort,
  }).catch(state.onFatal);
}

async function transferServiceSocket(
  child: ChildProcess,
  socket: Socket,
  message: ServiceSocketMessage,
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      child.send(message, socket, (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function serviceAnnouncement(
  state: HostServiceState,
  line: string,
  output: Output,
): Promise<void> {
  if (serviceClosed(state)) return;
  const endpoint = output === "stdout" ? parseRuntimeLoopbackServiceEndpoint(line) : undefined;
  if (endpoint === undefined) {
    state.write(output, line);
    return;
  }
  const port = Number(new URL(endpoint).port);
  await state.ready;
  if (serviceClosed(state)) return;
  if (state.targetPort !== undefined || port === state.gatewayPort) {
    state.closed = true;
    state.onFatal();
    return;
  }
  state.targetPort = port;
  // IPC transfers the descriptor, not bytes already read into a JavaScript buffer.
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    serviceSocket(state, socket);
  });
  server.maxConnections = CONNECTION_LIMIT;
  server.on("error", state.onFatal);
  state.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (serviceClosed(state) || address === null || typeof address === "string") return;
  state.write(output, line.replace(endpoint, `http://127.0.0.1:${String(address.port)}`));
}

function serviceOutput(state: HostServiceState, output: Output, bytes: Buffer): void {
  if (serviceClosed(state)) return;
  const text = bytes.toString("utf8");
  const pendingBytes =
    Buffer.byteLength(state.buffers.stdout) + Buffer.byteLength(state.buffers.stderr);
  if (pendingBytes + state.queuedBytes + Buffer.byteLength(text) > OUTPUT_LIMIT) {
    state.closed = true;
    state.onFatal();
    return;
  }
  state.buffers[output] += text;
  let end = state.buffers[output].indexOf("\n");
  while (end !== -1) {
    const line = state.buffers[output].slice(0, end + 1);
    state.buffers[output] = state.buffers[output].slice(end + 1);
    const size = Buffer.byteLength(line);
    state.queuedBytes += size;
    state.jobs = state.jobs
      .then(async () => {
        await serviceAnnouncement(state, line, output);
      })
      .catch(state.onFatal)
      .finally(() => {
        state.queuedBytes -= size;
      });
    end = state.buffers[output].indexOf("\n");
  }
}

export interface HostRuntimeService {
  ready(): void;
  close(): Promise<void>;
}

async function closeHostService(state: HostServiceState, releaseReady: () => void): Promise<void> {
  state.closed = true;
  releaseReady();
  state.child.stdout?.off("data", state.output.stdout);
  state.child.stderr?.off("data", state.output.stderr);
  for (const socket of state.pending) socket.destroy();
  await state.jobs;
  // The namespace child has exited before the host invokes this cleanup. Node retains its
  // delegated-worker flag after removing that child, so awaiting close's worker callback hangs.
  // close() stops accepting immediately; the owned child and tracked sockets are already closed.
  if (state.server?.listening === true) state.server.close();
}

function writeServiceOutput(output: Output, line: string): void {
  process[output].write(line);
}

/** One authenticated service is made reachable, never an arbitrary host or namespace destination. */
export function createHostRuntimeService(
  child: ChildProcess,
  gatewayPort: number,
  onFatal: () => void,
  write: ServiceOutputWriter = writeServiceOutput,
): HostRuntimeService {
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const state: HostServiceState = {
    child,
    gatewayPort,
    onFatal,
    write,
    pending: new Set(),
    buffers: { stdout: "", stderr: "" },
    output: {
      stdout: (bytes): void => {
        serviceOutput(state, "stdout", bytes);
      },
      stderr: (bytes): void => {
        serviceOutput(state, "stderr", bytes);
      },
    },
    server: undefined,
    targetPort: undefined,
    nextConnectionId: 1,
    queuedBytes: 0,
    jobs: Promise.resolve(),
    ready,
    closed: false,
  };
  if (child.stdout === null || child.stderr === null) {
    state.closed = true;
    onFatal();
  }
  child.stdout?.on("data", state.output.stdout);
  child.stderr?.on("data", state.output.stderr);
  return {
    ready: markReady,
    close: async (): Promise<void> => {
      await closeHostService(state, markReady);
    },
  };
}

interface ServiceSocketMessage {
  readonly kind: "service-socket";
  readonly connectionId: number;
  readonly port: number;
}

const SERVICE_MESSAGE_KEYS: ReadonlySet<string> = new Set(["kind", "connectionId", "port"]);

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function serviceMessage(value: unknown): ServiceSocketMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== SERVICE_MESSAGE_KEYS.size ||
    !keys.every((key) => SERVICE_MESSAGE_KEYS.has(key)) ||
    record.kind !== "service-socket" ||
    !positiveInteger(record.connectionId, Number.MAX_SAFE_INTEGER) ||
    !positiveInteger(record.port, 65_535)
  )
    return undefined;
  return { kind: "service-socket", connectionId: record.connectionId, port: record.port };
}

export function createNamespaceRuntimeService(
  gatewayPort: number,
  onFatal: () => void,
): { receive(message: unknown, handle: unknown): boolean; close(): void } {
  let targetPort: number | undefined;
  let lastConnectionId = 0;
  const clients = new Set<Socket>();
  return {
    receive: (value, handle): boolean => {
      const message = serviceMessage(value);
      if (message === undefined) return false;
      if (
        !(handle instanceof Socket) ||
        message.port === gatewayPort ||
        (targetPort !== undefined && message.port !== targetPort) ||
        message.connectionId <= lastConnectionId ||
        clients.size >= CONNECTION_LIMIT
      ) {
        if (handle instanceof Socket) handle.destroy();
        onFatal();
        return true;
      }
      targetPort = message.port;
      lastConnectionId = message.connectionId;
      const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
      clients.add(handle);
      handle.once("close", () => clients.delete(handle));
      relayRuntimeSockets(handle, upstream, onFatal);
      return true;
    },
    close: (): void => {
      for (const client of clients) client.destroy();
    },
  };
}
