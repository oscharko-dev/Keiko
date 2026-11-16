// Hermetic loopback process for the real owner; no Keiko, model, Jira, credentials or launcher.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

let server, trace, mode;
function record(event) {
  const events = existsSync(trace) ? JSON.parse(readFileSync(trace, "utf8")) : [];
  events.push(event);
  writeFileSync(trace, JSON.stringify(events), { mode: 0o600 });
}
function close() {
  if (mode === "ignore-term") return;
  record({ kind: "stopped" });
  server.close(() => process.exit(mode === "fail-close" ? 1 : 0));
  server.closeAllConnections();
}
process.once("message", async ({ kind, nonce, initialization }) => {
  if (kind !== "start") process.exit(1);
  const { stateDir, port, restoring } = initialization;
  mode = initialization.mode;
  trace = join(stateDir, "trace.json");
  if (mode === "early-exit") process.exit(0);
  const statePath = join(stateDir, "retained-state.json");
  if (!restoring)
    writeFileSync(statePath, JSON.stringify({ committed: 3 }), { flag: "wx", mode: 0o600 });
  const retained = JSON.parse(readFileSync(statePath, "utf8"));
  server = createServer((request, response) => {
    if (request.url === "/emit-audit-failure") {
      process.exitCode = 1;
      process.send({ kind: "failed", nonce, reason: "activity-log-unavailable" }, () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "reported" }));
      });
      return;
    }
    if (request.url !== "/api/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(mode === "bad-health" ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", committed: retained.committed }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  record({
    kind: "started",
    instance: randomUUID(),
    restoring,
    committed: retained.committed,
    keychain: process.env.KEIKO_OS_KEYCHAIN,
  });
  process.once("SIGTERM", close);
  process.once("disconnect", close);
  if (mode === "never-ready") return;
  process.send({ kind: "ready", nonce: mode === "bad-ready" ? "wrong" : nonce, port });
});
