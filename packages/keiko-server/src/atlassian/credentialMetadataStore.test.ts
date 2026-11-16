// Issue #2241 — private-JSON metadata store tests. Hermetic: every store lives in a fresh temp
// config dir. The store must fail CLOSED on corrupt or tampered content (never treating an
// unreadable store as empty) and must persist only the non-secret metadata projection.

import { nullSecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import {
  inspectWindowsOwnerPrivateFiles,
  windowsOwnerPrivateVerdict,
} from "@oscharko-dev/keiko-security/windows-owner-private";
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

function dataCenter(authRef = AUTH_REF_A): AtlassianCredentialMetadata {
  return {
    schemaVersion: "1",
    authRef,
    provider: "jira",
    deployment: "data-center",
    generation: 1,
    displayName: "Team Jira",
    baseUrl: "https://jira.example:8443/context",
    authScheme: "bearer-pat",
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

// Issue #4358 names the two file-mode assertions of this suite, which were skipped on win32, and
// asks for their Windows equivalent; the store itself is unchanged.
// POSIX proves privacy with the file mode. Windows has no mode bits worth trusting, so the same
// claim is proven there from the file's own security descriptor, bound to an open descriptor, under
// the confidentiality policy: nobody but the user, SYSTEM and Administrators holds any access
// (#4358, ADR-0182 D5).
function expectPrivateToOwner(path: string): void {
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    return;
  }
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd, { bigint: true });
    const inspection = inspectWindowsOwnerPrivateFiles([path], {
      securityLogSink: nullSecurityLogSink(),
    });
    const [facts] = inspection.files;
    expect(facts?.kind).toBe("facts");
    if (facts === undefined) return;
    const opened = { dev: stat.dev, ino: stat.ino };
    expect(windowsOwnerPrivateVerdict(facts, inspection.principal, opened, "none")).toEqual({
      kind: "owner-private",
    });
  } finally {
    closeSync(fd);
  }
}

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
    expectPrivateToOwner(storePath);
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

describe("private Data Center target admissions", () => {
  it("adds an admission to a version-1 store and retains it across restart and credential updates", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const original = dataCenter();
    store.insert(original);
    expect(store.getTargetAdmission(original)).toBeUndefined();
    const admission = { baseUrl: original.baseUrl, addressClass: "private" as const };
    expect(store.bindTargetAdmission(original, admission)).toEqual(admission);

    const restarted = createAtlassianCredentialMetadataStore({ configPath });
    expect(restarted.getTargetAdmission(original)).toEqual(admission);
    const updated = { ...original, generation: 2, displayName: "Renamed Jira" };
    restarted.insert(updated);
    restarted.insert(dataCenter(AUTH_REF_B));
    expect(restarted.getTargetAdmission(original)).toBeUndefined();
    expect(restarted.getTargetAdmission(updated)).toEqual(admission);
    expect(restarted.get(updated.authRef)).not.toHaveProperty("targetAdmission");
    expect(restarted.list()).toHaveLength(2);
    expectPrivateToOwner(atlassianCredentialMetadataPath(configPath));
  });

  it("removes the binding together with its credential and cannot recreate a deleted identity", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const original = dataCenter();
    const admission = { baseUrl: original.baseUrl, addressClass: "private" as const };
    store.insert(original);
    store.bindTargetAdmission(original, admission);
    expect(store.delete(original.authRef)).toBe(true);
    expect(store.getTargetAdmission(original)).toBeUndefined();
    expect(store.bindTargetAdmission(original, admission)).toBeUndefined();
    const file = JSON.parse(readFileSync(atlassianCredentialMetadataPath(configPath), "utf8")) as {
      targetAdmissions: Record<string, unknown>;
    };
    expect(file.targetAdmissions).not.toHaveProperty(original.authRef);
  });

  it("refuses stale generations, other base URLs and address-class switches without changing the binding", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const original = dataCenter();
    const current = { ...original, generation: 2 };
    const admission = { baseUrl: original.baseUrl, addressClass: "private" as const };
    store.insert(current);
    expect(store.bindTargetAdmission(original, admission)).toBeUndefined();
    expect(
      store.bindTargetAdmission({ ...current, baseUrl: "https://other.example" }, admission),
    ).toBeUndefined();
    expect(
      store.bindTargetAdmission(current, { ...admission, baseUrl: "https://other.example" }),
    ).toBeUndefined();
    expect(store.bindTargetAdmission(current, admission)).toEqual(admission);
    expect(
      store.bindTargetAdmission(current, { ...admission, addressClass: "public" }),
    ).toBeUndefined();
    expect(store.getTargetAdmission(current)).toEqual(admission);
    expect(() => {
      store.insert({ ...current, baseUrl: "https://other.example" });
    }).toThrow(AtlassianCredentialMetadataStoreError);
    expect(store.getTargetAdmission(current)).toEqual(admission);
  });

  it("does not grant Cloud credentials a Data Center admission", () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const cloud = metadata(AUTH_REF_A);
    store.insert(cloud);
    const admission = { baseUrl: cloud.baseUrl, addressClass: "public" as const };
    expect(store.bindTargetAdmission(cloud, admission)).toBeUndefined();
    expect(store.getTargetAdmission(cloud)).toBeUndefined();
  });

  it.each(
    [
      null,
      [],
      { missing: { baseUrl: "https://jira.example:8443/context", addressClass: "private" } },
      { [AUTH_REF_A]: { baseUrl: "https://other.example", addressClass: "private" } },
      { [AUTH_REF_A]: { baseUrl: "https://jira.example:8443/context", addressClass: "metadata" } },
      { [AUTH_REF_A]: { baseUrl: "https://jira.example:8443/context", addressClass: "loopback" } },
      {
        [AUTH_REF_A]: {
          baseUrl: "https://jira.example:8443/context",
          addressClass: "private",
          extra: true,
        },
      },
    ].map((targetAdmissions) => ({ targetAdmissions })),
  )("fails closed on a malformed private admission map (%j)", ({ targetAdmissions }) => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const original = dataCenter();
    store.insert(original);
    writeFileSync(
      atlassianCredentialMetadataPath(configPath),
      JSON.stringify({ version: 1, credentials: { [AUTH_REF_A]: original }, targetAdmissions }),
    );
    expect(() => store.list()).toThrow(AtlassianCredentialMetadataStoreError);
    expect(() => store.getTargetAdmission(original)).toThrow(AtlassianCredentialMetadataStoreError);
    expect(() =>
      store.bindTargetAdmission(original, { baseUrl: original.baseUrl, addressClass: "private" }),
    ).toThrow(AtlassianCredentialMetadataStoreError);
    expect(() => store.delete(original.authRef)).toThrow(AtlassianCredentialMetadataStoreError);
  });
});
