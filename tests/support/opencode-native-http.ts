import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;

export function nativeHttpEventFrame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function writeNativeHttpStreamedTurn(
  response: ServerResponse,
  delta: unknown,
  finish: string,
  id: string,
): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    nativeHttpEventFrame({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }],
    }),
  );
  response.end(
    nativeHttpEventFrame({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + "data: [DONE]\n\n",
  );
}

export interface NativeRecordedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface NativeHttpListener {
  readonly server: Server;
  port: number;
}

export interface NativeHttpStub extends NativeHttpListener {
  readonly requests: NativeRecordedRequest[];
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_FIXTURE_BODY_BYTES) throw new Error("fixture-body-oversized");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseNativeHttpJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Non-JSON and empty bodies retain their original UTF-8 text.
    return text;
  }
}

/** Read complete bounded bytes before the caller observes headers or selects its record view. */
export async function startNativeHttpByteListener(
  listener: NativeHttpListener,
  respond: (request: IncomingMessage, bytes: Buffer, response: ServerResponse) => void,
): Promise<void> {
  const server = listener.server;
  server.on("request", (request, response) => {
    void readRequestBody(request)
      .then((bytes) => {
        respond(request, bytes, response);
      })
      .catch(() => response.writeHead(500).end());
  });
  try {
    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("fixture-listener-invalid");
    listener.port = address.port;
  } catch (error) {
    try {
      if (server.listening) await closeNativeHttpStub(listener);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-listener-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export async function startNativeHttpStub(
  respond: (
    stub: NativeHttpStub,
    recorded: NativeRecordedRequest,
    response: ServerResponse,
  ) => void,
): Promise<NativeHttpStub> {
  const requests: NativeRecordedRequest[] = [];
  const stub: NativeHttpStub = { server: createServer(), port: 0, requests };
  await startNativeHttpByteListener(stub, (request, bytes, response) => {
    const recorded = {
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body: parseNativeHttpJson(bytes.toString("utf8")),
    };
    requests.push(recorded);
    respond(stub, recorded, response);
  });
  return stub;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

export async function closeNativeHttpStub(stub: NativeHttpListener): Promise<void> {
  stub.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    stub.server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

/** Keep a primary fixture failure observable if resource disposal also fails. */
export async function withNativeHttpStub(
  resource: NativeHttpListener,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    try {
      await closeNativeHttpStub(resource);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-listener-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  await closeNativeHttpStub(resource);
}

export interface NativeHttpToolCall {
  readonly index: 0;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string | undefined;
  };
}

/** The exact single function-call packet used by scripted native gateway turns. */
export function nativeHttpToolCall(
  id: string,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): NativeHttpToolCall {
  return {
    index: 0,
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(argumentsValue) },
  };
}
