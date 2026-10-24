import { describe, expect, it } from "vitest";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";

import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import { OPENCODE_NATIVE_MCP_PATH, openCodeNativeMcpAdmission } from "./opencodeNativeMcp.js";

const LOCAL: McpServerDefinition = {
  name: "docs",
  description: undefined,
  enabled: true,
  transport: {
    kind: "local",
    command: ["/opt/tools/docs-mcp", "--stdio"],
    environment: { DOCS_INDEX: "/srv/docs" },
  },
  tools: { search: "read" },
};
const REMOTE: McpServerDefinition = {
  name: "tracker",
  description: undefined,
  enabled: true,
  transport: { kind: "remote", url: "https://tracker.example.test/mcp" },
  tools: { find: "read" },
};
const HOME = "/private/state/run-1/home";

describe("the MCP servers a native run admits (#3903)", () => {
  it("starts a local server from an empty environment with only its literal variables", () => {
    const { config } = openCodeNativeMcpAdmission({
      servers: [LOCAL],
      mode: "supervised-coding",
      home: HOME,
    });
    expect(config).toEqual({
      servers: {
        docs: {
          type: "local",
          command: [
            "/usr/bin/env",
            "-i",
            `PATH=${OPENCODE_NATIVE_MCP_PATH}`,
            `HOME=${HOME}`,
            "DOCS_INDEX=/srv/docs",
            "/opt/tools/docs-mcp",
            "--stdio",
          ],
        },
      },
    });
  });

  it("writes a remote server only for Full access, with OAuth off", () => {
    const below = openCodeNativeMcpAdmission({
      servers: [REMOTE],
      mode: "supervised-coding",
      home: HOME,
    });
    expect(below.config).toEqual({ servers: {} });
    expect(below.grants.actions.size).toBe(0);
    const full = openCodeNativeMcpAdmission({
      servers: [REMOTE],
      mode: "autonomous-delivery",
      home: HOME,
    });
    expect(full.config.servers.tracker).toEqual({
      type: "remote",
      url: "https://tracker.example.test/mcp",
      oauth: false,
    });
    expect(full.grants.servers.get("tracker")).toEqual({ remote: true });
  });

  it("admits nothing of a disabled server", () => {
    const { config, grants } = openCodeNativeMcpAdmission({
      servers: [{ ...LOCAL, enabled: false }],
      mode: "autonomous-delivery",
      home: HOME,
    });
    expect(config).toEqual({ servers: {} });
    expect(grants.actions.size).toBe(0);
  });

  it("puts the MCP servers on the server-owned binding, an empty set when there are none", () => {
    const geometry = {
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      contextWindowTokens: 131_072,
    };
    const owned = (mcp?: { readonly servers: Readonly<Record<string, unknown>> }): unknown => {
      const profile = buildOpenCodeLaunchProfile({
        toolProfile: "native",
        executable: "/opt/opencode",
        stateRoot: "/private/state/run-1",
        contextGeometry: geometry,
        mode: "supervised-coding",
        ...(mcp === undefined ? {} : { mcp }),
      });
      if (!profile.ok) throw new Error("expected a profile");
      return (JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? "{}") as { mcp: unknown }).mcp;
    };
    expect(owned()).toEqual({ servers: {} });
    const { config } = openCodeNativeMcpAdmission({
      servers: [LOCAL],
      mode: "supervised-coding",
      home: HOME,
    });
    expect(owned(config)).toEqual(config);
  });
});
