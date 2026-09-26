// Shared bind-and-close port probe. Used by both `dev:start` (to decide whether a candidate port
// is free before it claims one) and `dev:stop` (to verify that every tracked listening port has
// been released before reporting a clean stop). Kept in `scripts/lib/` so a bug in the probe is
// fixed in one place — before this module the two entry-points carried near-verbatim copies.
import { createServer } from "node:net";

export function probePortFree(port, host = "127.0.0.1") {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, host, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}
