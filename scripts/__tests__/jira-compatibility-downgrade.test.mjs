import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atlassianCredentialMetadataPath,
  createAtlassianCredentialMetadataStore,
} from "../../packages/keiko-server/dist/atlassian/credentialMetadataStore.js";
import { downgradeJiraCompatibility } from "../lib/jira-compatibility-downgrade.mjs";

const directories = [];
const authRef = `atlassian-cred:${"Aa1-_".repeat(4)}Zz`;

function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "jira-downgrade-"));
  directories.push(directory);
  const configPath = join(directory, "keiko.config.json");
  const store = createAtlassianCredentialMetadataStore({ configPath });
  const metadata = {
    schemaVersion: "1",
    authRef,
    provider: "jira",
    deployment: "data-center",
    generation: 3,
    displayName: "Synthetic Jira",
    baseUrl: "https://jira.example.invalid/context",
    authScheme: "bearer-pat",
    createdAt: 1700000000000,
    livePod: {
      podId: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
      creationRequestId: "6765d9e4-fc9a-46d5-aea4-24880fec5e1e",
      ownerDigest: "a".repeat(64),
      verificationRevision: 4,
      verificationInProgress: false,
      verificationStatus: "ok",
      compatibility: {
        schemaVersion: 1,
        deploymentType: "Data Center",
        versionNumbers: [11, 3, 13],
        restApi: "v2",
        agileApi: "unverified",
      },
    },
  };
  store.insert(metadata);
  expect(
    store.bindTargetAdmission(metadata, {
      baseUrl: metadata.baseUrl,
      addressClass: "private",
    }),
  ).toBeDefined();
  const path = atlassianCredentialMetadataPath(configPath);
  return { configPath, store, metadata, path };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("offline Jira compatibility downgrade", () => {
  it("previews without changing the metadata or accessing any vault", () => {
    const f = fixture();
    const before = readFileSync(f.path);
    expect(downgradeJiraCompatibility({ configPath: f.configPath })).toEqual({
      affected: 1,
      changed: 0,
    });
    expect(readFileSync(f.path)).toEqual(before);
  });

  it("requires an explicit stopped-server assertion before applying", () => {
    const f = fixture();
    const before = readFileSync(f.path);
    expect(() => downgradeJiraCompatibility({ configPath: f.configPath, apply: true })).toThrow(
      "server-must-be-stopped",
    );
    expect(readFileSync(f.path)).toEqual(before);
  });

  it("removes only the observation and invalidates old authority, preserving identity and admission", () => {
    const f = fixture();
    const before = JSON.parse(readFileSync(f.path, "utf8"));
    expect(
      downgradeJiraCompatibility({ configPath: f.configPath, apply: true, serverStopped: true }),
    ).toEqual({ affected: 1, changed: 1 });
    const { compatibility: _observation, ...legacyPod } = f.metadata.livePod;
    const expected = {
      ...f.metadata,
      generation: 4,
      livePod: {
        ...legacyPod,
        verificationRevision: 5,
        verificationInProgress: false,
        verificationStatus: "unverified",
      },
    };
    const restarted = createAtlassianCredentialMetadataStore({ configPath: f.configPath });
    expect(restarted.get(authRef)).toEqual(expected);
    expect(JSON.parse(readFileSync(f.path, "utf8")).targetAdmissions).toEqual(
      before.targetAdmissions,
    );
    expect(Object.keys(expected.livePod).sort()).toEqual(
      [
        "podId",
        "ownerDigest",
        "creationRequestId",
        "verificationRevision",
        "verificationInProgress",
        "verificationStatus",
      ].sort(),
    );
    if (process.platform !== "win32") expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(
      downgradeJiraCompatibility({ configPath: f.configPath, apply: true, serverStopped: true }),
    ).toEqual({ affected: 0, changed: 0 });
    expect(restarted.get(authRef)).toEqual(expected);
  });

  it.each(["verification", "credential-operation"])(
    "refuses pending %s without partial edits",
    (kind) => {
      const f = fixture();
      const pending = structuredClone(f.metadata);
      delete pending.livePod.compatibility;
      if (kind === "verification") pending.livePod.verificationInProgress = true;
      else {
        pending.livePod.credentialOperation = "replace-token";
        pending.livePod.verificationStatus = "unverified";
      }
      f.store.insert(pending);
      const before = readFileSync(f.path);
      expect(() => downgradeJiraCompatibility({ configPath: f.configPath })).toThrow(
        "operation-pending",
      );
      expect(readFileSync(f.path)).toEqual(before);
    },
  );

  it("refuses exhausted counters without changing durable state", () => {
    const f = fixture();
    f.store.insert({ ...f.metadata, generation: Number.MAX_SAFE_INTEGER });
    const before = readFileSync(f.path);
    expect(() => downgradeJiraCompatibility({ configPath: f.configPath })).toThrow(
      "counter-exhausted",
    );
    expect(readFileSync(f.path)).toEqual(before);
  });

  it("refuses a missing store instead of reporting a successful no-op", () => {
    const f = fixture();
    rmSync(f.path);
    expect(() => downgradeJiraCompatibility({ configPath: f.configPath })).toThrow(
      "metadata-store-missing",
    );
  });

  it("preserves a corrupt store and reports no successful migration", () => {
    const f = fixture();
    writeFileSync(f.path, "{invalid");
    expect(() =>
      downgradeJiraCompatibility({ configPath: f.configPath, apply: true, serverStopped: true }),
    ).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe("{invalid");
  });
});
