import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { resolveOutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway";
import { gatewayFetch } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { describe, expect, it } from "vitest";

import { devServerEnv, HERMETIC_DEAD_PROXY } from "./support/dev-server-env.js";

// Smoke journeys failed on an unrelated click whenever a Keiko release newer than the checkout
// existed: the server's startup update preflight read the public npm registry, and the update
// notice then covered controls (`update-notice ... intercepts pointer events`, chat-send, a11y,
// atlassian-connectors-2246 and others in three to four runs each). The smoke server's outbound
// traffic is hermetic now. This proves it through the gateway's own egress resolution and fetch,
// the path the update preflight uses, with a reachable loopback positive control.
const env = devServerEnv({
  publicPort: 1,
  bffPort: 2,
  nextPort: 3,
  stateDir: "/state",
  runtimeConfigPath: "/state/keiko.e2e.config.json",
});
const egress = resolveOutboundHttpEgressConfig(undefined, env);
const REGISTRY_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/%40oscharko-dev%2Fkeiko/dist-tags";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return (server.address() as AddressInfo).port;
}

describe("the smoke dev server's outbound traffic", () => {
  it("routes every non-loopback request to a closed loopback proxy", () => {
    expect(egress).toMatchObject({
      httpProxy: `${HERMETIC_DEAD_PROXY}/`,
      httpsProxy: `${HERMETIC_DEAD_PROXY}/`,
      noProxy: ["127.0.0.1", "localhost", "::1"],
    });
  });

  it("cannot reach the public npm registry the update preflight reads", async () => {
    await expect(
      gatewayFetch(REGISTRY_DIST_TAGS_URL, { method: "GET", egress, timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });

  it("still reaches a loopback server directly", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    try {
      const port = await listen(server);
      const response = await gatewayFetch(`http://127.0.0.1:${String(port)}/healthz`, {
        method: "GET",
        egress,
        timeoutMs: 5_000,
      });
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    }
  });
});
