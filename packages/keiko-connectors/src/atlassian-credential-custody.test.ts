// Issue #2241 — custody unit + redaction tests. Hermetic: fake ports for the behavioural matrix,
// plus keiko-security's REAL vault (temp-dir store, in-memory key) for the ciphertext-on-disk
// acceptance criterion. Secrets are synthetic and assembled at runtime by concatenation so no
// committed byte sequence resembles a live credential.

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAtlassianConnectorAuthRef } from "@oscharko-dev/keiko-contracts";
import { createLocalSecretVault } from "@oscharko-dev/keiko-security/secret-vault";
import {
  AtlassianCredentialCustodyError,
  atlassianAuthorizationHeaderValue,
  createAtlassianCredentialCustody,
  isAtlassianCredentialMetadata,
  type AtlassianCredentialMetadata,
  type AtlassianCredentialMetadataStore,
  type AtlassianCredentialVaultPort,
} from "./atlassian-credential-custody.js";

// Runtime-assembled synthetic secret material (never a committed literal token shape).
const SYNTHETIC_TOKEN = ["ATATT", "syn", "thetic", "0123456789", "abcdefghij", "KLMNOPQRST"].join(
  "",
);
const SYNTHETIC_EMAIL = ["custody-tester", "@", "example", ".", "com"].join("");

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "jira",
    displayName: "Team Jira",
    baseUrl: "https://acme.example",
    authScheme: "basic-api-token",
    accountEmail: SYNTHETIC_EMAIL,
    apiToken: SYNTHETIC_TOKEN,
    ...overrides,
  };
}

function inMemoryMetadataStore(): AtlassianCredentialMetadataStore & {
  readonly rows: Map<string, AtlassianCredentialMetadata>;
} {
  const rows = new Map<string, AtlassianCredentialMetadata>();
  return {
    rows,
    insert: (metadata): void => {
      rows.set(metadata.authRef, metadata);
    },
    get: (authRef): AtlassianCredentialMetadata | undefined => rows.get(authRef),
    list: (): readonly AtlassianCredentialMetadata[] => [...rows.values()],
    delete: (authRef): boolean => rows.delete(authRef),
  };
}

function inMemoryVault(): AtlassianCredentialVaultPort & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (reference): string | undefined => entries.get(reference),
    set: (reference, secret): void => {
      entries.set(reference, secret);
    },
    delete: (reference): void => {
      entries.delete(reference);
    },
  };
}

function custodyOverFakes(): {
  readonly custody: ReturnType<typeof createAtlassianCredentialCustody>["custody"];
  readonly executionResolver: ReturnType<
    typeof createAtlassianCredentialCustody
  >["executionResolver"];
  readonly vault: ReturnType<typeof inMemoryVault>;
  readonly metadataStore: ReturnType<typeof inMemoryMetadataStore>;
} {
  const vault = inMemoryVault();
  const metadataStore = inMemoryMetadataStore();
  const { custody, executionResolver } = createAtlassianCredentialCustody({
    vault,
    metadataStore,
    now: () => 1_700_000_000_000,
  });
  return { custody, executionResolver, vault, metadataStore };
}

function custodyErrorCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(AtlassianCredentialCustodyError);
    return (error as AtlassianCredentialCustodyError).code;
  }
  throw new Error("expected an AtlassianCredentialCustodyError");
}

// Serializes every reachable property of a thrown error (message, details, stack, cause chain)
// so the token-absence assertions cover the full diagnosable surface.
function describeThrown(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current !== undefined && current !== null) {
      if (current instanceof Error) {
        parts.push(current.name, current.message, current.stack ?? "");
        if (current instanceof AtlassianCredentialCustodyError) {
          parts.push(current.code, current.details.join("; "));
        }
        current = current.cause;
      } else {
        parts.push(JSON.stringify(current));
        current = undefined;
      }
    }
    return parts.join("\n");
  }
  throw new Error("expected the operation to throw");
}

describe("createAtlassianCredentialCustody — create", () => {
  it("mints a contract-shaped authRef, seals the secret, and returns metadata only", () => {
    const { custody, vault } = custodyOverFakes();
    const metadata = custody.create(createInput());
    expect(isAtlassianConnectorAuthRef(metadata.authRef)).toBe(true);
    expect(isAtlassianCredentialMetadata(metadata)).toBe(true);
    expect(metadata.provider).toBe("jira");
    expect(metadata.displayName).toBe("Team Jira");
    expect(metadata.baseUrl).toBe("https://acme.example");
    expect(metadata.authScheme).toBe("basic-api-token");
    expect(metadata.createdAt).toBe(1_700_000_000_000);
    expect(vault.entries.get(metadata.authRef)).toContain("basic-api-token");
    // Write-only surface: the returned metadata never carries the secret or the account email.
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(SYNTHETIC_TOKEN);
    expect(serialized).not.toContain(SYNTHETIC_EMAIL);
  });

  it("mints a distinct authRef per credential", () => {
    const { custody } = custodyOverFakes();
    const first = custody.create(createInput());
    const second = custody.create(createInput({ displayName: "Second Jira" }));
    expect(first.authRef).not.toBe(second.authRef);
  });

  it.each([
    ["non-object input", 42],
    ["missing provider", createInput({ provider: undefined })],
    ["unknown provider", createInput({ provider: "bitbucket" })],
    ["unsafe display name (URL marker)", createInput({ displayName: "see https://x" })],
    ["oversized display name", createInput({ displayName: "x".repeat(101) })],
    ["http base URL", createInput({ baseUrl: "http://acme.example" })],
    ["base URL with userinfo", createInput({ baseUrl: "https://user:pw@acme.example" })],
    ["base URL with query", createInput({ baseUrl: "https://acme.example?x=1" })],
    ["base URL with fragment", createInput({ baseUrl: "https://acme.example#x" })],
    ["oversized base URL", createInput({ baseUrl: `https://a.example/${"x".repeat(2048)}` })],
    ["email without @", createInput({ accountEmail: "not-an-email" })],
    ["email with whitespace", createInput({ accountEmail: "a b@example.com" })],
    ["oversized email", createInput({ accountEmail: `${"a".repeat(70)}@example.com` })],
    ["empty token", createInput({ apiToken: "" })],
    ["short token", createInput({ apiToken: "short" })],
    ["oversized token", createInput({ apiToken: "x".repeat(1025) })],
    ["token with CRLF (header injection)", createInput({ apiToken: "abcd1234\r\nX-Evil: 1" })],
    ["token with spaces", createInput({ apiToken: "abcd 1234 5678" })],
    ["non-string token", createInput({ apiToken: 12345678 })],
    ["unknown extra key", createInput({ tokenBackup: SYNTHETIC_TOKEN })],
    ["junk auth scheme", createInput({ authScheme: "oauth" })],
  ])("rejects %s with invalid-input and persists nothing", (_label, input) => {
    const { custody, vault, metadataStore } = custodyOverFakes();
    expect(
      custodyErrorCode(() => {
        custody.create(input);
      }),
    ).toBe("invalid-input");
    expect(vault.entries.size).toBe(0);
    expect(metadataStore.rows.size).toBe(0);
  });

  it("rejects the declared-but-unimplemented bearer-pat scheme with its own code", () => {
    const { custody, vault } = custodyOverFakes();
    expect(
      custodyErrorCode(() => {
        custody.create(createInput({ authScheme: "bearer-pat" }));
      }),
    ).toBe("unsupported-auth-scheme");
    expect(vault.entries.size).toBe(0);
  });

  it("never echoes submitted values (token, email) through validation errors", () => {
    const { custody } = custodyOverFakes();
    const thrown = describeThrown(() => {
      custody.create(createInput({ provider: "bitbucket" }));
    });
    expect(thrown).not.toContain(SYNTHETIC_TOKEN);
    expect(thrown).not.toContain(SYNTHETIC_EMAIL);
  });

  it("never echoes a hostile field NAME (a potential secret carrier) through validation errors", () => {
    const { custody } = custodyOverFakes();
    const thrown = describeThrown(() => {
      custody.create(createInput({ [SYNTHETIC_TOKEN]: true }));
    });
    expect(thrown).toContain("invalid-input");
    expect(thrown).not.toContain(SYNTHETIC_TOKEN);
  });

  it("wraps a vault write failure as vault-unavailable without inserting metadata or leaking the token", () => {
    const vault = inMemoryVault();
    const metadataStore = inMemoryMetadataStore();
    const failingVault: AtlassianCredentialVaultPort = {
      ...vault,
      set: (): void => {
        throw new Error("disk full");
      },
    };
    const { custody } = createAtlassianCredentialCustody({ vault: failingVault, metadataStore });
    const thrown = describeThrown(() => custody.create(createInput()));
    expect(thrown).toContain("vault-unavailable");
    expect(thrown).not.toContain(SYNTHETIC_TOKEN);
    expect(metadataStore.rows.size).toBe(0);
  });

  it("removes the sealed secret again when the metadata insert fails", () => {
    const vault = inMemoryVault();
    const metadataStore = inMemoryMetadataStore();
    const failingStore: AtlassianCredentialMetadataStore = {
      ...metadataStore,
      insert: (): void => {
        throw new Error("metadata store unavailable");
      },
    };
    const { custody } = createAtlassianCredentialCustody({ vault, metadataStore: failingStore });
    expect(() => custody.create(createInput())).toThrow("metadata store unavailable");
    expect(vault.entries.size).toBe(0);
  });
});

describe("createAtlassianCredentialCustody — list / getMetadata / delete", () => {
  it("lists metadata sorted by creation time and never the secret", () => {
    const { custody } = custodyOverFakes();
    custody.create(createInput());
    custody.create(createInput({ displayName: "Confluence Docs", provider: "confluence" }));
    const listed = custody.list();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(SYNTHETIC_TOKEN);
    expect(JSON.stringify(listed)).not.toContain(SYNTHETIC_EMAIL);
    expect(listed.every((entry) => isAtlassianCredentialMetadata(entry))).toBe(true);
  });

  it("getMetadata answers undefined for malformed and unknown refs", () => {
    const { custody } = custodyOverFakes();
    expect(custody.getMetadata("not-a-ref")).toBeUndefined();
    expect(custody.getMetadata(`atlassian-cred:${"A".repeat(22)}`)).toBeUndefined();
  });

  it("delete removes ciphertext and metadata; the authRef is invalidated", () => {
    const { custody, executionResolver, vault, metadataStore } = custodyOverFakes();
    const metadata = custody.create(createInput());
    expect(custody.delete(metadata.authRef)).toBe(true);
    expect(vault.entries.has(metadata.authRef)).toBe(false);
    expect(metadataStore.rows.has(metadata.authRef)).toBe(false);
    expect(custody.delete(metadata.authRef)).toBe(false);
    // Subsequent resolution fails closed with a content-free reason.
    const thrown = describeThrown(() => executionResolver.resolveForExecution(metadata.authRef));
    expect(thrown).toContain("credential-not-found");
    expect(thrown).not.toContain(SYNTHETIC_TOKEN);
  });

  it("delete fails closed (metadata retained) when the vault delete throws", () => {
    const vault = inMemoryVault();
    const metadataStore = inMemoryMetadataStore();
    const { custody } = createAtlassianCredentialCustody({ vault, metadataStore });
    const metadata = custody.create(createInput());
    const brokenVault: AtlassianCredentialVaultPort = {
      ...vault,
      delete: (): void => {
        throw new Error("vault locked");
      },
    };
    const { custody: broken } = createAtlassianCredentialCustody({
      vault: brokenVault,
      metadataStore,
    });
    expect(
      custodyErrorCode(() => {
        broken.delete(metadata.authRef);
      }),
    ).toBe("vault-unavailable");
    expect(metadataStore.rows.has(metadata.authRef)).toBe(true);
  });

  it("delete rejects malformed refs without touching the vault", () => {
    const { custody, vault } = custodyOverFakes();
    custody.create(createInput());
    expect(custody.delete("atlassian-cred:short")).toBe(false);
    expect(vault.entries.size).toBe(1);
  });
});

describe("createAtlassianCredentialCustody — resolveForExecution", () => {
  it("resolves the sealed credential for the execution path only", () => {
    const { custody, executionResolver } = custodyOverFakes();
    const metadata = custody.create(createInput());
    const resolved = executionResolver.resolveForExecution(metadata.authRef);
    expect(resolved.scheme).toBe("basic-api-token");
    expect(resolved.accountEmail).toBe(SYNTHETIC_EMAIL);
    expect(resolved.apiToken).toBe(SYNTHETIC_TOKEN);
  });

  it("fails closed on malformed refs, unknown refs, and metadata-without-ciphertext", () => {
    const { custody, executionResolver, vault } = custodyOverFakes();
    expect(custodyErrorCode(() => executionResolver.resolveForExecution("junk"))).toBe(
      "credential-not-found",
    );
    expect(
      custodyErrorCode(() =>
        executionResolver.resolveForExecution(`atlassian-cred:${"B".repeat(22)}`),
      ),
    ).toBe("credential-not-found");
    const metadata = custody.create(createInput());
    vault.entries.delete(metadata.authRef);
    expect(custodyErrorCode(() => executionResolver.resolveForExecution(metadata.authRef))).toBe(
      "credential-not-found",
    );
  });

  it("fails closed with credential-unreadable on a corrupt or mismatched envelope", () => {
    const { custody, executionResolver, vault } = custodyOverFakes();
    const metadata = custody.create(createInput());
    vault.entries.set(metadata.authRef, "not json");
    expect(custodyErrorCode(() => executionResolver.resolveForExecution(metadata.authRef))).toBe(
      "credential-unreadable",
    );
    vault.entries.set(metadata.authRef, JSON.stringify({ schemaVersion: "1", scheme: "other" }));
    expect(custodyErrorCode(() => executionResolver.resolveForExecution(metadata.authRef))).toBe(
      "credential-unreadable",
    );
  });
});

describe("atlassianAuthorizationHeaderValue", () => {
  it("builds the Basic header from email:token", () => {
    const value = atlassianAuthorizationHeaderValue({
      scheme: "basic-api-token",
      accountEmail: SYNTHETIC_EMAIL,
      apiToken: SYNTHETIC_TOKEN,
    });
    const decoded = Buffer.from(value.replace("Basic ", ""), "base64").toString("utf8");
    expect(value.startsWith("Basic ")).toBe(true);
    expect(decoded).toBe(`${SYNTHETIC_EMAIL}:${SYNTHETIC_TOKEN}`);
  });
});

describe("ciphertext on disk — real keiko-security vault", () => {
  let tempDir: string;

  beforeEach(() => {
    // realpath: on macOS tmpdir() lives under the /var -> /private/var symlink, which the vault's
    // symlink-refusing write path correctly rejects.
    tempDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-atlassian-custody-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists no token or email plaintext in the vault store bytes", () => {
    const storePath = join(tempDir, "atlassian-connector-credentials.vault");
    const vault = createLocalSecretVault({ key: randomBytes(32), storePath });
    const metadataStore = inMemoryMetadataStore();
    const { custody, executionResolver } = createAtlassianCredentialCustody({
      vault,
      metadataStore,
    });

    const metadata = custody.create(createInput());
    const persistedBytes = readFileSync(storePath, "utf8");
    expect(persistedBytes).not.toContain(SYNTHETIC_TOKEN);
    expect(persistedBytes).not.toContain(SYNTHETIC_EMAIL);
    expect(persistedBytes).toContain(metadata.authRef);

    // The sealed entry round-trips through the execution resolver only.
    const resolved = executionResolver.resolveForExecution(metadata.authRef);
    expect(resolved.apiToken).toBe(SYNTHETIC_TOKEN);

    // Deletion removes the ciphertext from disk (empty vault stores are removed entirely).
    custody.delete(metadata.authRef);
    expect(vault.get(metadata.authRef)).toBeUndefined();
  });
});
