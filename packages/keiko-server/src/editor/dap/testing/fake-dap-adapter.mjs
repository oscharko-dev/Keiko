import process from "node:process";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const delimiter = Buffer.from("\r\n\r\n", "ascii");
let pending = Buffer.alloc(0);
let sequence = 1;
let exceptionBreakpointsEnabled = false;
const descendant = process.argv.includes("--with-descendant")
  ? spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
        detached: true,
      },
    )
  : undefined;

// ADR-0136 D2 designates a private Unix-domain socket (the real production adapter creates the
// socket inode; the manager's dapPrivateEndpoint.ts connects to it) as the actual production wire
// transport. When invoked with --socket=<path> this fixture creates that socket inode itself,
// exactly the way the real adapter would, so tests can prove a real DAP handshake over the real
// chosen transport end-to-end instead of only over stdio.
const socketArg = process.argv.find((arg) => arg.startsWith("--socket="));
const socketPath = socketArg === undefined ? undefined : socketArg.slice("--socket=".length);

let writeFrame = (frame) => {
  process.stdout.write(frame);
};
let endTransport = () => {
  process.stdin.pause();
};

function attachTransport(source) {
  source.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    drain();
  });
}

if (socketPath === undefined) {
  attachTransport(process.stdin);
} else {
  const server = createServer((socket) => {
    writeFrame = (frame) => {
      socket.write(frame);
    };
    endTransport = () => {
      socket.end();
    };
    attachTransport(socket);
    server.close();
  });
  server.listen(socketPath);
}

function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: sequence++, ...message }), "utf8");
  writeFrame(
    Buffer.concat([Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "ascii"), body]),
  );
}

function response(request, body = {}) {
  send({
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
    body,
  });
}

function event(event, body = {}) {
  send({ type: "event", event, body });
}

function stopped(reason) {
  event("stopped", {
    reason,
    threadId: 1,
    allThreadsStopped: true,
    ...(reason === "exception" ? { description: "Fixture uncaught exception" } : {}),
  });
}

function continueAndStop(reason = "step") {
  event("continued", { threadId: 1, allThreadsContinued: true });
  setImmediate(() => stopped(reason));
}

function dispatch(request) {
  if (request?.type !== "request" || !Number.isSafeInteger(request.seq)) return;
  if (request.command === "initialize") {
    response(request, {
      supportsTerminateRequest: true,
      supportsConfigurationDoneRequest: true,
      supportsSetVariable: true,
    });
    event("initialized");
    return;
  }
  if (request.command === "launch") {
    response(request);
    return;
  }
  if (request.command === "configurationDone") {
    response(request);
    setImmediate(() => stopped(exceptionBreakpointsEnabled ? "exception" : "breakpoint"));
    return;
  }
  if (request.command === "setBreakpoints") {
    const breakpoints = Array.isArray(request.arguments?.breakpoints)
      ? request.arguments.breakpoints
      : [];
    response(request, {
      breakpoints: breakpoints.map((breakpoint) => ({ ...breakpoint, verified: true })),
    });
    return;
  }
  if (request.command === "setExceptionBreakpoints") {
    exceptionBreakpointsEnabled = Array.isArray(request.arguments?.filters)
      ? request.arguments.filters.includes("uncaught")
      : false;
    response(request, { breakpoints: [] });
    return;
  }
  if (request.command === "threads") {
    response(request, { threads: [{ id: 1, name: "fake-main" }] });
    return;
  }
  if (request.command === "stackTrace") {
    response(request, {
      stackFrames: [
        {
          id: 1,
          name: exceptionBreakpointsEnabled ? "throwsFixture" : "breakpointFixture",
          source: { path: "/keiko-execution-root/src/program.ts" },
          line: exceptionBreakpointsEnabled ? 8 : 4,
          column: 1,
        },
      ],
      totalFrames: 1,
    });
    return;
  }
  if (request.command === "scopes") {
    response(request, { scopes: [{ name: "Local", variablesReference: 1, expensive: false }] });
    return;
  }
  if (request.command === "variables") {
    response(request, {
      variables: [
        { name: "total", value: "2", type: "number", variablesReference: 0 },
        { name: "message", value: "safe fixture", type: "string", variablesReference: 0 },
      ],
    });
    return;
  }
  if (request.command === "evaluate") {
    response(request, { result: "2", type: "number", variablesReference: 0 });
    return;
  }
  if (request.command === "setVariable") {
    response(request, {
      value: request.arguments?.value ?? "",
      type: "number",
      variablesReference: 0,
    });
    return;
  }
  if (["continue", "next", "stepIn", "stepOut"].includes(request.command)) {
    response(request);
    continueAndStop("step");
    return;
  }
  if (request.command === "pause") {
    response(request);
    setImmediate(() => stopped("pause"));
    return;
  }
  if (request.command === "descendantInfo") {
    response(request, { pid: descendant?.pid });
    return;
  }
  if (request.command === "disconnect") {
    response(request);
    endTransport();
    setImmediate(() => process.exit(0));
    return;
  }
  send({
    type: "response",
    request_seq: request.seq,
    success: false,
    command: request.command,
    message: "UNSUPPORTED",
  });
}

function drain() {
  for (;;) {
    const headerEnd = pending.indexOf(delimiter);
    if (headerEnd < 0) return;
    const header = pending.subarray(0, headerEnd).toString("ascii");
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(header);
    if (match === null) process.exit(2);
    const length = Number.parseInt(match[1] ?? "", 10);
    const bodyStart = headerEnd + delimiter.length;
    const bodyEnd = bodyStart + length;
    if (pending.length < bodyEnd) return;
    const body = pending.subarray(bodyStart, bodyEnd);
    pending = pending.subarray(bodyEnd);
    try {
      dispatch(JSON.parse(body.toString("utf8")));
    } catch {
      process.exit(3);
    }
  }
}
