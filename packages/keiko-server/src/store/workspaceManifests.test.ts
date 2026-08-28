import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { workspaceTrustRootBindingsMatch } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeUiStore,
  SCHEMA_VERSION,
  UiStoreError,
  UiStoreSchemaVersionError,
} from "./index.js";
import { restoreV13SchemaFixture } from "./legacySchemaTestFixture.js";
import { invalidatedRootRefs } from "./workspaceManifests.js";

let tmp: string;
let project: string;
let dbPath: string;

interface RootIdentityFixture {
  readonly identityDigest: string;
  readonly objectIdentityDigest: string | null;
}

function trustRootBinding(
  rootRef: string,
  identity: RootIdentityFixture | undefined,
):
  | {
      readonly rootRef: string;
      readonly rootIdentityDigest: string;
      readonly rootIdentityProvenanceDigest: string | null;
    }
  | undefined {
  return identity === undefined
    ? undefined
    : {
        rootRef,
        rootIdentityDigest: identity.identityDigest,
        rootIdentityProvenanceDigest: identity.objectIdentityDigest,
      };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-manifest-migration-"));
  project = join(tmp, "project");
  dbPath = join(tmp, "ui.db");
  mkdirSync(project);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("workspace manifest migration", () => {
  it("upgrades pre-M11 projects deterministically without changing the project registry", () => {
    const initial = createNodeUiStore(dbPath, { now: () => 42 });
    initial.createProject(project, "Project");
    const expected = initial.listWorkspaceManifestRecords()[0];
    initial.close();
    if (expected === undefined) throw new Error("missing initial manifest");

    const legacy = new DatabaseSync(dbPath);
    restoreV13SchemaFixture(legacy);
    legacy.close();

    const migrated = createNodeUiStore(dbPath, { now: () => 999 });
    expect(migrated.listProjects()).toHaveLength(1);
    expect(migrated.listWorkspaceManifestRecords()).toHaveLength(1);
    expect(migrated.listWorkspaceManifestRecords()[0]?.recordJson).toBe(expected.recordJson);
    migrated.close();
  });

  it("rejects a future schema with a typed downgrade reason and no reinterpretation", () => {
    const store = createNodeUiStore(dbPath);
    store.close();
    const future = new DatabaseSync(dbPath);
    future.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    future.close();

    try {
      createNodeUiStore(dbPath);
      throw new Error("expected schema rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UiStoreSchemaVersionError);
      expect((error as UiStoreSchemaVersionError).code).toBe("UI_STORE_SCHEMA_NEWER");
    }
  });
});

describe("workspace manifest registration (#2768)", () => {
  it("rolls back a second project whose canonical root collides with an already-registered one", () => {
    // A symlink alias resolves through realpathSync.native to the same canonical root as its
    // target (#2615) without depending on an actual case-insensitive filesystem — the same
    // collision a case-insensitive host produces from two spellings of one directory.
    const alias = join(tmp, "alias");
    symlinkSync(project, alias, "dir");

    const store = createNodeUiStore(dbPath, { now: () => 1 });
    store.createProject(project, "Project");
    try {
      store.createProject(alias, "Alias");
      throw new Error("expected a workspace-root conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(UiStoreError);
      expect((error as UiStoreError).code).toBe("PROJECT_EXISTS");
    }

    // The failed registration must not leave a project row with no paired workspace manifest.
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listWorkspaceManifestRecords()).toHaveLength(1);
    store.close();
  });
});

describe("workspace trust identity invalidation (KEIKO-0198)", () => {
  it("invalidates a root introduced only by the next manifest", () => {
    const previous = new Map<string, RootIdentityFixture>();
    const next = new Map<string, RootIdentityFixture>([
      ["next-only-root", { identityDigest: "identity-a", objectIdentityDigest: "object-a" }],
    ]);

    expect(invalidatedRootRefs(previous, next)).toEqual(new Set(["next-only-root"]));
  });

  it("keeps store invalidation and the contracts predicate in agreement for identity changes", () => {
    const rootRef = "root-fixture";
    const previous = new Map<string, RootIdentityFixture>([
      [rootRef, { identityDigest: "identity-a", objectIdentityDigest: "object-a" }],
    ]);
    const cases: readonly [string, ReadonlyMap<string, RootIdentityFixture>][] = [
      [
        "unchanged identity",
        new Map([[rootRef, { identityDigest: "identity-a", objectIdentityDigest: "object-a" }]]),
      ],
      [
        "public identity digest change",
        new Map([[rootRef, { identityDigest: "identity-b", objectIdentityDigest: "object-a" }]]),
      ],
      [
        "private identity provenance change",
        new Map([[rootRef, { identityDigest: "identity-a", objectIdentityDigest: "object-b" }]]),
      ],
      ["root removal", new Map()],
      [
        "root re-registration",
        new Map([[rootRef, { identityDigest: "identity-b", objectIdentityDigest: "object-b" }]]),
      ],
    ];

    for (const [shape, next] of cases) {
      const contractMatches = workspaceTrustRootBindingsMatch(
        trustRootBinding(rootRef, previous.get(rootRef)),
        trustRootBinding(rootRef, next.get(rootRef)),
      );
      expect(invalidatedRootRefs(previous, next).has(rootRef), shape).toBe(!contractMatches);
    }
  });
});
