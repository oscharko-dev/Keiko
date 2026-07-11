// Issue #2241 — private-JSON metadata store tests. Hermetic: every store lives in a fresh temp
// config dir. The store must fail CLOSED on corrupt or tampered content (never treating an
// unreadable store as empty) and must persist only the non-secret metadata projection.

import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import {
  AtlassianCredentialMetadataStoreError,
  atlassianCredentialMetadataPath,
  createAtlassianCredentialMetadataStore,
} from "./credentialMetadataStore.js";

const AUTH_REF_A = `atlassian-cred:${"Aa1-_".repeat(4)}Zz`;
const AUTH_REF_B = `atlassian-cred:${"Bb2-_".repeat(4)}Yy`;

function metadata(authRef: string): AtlassianCredentialMetadata {
  return {
    schemaVersion: "1",
    authRef,
    provider: "jira",
    displayName: "Team Jira",
    baseUrl: "https://acme.example",
    authScheme: "basic-api-token",
    createdAt: 1_700_000_000_000,
  };
}

let tempDir: string;
let configPath: string;

beforeEach(() => {
  // realpath: on macOS tmpdir() lives under the /var -> /private/var symlink, which the private
  // JSON writer's symlink-refusing path check correctly rejects.
  tempDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-atlassian-metadata-"));
  configPath = join(tempDir, "keiko.config.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createAtlassianCredentialMetadataStore", () => {
  it("round-trips insert / get / list / delete", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    expect(store.list()).toEqual([]);
    expect(store.get(AUTH_REF_A)).toBeUndefined();

    store.insert(metadata(AUTH_REF_A));
    store.insert(metadata(AUTH_REF_B));
    expect(store.get(AUTH_REF_A)?.displayName).toBe("Team Jira");
    expect(store.list()).toHaveLength(2);

    expect(store.delete(AUTH_REF_A)).toBe(true);
    expect(store.delete(AUTH_REF_A)).toBe(false);
    expect(store.get(AUTH_REF_A)).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("persists under <config-dir>/credentials/ with private file mode", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    store.insert(metadata(AUTH_REF_A));
    const storePath = atlassianCredentialMetadataPath(configPath);
    expect(storePath).toBe(
      join(tempDir, "credentials", "atlassian-connector-credentials.metadata.json"),
    );
    const persisted = JSON.parse(readFileSync(storePath, "utf8")) as { version: number };
    expect(persisted.version).toBe(1);
    if (process.platform !== "win32") {
      expect(statSync(storePath).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on invalid JSON instead of treating the store as empty", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    store.insert(metadata(AUTH_REF_A));
    writeFileSync(atlassianCredentialMetadataPath(configPath), "{not json");
    expect(() => store.list()).toThrow(AtlassianCredentialMetadataStoreError);
    expect(() => store.get(AUTH_REF_A)).toThrow(AtlassianCredentialMetadataStoreError);
    expect(() => store.delete(AUTH_REF_A)).toThrow(AtlassianCredentialMetadataStoreError);
  });

  it("fails closed on a tampered entry (schema violation or key mismatch)", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    store.insert(metadata(AUTH_REF_A));
    const storePath = atlassianCredentialMetadataPath(configPath);

    // Entry keyed under a different authRef than it carries — a swapped/tampered row.
    const mismatched = { version: 1, credentials: { [AUTH_REF_B]: metadata(AUTH_REF_A) } };
    writeFileSync(storePath, JSON.stringify(mismatched));
    expect(() => store.list()).toThrow(AtlassianCredentialMetadataStoreError);

    // Entry smuggling an unexpected field (potential secret carrier) is rejected.
    const extraField = {
      version: 1,
      credentials: { [AUTH_REF_A]: { ...metadata(AUTH_REF_A), apiToken: "x".repeat(24) } },
    };
    writeFileSync(storePath, JSON.stringify(extraField));
    expect(() => store.list()).toThrow(AtlassianCredentialMetadataStoreError);
  });

  it("fails closed on an unsupported store version", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    store.insert(metadata(AUTH_REF_A));
    writeFileSync(
      atlassianCredentialMetadataPath(configPath),
      JSON.stringify({ version: 2, credentials: {} }),
    );
    expect(() => store.list()).toThrow(AtlassianCredentialMetadataStoreError);
  });

  it("treats a missing file as empty (first run)", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    expect(store.list()).toEqual([]);
    expect(store.delete(AUTH_REF_A)).toBe(false);
  });
});
