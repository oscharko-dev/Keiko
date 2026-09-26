import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { probePortFree } from "../lib/port-probe.mjs";

// The probePortFree helper is the single bind-and-close probe shared by dev:start and dev:stop.
// A bug here silently unbraces both entry points (a `false` when the port is free would spin
// dev:start forever, a `true` while the port is still bound would falsely claim dev:stop cleanly
// finished). The two branches — bind succeeds vs. bind rejects with EADDRINUSE — are covered
// directly against the real Node network stack, without a mock, because that is exactly the
// interface both callers rely on.
function pickBoundPort() {
  return new Promise((resolveWithPort, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPromise(new Error("could not obtain a bound loopback port"));
        return;
      }
      resolveWithPort({ port: address.port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

describe("probePortFree", () => {
  it("returns true for a released loopback port with the default host", async () => {
    const bound = await pickBoundPort();
    const port = bound.port;
    await bound.close();
    await expect(probePortFree(port)).resolves.toBe(true);
  });

  it("returns false while the loopback port is still bound", async () => {
    const bound = await pickBoundPort();
    try {
      await expect(probePortFree(bound.port)).resolves.toBe(false);
    } finally {
      await bound.close();
    }
  });

  it("honours an explicit loopback host argument on the same probe", async () => {
    const bound = await pickBoundPort();
    try {
      await expect(probePortFree(bound.port, "127.0.0.1")).resolves.toBe(false);
    } finally {
      await bound.close();
    }
    await expect(probePortFree(bound.port, "127.0.0.1")).resolves.toBe(true);
  });
});
