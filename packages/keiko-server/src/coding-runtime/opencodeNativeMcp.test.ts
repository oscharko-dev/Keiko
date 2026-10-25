import { describe, expect, it } from "vitest";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";

import type { McpOAuthIssuerValidation } from "../mcp/mcpOAuthIssuer.js";
import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import {
  OPENCODE_NATIVE_MCP_PATH,
  mcpServersNeedingIssuerValidation,
  openCodeNativeMcpAdmission,
} from "./opencodeNativeMcp.js";

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
const ISSUER = "https://login.example.test/tenant";
const OAUTH_REMOTE: McpServerDefinition = {
  ...REMOTE,
  name: "issues",
  transport: {
    kind: "remote",
    url: "https://issues.example.test/mcp",
    oauth: { issuer: ISSUER, clientId: "keiko", scope: "issues.read" },
  },
};
const VALIDATED = {
  ok: true,
  metadataUrl: "https://login.example.test/.well-known/oauth-authorization-server/tenant",
  authorizationEndpoint: "https://login.example.test/tenant/authorize",
} as const;

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

  // #3903 AC3: a server with an operator-named issuer is admitted only once that issuer validated,
  // and the runtime reads exactly the validated metadata document.
  it("pins a validated issuer's metadata document and the operator's public client", () => {
    const admission = openCodeNativeMcpAdmission({
      servers: [REMOTE, OAUTH_REMOTE],
      mode: "autonomous-delivery",
      home: HOME,
      validations: new Map([["issues", VALIDATED]]),
    });
    expect(admission.config.servers.issues).toEqual({
      type: "remote",
      url: "https://issues.example.test/mcp",
      oauth: {
        auth_server_metadata_url: VALIDATED.metadataUrl,
        client_id: "keiko",
        scope: "issues.read",
      },
    });
    expect(admission.config.servers.tracker).toMatchObject({ oauth: false });
    expect(admission.oauth).toEqual(
      new Map([
        [
          "issues",
          {
            url: "https://issues.example.test/mcp",
            oauth: { issuer: ISSUER, clientId: "keiko", scope: "issues.read" },
            metadataUrl: VALIDATED.metadataUrl,
            authorizationEndpoint: VALIDATED.authorizationEndpoint,
          },
        ],
      ]),
    );
  });

  it.each([
    [
      "an issuer that did not validate",
      new Map<string, McpOAuthIssuerValidation>([
        ["issues", { ok: false, reason: "issuer-mismatch" }],
      ]),
    ],
    ["no validation at all", undefined],
  ] as const)("leaves out a server with OAuth for %s, and its tools", (_label, validations) => {
    const admission = openCodeNativeMcpAdmission({
      servers: [OAUTH_REMOTE],
      mode: "autonomous-delivery",
      home: HOME,
      ...(validations === undefined ? {} : { validations }),
    });
    expect(admission.config).toEqual({ servers: {} });
    expect(admission.grants.actions.size).toBe(0);
    expect(admission.oauth.size).toBe(0);
  });

  it("validates only the enabled remote servers with OAuth a Full access run would use", () => {
    const servers = [LOCAL, REMOTE, OAUTH_REMOTE, { ...OAUTH_REMOTE, name: "off", enabled: false }];
    expect(
      mcpServersNeedingIssuerValidation(servers, "autonomous-delivery").map(({ name }) => name),
    ).toEqual(["issues"]);
    expect(mcpServersNeedingIssuerValidation(servers, "supervised-coding")).toEqual([]);
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
