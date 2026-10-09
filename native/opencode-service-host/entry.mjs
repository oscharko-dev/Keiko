import { maxBytes } from "./keiko-host-packet-data.mjs";
import { createServer } from "node:http";
import { Cause, Context, Effect, Exit, References } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpRouter } from "effect/unstable/http";

const { AbortController, TextDecoder } = globalThis;

/** Fixed process lifetime only; original routes, task engine and upgrade handling remain native. */
export async function runFixedHostEntry(makeRoutes) {
  if (process.argv.length !== 2 || Object.hasOwn(process.env, "NODE_OPTIONS")) return refuseEntry();
  const lifetime = startPacketLifetime(process.stdin);
  try {
    const input = await lifetime.packet;
    const exit = await Effect.runPromiseExit(
      Effect.scoped(serveFixedHostRoutes(makeRoutes, input, lifetime.signal)).pipe(
        Effect.provide(NodeHttpServer.layerHttpServices),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
      { signal: lifetime.signal },
    );
    if (lifetime.failed() || (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)))
      return refuseEntry();
    return 0;
  } catch {
    // Packet/config acquisition is closed; never serialize the rejected input or native cause.
    return refuseEntry();
  } finally {
    lifetime.dispose();
  }
}

export function serveFixedHostRoutes(makeRoutes, input, signal, ready = writeEndpoint) {
  return Effect.gen(function* () {
    const context = yield* makeRoutes(input);
    const server = createServer();
    const http = yield* NodeHttpServer.make(() => server, {
      host: "127.0.0.1",
      port: 0,
      gracefulShutdownTimeout: "1 second",
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()));
    const app = Context.get(context, HttpRouter.HttpRouter).asHttpEffect();
    yield* http.serve(app.pipe(Effect.provide(context)));
    if (signal.aborted) return yield* Effect.interrupt;
    if (http.address._tag !== "TcpAddress") return yield* Effect.die("host-address-invalid");
    yield* Effect.sync(() => {
      ready(`http://127.0.0.1:${http.address.port}`);
    });
    return yield* Effect.never;
  });
}

function startPacketLifetime(stream) {
  const controller = new AbortController();
  let bytes = Buffer.alloc(0);
  let committed = false;
  let failed = false;
  let resolvePacket;
  let rejectPacket;
  const packet = new Promise((resolve, reject) => {
    resolvePacket = resolve;
    rejectPacket = reject;
  });
  const refuse = () => {
    failed = true;
    rejectPacket(new TypeError("host-packet-invalid"));
    controller.abort();
  };
  const onData = (chunk) => {
    if (committed || bytes.length + chunk.length > maxBytes) return refuse();
    bytes = Buffer.concat([bytes, chunk]);
    const newline = bytes.indexOf(10);
    if (newline < 0) return;
    if (newline !== bytes.length - 1) return refuse();
    try {
      const input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)),
      );
      committed = true;
      bytes = Buffer.alloc(0);
      resolvePacket(input);
    } catch {
      // Malformed UTF-8/JSON produces a constant protocol verdict, never reflected packet bytes.
      refuse();
    }
  };
  const onEnd = () => {
    if (!committed) refuse();
    else controller.abort();
  };
  stream.on("data", onData).once("end", onEnd).once("error", refuse);
  return {
    packet,
    signal: controller.signal,
    failed: () => failed,
    dispose: () => {
      stream.off("data", onData).off("end", onEnd).off("error", refuse);
      stream.pause();
    },
  };
}

function refuseEntry() {
  process.stderr.write("host-entry-refused\n");
  return 1;
}

function writeEndpoint(url) {
  process.stdout.write(JSON.stringify({ url }) + "\n");
}
