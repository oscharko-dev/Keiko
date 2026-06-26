// Minimal real-subprocess LSP server fixture (Issue #1381, ADR-0069 D7). It speaks the LSP base
// protocol (Content-Length framing + JSON-RPC 2.0) over real stdio so a small integration test can
// prove end-to-end protocol fidelity against a process the manager actually spawns. It answers
// `initialize`, echoes an arbitrary request, and exits on `shutdown`+`exit`. Passing `--crash` makes
// it exit non-zero immediately after `initialize`, exercising the crash path against a real child.
//
// Kept as `.mjs` so coverage tooling does not include it (it runs out-of-process, not under vitest).

const CRASH = process.argv.includes("--crash");

let buffer = Buffer.alloc(0);

function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (typeof message.method !== "string") return;
  if (message.method === "exit") {
    process.exit(0);
    return;
  }
  if (typeof message.id !== "number") return;
  if (message.method === "initialize") {
    writeFrame({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    if (CRASH) process.exit(1);
    return;
  }
  if (message.method === "shutdown") {
    writeFrame({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  writeFrame({ jsonrpc: "2.0", id: message.id, result: { method: message.method } });
}

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (match === null) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // Ignore malformed input; a real server would respond with a parse error.
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
