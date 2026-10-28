import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  createLocalSecretVault,
  resolveLocalVaultKey,
  type LocalSecretVault,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { McpRemoteOAuth } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";

/**
 * Where an MCP server's OAuth credential lives between runs (#3903 AC3): sealed with AES-256-GCM in
 * Keiko's own secret vault under the state directory, keyed through the same env, keychain and
 * keyfile tiers as the provider credentials, and never in a run's private state once the run ends.
 * A credential is bound to the server's name, URL, expected issuer and client: a registry change of
 * any of them makes a stored one unreachable, so the human authorizes again rather than reusing a
 * credential for a server it was not issued for. The vault opens on first use only.
 */
const VAULT_DIRECTORY = "credentials";
const VAULT_FILE = "mcp-oauth-credentials.vault";
const VAULT_KEYFILE = "mcp-oauth-credentials-vault.key";
const VAULT_KEY_ENV = "KEIKO_MCP_OAUTH_CREDENTIALS_KEY";
const VAULT_KEYCHAIN_SERVICE = "keiko-mcp-oauth-credentials-vault";

export interface McpOAuthCredentialBinding {
  readonly server: string;
  readonly url: string;
  readonly oauth: McpRemoteOAuth;
}

/** What the runtime needs to use a credential again: its integration and its own value. */
export interface StoredMcpOAuthCredential {
  readonly integrationId: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface McpOAuthCredentialStore {
  readonly load: (binding: McpOAuthCredentialBinding) => StoredMcpOAuthCredential | undefined;
  readonly save: (binding: McpOAuthCredentialBinding, credential: StoredMcpOAuthCredential) => void;
}

/** The vault reference: a digest of the binding, never a URL or an issuer in the clear. */
export function mcpOAuthCredentialReference(binding: McpOAuthCredentialBinding): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        binding.server,
        binding.url,
        binding.oauth.issuer,
        binding.oauth.clientId ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
  return `mcp-oauth:${digest}`;
}

export interface McpOAuthCredentialStoreInput {
  readonly stateDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export function createMcpOAuthCredentialStore(
  input: McpOAuthCredentialStoreInput,
): McpOAuthCredentialStore {
  let vault: LocalSecretVault | undefined;
  const opened = (): LocalSecretVault => (vault ??= openVault(input));
  return {
    load: (binding) => storedCredential(opened().get(mcpOAuthCredentialReference(binding))),
    save: (binding, credential): void => {
      opened().set(mcpOAuthCredentialReference(binding), JSON.stringify(credential));
    },
  };
}

function openVault(input: McpOAuthCredentialStoreInput): LocalSecretVault {
  const vaultDir = join(input.stateDir, VAULT_DIRECTORY);
  const { key } = resolveLocalVaultKey({
    env: input.env,
    vaultDir,
    envVarName: VAULT_KEY_ENV,
    keychainService: VAULT_KEYCHAIN_SERVICE,
    keyfileName: VAULT_KEYFILE,
    ...(input.keychainAccess === undefined ? {} : { keychainAccess: input.keychainAccess }),
    sink: input.securityLogSink,
  });
  return createLocalSecretVault({
    key,
    storePath: join(vaultDir, VAULT_FILE),
    ...(input.securityLogSink === undefined ? {} : { sink: input.securityLogSink }),
  });
}

function staticCredentialBinding(server: McpServerDefinition): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        server.name,
        server.transport.kind === "remote"
          ? ["remote", server.transport.url, server.transport.oauth ?? null]
          : ["local", server.transport.command, server.transport.environment],
      ]),
    )
    .digest("hex");
}

function staticCredentialValue(text: string, server: McpServerDefinition): string | undefined {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("binding" in value) ||
    !("value" in value) ||
    value.binding !== staticCredentialBinding(server) ||
    typeof value.value !== "string"
  )
    return undefined;
  return value.value;
}

/** Static credentials share the MCP vault, with immutable references bound to one exact target. */
export function createMcpServerSecretStore(input: McpOAuthCredentialStoreInput): {
  readonly get: (reference: string, server: McpServerDefinition) => string | undefined;
  readonly retain: (references: readonly string[]) => void;
  readonly put: (
    entries: readonly {
      readonly reference: string;
      readonly server: McpServerDefinition;
      readonly value: string;
    }[],
  ) => void;
} {
  const key = (reference: string): string => `mcp-static:${reference}`;
  return {
    retain: (references): void => {
      const vault = openVault(input);
      const retained = new Set(references.map(key));
      vault.deleteMany(
        vault
          .list()
          .filter((reference) => reference.startsWith("mcp-static:") && !retained.has(reference)),
      );
    },
    get: (reference, server): string | undefined => {
      const text = openVault(input).get(key(reference));
      if (text === undefined) return input.env[reference];
      return staticCredentialValue(text, server);
    },
    put: (entries): void => {
      if (entries.length === 0) return;
      const vault = openVault(input);
      const captured = new Map<string, string>();
      for (const entry of entries) {
        const reference = key(entry.reference);
        if (vault.get(reference) !== undefined || captured.has(reference))
          throw new TypeError("MCP secret references are immutable");
        captured.set(
          reference,
          JSON.stringify({ binding: staticCredentialBinding(entry.server), value: entry.value }),
        );
      }
      vault.setMany(captured);
    },
  };
}

// A sealed entry that does not read back as this shape is not a credential Keiko wrote.
function storedCredential(text: string | undefined): StoredMcpOAuthCredential | undefined {
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return undefined;
  const { integrationId, value: credential } = value as Readonly<Record<string, unknown>>;
  return typeof integrationId === "string" &&
    typeof credential === "object" &&
    credential !== null &&
    !Array.isArray(credential)
    ? { integrationId, value: credential as Readonly<Record<string, unknown>> }
    : undefined;
}
