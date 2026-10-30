import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  McpRemoteOAuth,
  McpServerDefinition,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { createLocalSecretVault } from "@oscharko-dev/keiko-security/secret-vault";
import {
  createMcpOAuthCredentialStore,
  createMcpServerSecretStore,
  mcpOAuthCredentialReference,
} from "./mcpOAuthCredentialStore.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BINDING = {
  server: "issues",
  url: "https://issues.example.test/mcp",
  oauth: { issuer: "https://login.example.test/tenant" },
} as const;
const CREDENTIAL = {
  integrationId: "mcp_52c0335c7b3cc683",
  value: {
    type: "oauth",
    access: "access-token-canary",
    refresh: "refresh-token-canary",
  },
};

function store(stateDir: string): ReturnType<typeof createMcpOAuthCredentialStore> {
  return createMcpOAuthCredentialStore({
    stateDir,
    env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomKey },
    keychainAccess: () => undefined,
  });
}
const randomKey = randomBytes(32).toString("base64");

describe("keeping an MCP server's OAuth credential between runs (#3903 AC3)", () => {
  it("seals the credential and reads it back for the same binding only", () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-vault-")));
    roots.push(stateDir);
    const credentials = store(stateDir);
    expect(credentials.load(BINDING)).toBeUndefined();
    credentials.save(BINDING, CREDENTIAL);
    expect(store(stateDir).load(BINDING)).toEqual(CREDENTIAL);
    for (const changed of [
      { ...BINDING, url: "https://other.example.test/mcp" },
      { ...BINDING, oauth: { issuer: "https://evil.example.test" } },
      { ...BINDING, oauth: { ...BINDING.oauth, clientId: "keiko" } },
      { ...BINDING, oauth: { ...BINDING.oauth, scope: "restricted.read" } },
      { ...BINDING, server: "tracker" },
    ])
      expect(credentials.load(changed)).toBeUndefined();
    const files = readdirSync(join(stateDir, "credentials"));
    const sealed = files.map((file) => readFileSync(join(stateDir, "credentials", file), "utf8"));
    expect(sealed.join("")).not.toContain("token-canary");
    expect(sealed.join("")).not.toContain("issues.example.test");
  });

  it("names a binding by a digest, never by its URL or issuer", () => {
    const reference = mcpOAuthCredentialReference(BINDING);
    expect(reference).toMatch(/^mcp-oauth:[0-9a-f]{64}$/u);
  });

  it("opens no vault until a credential is read or kept", () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-vault-")));
    roots.push(stateDir);
    store(stateDir);
    expect(readdirSync(stateDir)).toEqual([]);
  });
});

// Captured from the previous whole-object serialization, independently of the current projector.
const LEGACY_PUBLIC_BINDINGS = [
  [undefined, "ba8c746322021ffacef431195d69349d0b9122250b2ce5ba64289e088d033828"],
  [
    { issuer: "https://login.example.test/tenant" },
    "d57a66906c40d6c36d40ad0c8004a82aae1cdcb919e289db65cd2d6075e94ccf",
  ],
  [
    { issuer: "https://login.example.test/tenant", clientId: "public-keiko" },
    "2e13d93fa2cda0127d17bd73b97c5c39c5bea9288bcc217a6eed0d9747b1954e",
  ],
  [
    { clientId: "public-keiko", issuer: "https://login.example.test/tenant" },
    "3c58f9ebec4994bc2b2adaa847f4197955e32fdf605ab43be59ae6bfa53ca20b",
  ],
  [
    { issuer: "https://login.example.test/tenant", scope: "read write" },
    "51530d29313d224b0ce9479189c56aab1e5a87bf4441f70e107df8627cb51c89",
  ],
  [
    { scope: "read write", issuer: "https://login.example.test/tenant" },
    "1ffc34ea8a6ad4989f2bab3ff6d67c0dc46c41e70fe6fcc39f77726da2e7c1ae",
  ],
  [
    {
      issuer: "https://login.example.test/tenant",
      clientId: "public-keiko",
      scope: "read write",
    },
    "69138ff45375cbc1c98f48f6d707611fa01ec5252a9c3cc6d1be0158c13a941f",
  ],
  [
    {
      scope: "read write",
      clientId: "public-keiko",
      issuer: "https://login.example.test/tenant",
    },
    "254141b17b6c1a75ac2fcb3d94221e038050d19b816132d28470c4c826723cd6",
  ],
] as const satisfies readonly (readonly [McpRemoteOAuth | undefined, string])[];

function staticFixture(metadata: McpRemoteOAuth | undefined): {
  readonly input: Parameters<typeof createMcpServerSecretStore>[0];
  readonly server: McpServerDefinition & {
    readonly transport: { readonly kind: "remote" };
  };
  readonly vault: ReturnType<typeof createLocalSecretVault>;
  readonly vaultPath: string;
  readonly events: readonly SecurityLogEvent[];
} {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-static-vault-")));
  roots.push(stateDir);
  const events: SecurityLogEvent[] = [];
  const input = {
    stateDir,
    env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomKey },
    keychainAccess: (): undefined => undefined,
    securityLogSink: {
      write: (event: SecurityLogEvent): void => {
        events.push(event);
      },
    },
  };
  const server = {
    name: BINDING.server,
    description: undefined,
    enabled: true,
    transport: {
      kind: "remote" as const,
      url: BINDING.url,
      ...(metadata === undefined ? {} : { oauth: metadata }),
    },
    tools: {},
  } satisfies McpServerDefinition;
  const vaultPath = join(stateDir, "credentials", "mcp-oauth-credentials.vault");
  const vault = createLocalSecretVault({
    key: Buffer.from(randomKey, "base64"),
    storePath: vaultPath,
  });
  return { input, server, vault, vaultPath, events };
}

const STATIC_REFERENCE = "KEIKO_MCP_SECRET_LEGACY";
const STATIC_VALUE = "synthetic-static-token-canary";

describe("public target metadata preserves existing sealed MCP bindings (#4081)", () => {
  it.each(LEGACY_PUBLIC_BINDINGS)(
    "reopens and writes the legacy binding byte-for-byte (%#)",
    (metadata, binding) => {
      const f = staticFixture(metadata);
      const encoded = JSON.stringify({ binding, value: STATIC_VALUE });
      f.vault.set(`mcp-static:${STATIC_REFERENCE}`, encoded);
      const oldBytes = readFileSync(f.vaultPath);
      const credentials = createMcpServerSecretStore(f.input);
      expect(credentials.get(STATIC_REFERENCE, f.server)).toBe(STATIC_VALUE);
      credentials.put([{ reference: STATIC_REFERENCE, server: f.server, value: STATIC_VALUE }]);
      expect(readFileSync(f.vaultPath)).toEqual(oldBytes);
      const freshReference = `${STATIC_REFERENCE}_NEW`;
      credentials.put([{ reference: freshReference, server: f.server, value: STATIC_VALUE }]);
      expect(f.vault.get(`mcp-static:${freshReference}`)).toBe(encoded);
      expect(createMcpServerSecretStore(f.input).get(freshReference, f.server)).toBe(STATIC_VALUE);
      expect(readFileSync(f.vaultPath, "utf8")).not.toContain(STATIC_VALUE);
      expect(JSON.stringify(f.events)).not.toContain(STATIC_VALUE);
      expect(JSON.stringify(f.events)).not.toContain(BINDING.url);
    },
  );

  it("does not carry a stored secret across changes to any public authorization binding", () => {
    const metadata = {
      issuer: BINDING.oauth.issuer,
      clientId: "public-keiko",
      scope: "read write",
    };
    const f = staticFixture(metadata);
    const credentials = createMcpServerSecretStore(f.input);
    credentials.put([{ reference: STATIC_REFERENCE, server: f.server, value: STATIC_VALUE }]);
    const changedTargets: McpServerDefinition[] = [
      { ...f.server, name: "other-server" },
      {
        ...f.server,
        transport: {
          ...f.server.transport,
          url: "https://other.example.test/mcp",
        },
      },
      ...[
        { ...metadata, issuer: "https://other.example.test/tenant" },
        { ...metadata, clientId: "other-public-client" },
        { ...metadata, scope: "read" },
        { issuer: metadata.issuer, scope: metadata.scope },
        { issuer: metadata.issuer, clientId: metadata.clientId },
      ].map((oauth) => ({
        ...f.server,
        transport: { ...f.server.transport, oauth },
      })),
    ];
    for (const changed of changedTargets) {
      expect(credentials.get(STATIC_REFERENCE, changed)).toBeUndefined();
      expect(() => {
        credentials.put([{ reference: STATIC_REFERENCE, server: changed, value: STATIC_VALUE }]);
      }).toThrow("MCP secret references are immutable");
    }
    expect(credentials.get(STATIC_REFERENCE, f.server)).toBe(STATIC_VALUE);
  });
});
