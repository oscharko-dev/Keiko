// Only the parent-owned IPC channel can initialize this child. Ordinary server composition is shared.
import { OWNED_LIVE_CHAT_CLOSE_TIMEOUT_MS } from "./owned-live-chat.mjs";

let runtime, starting, closing;

async function close() {
  const deadline = globalThis.setTimeout(() => process.exit(1), OWNED_LIVE_CHAT_CLOSE_TIMEOUT_MS);
  try {
    await starting;
    await runtime?.close();
    globalThis.clearTimeout(deadline);
    process.exit(process.exitCode === 1 ? 1 : 0);
  } catch {
    process.exit(1);
  }
}

function shutdown() {
  if (closing) return;
  closing = true;
  void close();
}

function validStart(message) {
  return (
    message !== null &&
    typeof message === "object" &&
    Object.keys(message).length === 3 &&
    message.kind === "start" &&
    typeof message.nonce === "string" &&
    /^[0-9a-f-]{36}$/u.test(message.nonce) &&
    message.initialization !== null &&
    typeof message.initialization === "object"
  );
}

async function start(message) {
  if (!validStart(message) || process.env.KEIKO_OS_KEYCHAIN !== "off" || !process.connected)
    throw new TypeError("owned-lab-invalid-initialization");
  const { startOwnedLiveChatServer } = await import("./chat-read.mjs");
  if (closing || !process.connected) return;
  runtime = await startOwnedLiveChatServer(message.initialization, {
    onEvidenceFailure: () => {
      if (!process.connected) return shutdown();
      try {
        process.send(
          { kind: "failed", nonce: message.nonce, reason: "activity-log-unavailable" },
          (error) => {
            if (error) shutdown();
          },
        );
      } catch {
        shutdown();
      }
    },
  });
  if (process.exitCode === 1) throw new TypeError("owned-lab-evidence-unavailable");
  if (closing || !process.connected) return;
  process.send({ kind: "ready", nonce: message.nonce, port: runtime.port }, (error) => {
    if (error) shutdown();
  });
}

process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.once("message", (message) => {
  starting = start(message);
  void starting.catch(shutdown);
});
if (!process.connected) shutdown();
