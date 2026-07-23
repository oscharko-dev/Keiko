import { clearTimeout, setTimeout } from "node:timers";

/**
 * Stops the dev BFF without letting long-lived SSE connections pin the Node watch child.
 * Product runtime disposal still runs and remains bounded; the boolean is safe to log.
 */
export async function shutdownDevBff({ server, dispose, timeoutMs }) {
  let serverClosed = false;
  let runtimeDisposed = false;
  const closeServer = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else {
        serverClosed = true;
        resolve();
      }
    });
    server.closeAllConnections();
  });
  const disposeRuntime = Promise.resolve()
    .then(dispose)
    .then(() => {
      runtimeDisposed = true;
    });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });
  try {
    const settled = await Promise.race([
      Promise.allSettled([closeServer, disposeRuntime]),
      timeout,
    ]);
    return {
      ok: settled !== "timeout" && settled.every((result) => result.status === "fulfilled"),
      serverClosed,
      runtimeDisposed,
    };
  } finally {
    clearTimeout(timer);
  }
}
