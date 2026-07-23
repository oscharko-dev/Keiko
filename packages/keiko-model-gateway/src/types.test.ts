import { describe, expect, it } from "vitest";

import type { OutboundHttpEgressConfig } from "./types.js";

describe("OutboundHttpEgressConfig", () => {
  it("retains the proxy and CA fields used by governed research", () => {
    const config: OutboundHttpEgressConfig = {
      httpsProxy: "https://proxy.example",
      httpProxy: "http://proxy.example",
      noProxy: ["docs.example.org"],
      caBundlePath: "/etc/keiko/ca.pem",
    };

    expect(Object.keys(config).sort()).toEqual([
      "caBundlePath",
      "httpProxy",
      "httpsProxy",
      "noProxy",
    ]);
  });
});
