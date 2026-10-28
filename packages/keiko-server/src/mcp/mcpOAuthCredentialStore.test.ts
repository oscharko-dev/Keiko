import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpOAuthCredentialStore,
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
  value: { type: "oauth", access: "access-token-canary", refresh: "refresh-token-canary" },
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
