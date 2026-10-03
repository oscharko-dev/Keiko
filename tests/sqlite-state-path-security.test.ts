import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeUiDatabase } from "../packages/keiko-server/src/store/db.js";
import { resolveUiDbPath } from "../packages/keiko-server/src/store/paths.js";
import { openMemoryDatabase } from "../packages/keiko-memory-vault/src/db.js";
import { resolveMemoryDbPath } from "../packages/keiko-memory-vault/src/paths.js";
import { TEST_CIPHER } from "../packages/keiko-memory-vault/src/_support.js";
import { openKnowledgeStore } from "../packages/keiko-local-knowledge/src/store.js";

import { SqliteStatePathError } from "@oscharko-dev/keiko-security/fs-hardening";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "./support/activity-log-proof.js";

function assertRefusalEvidence(event: unknown, store: string): void {
  if (typeof event !== "object" || event === null) throw new TypeError("Expected refusal event.");
  const persisted = expectActivityLogProof(
    "sqlite.state-path.refused.authority",
    formatActivityLogProofLine(event),
  );
  expect(persisted).toMatchObject({
    store,
    failureKind: "unsafe-target",
    errorKind: "permission-denied",
  });
}

const homeStub = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: (): string => homeStub.path ?? actual.homedir() };
});
const roots: string[] = [];
afterEach((): void => {
  homeStub.path = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): { root: string; state: string; outside: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-sqlite-path-"));
  roots.push(root);
  const state = join(root, "state");
  const outside = join(root, "outside");
  mkdirSync(state);
  mkdirSync(outside);
  return { root, state, outside };
}
const stores = [
  {
    name: "ui",
    filename: "keiko-ui.db",
    open: openNodeUiDatabase,
    defaultResolve: (): string => resolveUiDbPath(undefined, {}),
    resolve: (state: string): string => resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: state }),
  },
  {
    name: "memory-vault",
    filename: "keiko-memory.db",
    open: (path: string, sink?: { write: (event: unknown) => void }): DatabaseSync =>
      openMemoryDatabase(path, TEST_CIPHER, sink),
    defaultResolve: (): string => resolveMemoryDbPath(undefined, {}),
    resolve: (state: string): string => resolveMemoryDbPath(state, {}),
  },
] as const;

describe("local knowledge SQLite path authority", (): void => {
  it.each(["ancestor", "leaf", "hard-link", "-wal", "-shm", "-journal"])(
    "refuses a planted %s before changing external state",
    (shape): void => {
      const { state, outside } = fixture();
      const target = join(outside, "capsules.db");
      const external = new DatabaseSync(target);
      external.exec("CREATE TABLE sentinel(value TEXT)");
      external.close();
      const before = readFileSync(target);
      const path = join(state, "local-knowledge", "capsules.db");
      if (shape === "ancestor") symlinkSync(outside, join(state, "local-knowledge"));
      else {
        mkdirSync(join(state, "local-knowledge"));
        if (shape === "hard-link") linkSync(target, path);
        else symlinkSync(target, `${path}${shape === "leaf" ? "" : shape}`);
      }
      const events: unknown[] = [];
      expect(() =>
        openKnowledgeStore({
          dbPath: path,
          logSink: {
            write: (event) => {
              events.push(event);
            },
          },
        }),
      ).toThrow(SqliteStatePathError);
      expect(readFileSync(target)).toEqual(before);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        op: "sqlite.state-path.refused",
        extra: {
          store: "local-knowledge",
          failureKind: shape === "ancestor" ? "unsafe-ancestor" : "unsafe-target",
        },
      });
      expect(JSON.stringify(events)).not.toContain(outside);
    },
  );
});
describe.each(stores)("$name SQLite path authority", (store): void => {
  it.each(["", "-wal", "-shm", "-journal"])(
    "refuses planted %s symlink before SQLite or chmod touches the target",
    (suffix): void => {
      const { state, outside } = fixture();
      const target = join(outside, "sentinel.db");
      const external = new DatabaseSync(target);
      external.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserved')");
      external.close();
      const before = readFileSync(target);
      const mode = statSync(target).mode;
      const path = join(state, store.filename);
      symlinkSync(target, `${path}${suffix}`);
      const events: unknown[] = [];
      expect((): void => {
        store.open(path, {
          write: (event): void => {
            events.push(event);
          },
        });
      }).toThrow(SqliteStatePathError);
      expect(readFileSync(target)).toEqual(before);
      expect(statSync(target).mode).toBe(mode);
      expect(events).toEqual([
        expect.objectContaining({
          op: "sqlite.state-path.refused",
          errorKind: "permission-denied",
          extra: expect.objectContaining({
            store: store.name,
            failureKind: "unsafe-target",
          }) as unknown,
        }),
      ]);
      assertRefusalEvidence(events[0], store.name);
      expect((): string => store.resolve(state)).toThrow();
      expect(JSON.stringify(events)).not.toContain(outside);
    },
  );
  it("refuses a missing target behind a dangling database symlink", (): void => {
    const { state, outside } = fixture();
    const target = join(outside, "missing.db");
    const path = join(state, store.filename);
    symlinkSync(target, path);
    expect((): void => {
      store.open(path);
    }).toThrow();
    expect((): string => store.resolve(state)).toThrow();
    expect((): Buffer => readFileSync(target)).toThrow();
  });
  it("refuses a planted ancestor before creating directories outside state", (): void => {
    const { root, outside } = fixture();
    const link = join(root, "redirect");
    symlinkSync(outside, link, "dir");
    const path = join(link, "child", store.filename);
    expect((): void => {
      store.open(path);
    }).toThrow();
    expect((): unknown => statSync(join(outside, "child"))).toThrow();
  });
  it("refuses an existing hard-linked database inode", (): void => {
    const { state, outside } = fixture();
    const target = join(outside, "sentinel.db");
    const external = new DatabaseSync(target);
    external.close();
    linkSync(target, join(state, store.filename));
    expect((): void => {
      store.open(join(state, store.filename));
    }).toThrow();
    expect(readFileSync(target)).toHaveLength(0);
  });
  it("checks the default home database leaf after joining the fixed filename", (): void => {
    const { root, outside } = fixture();
    homeStub.path = root;
    const parent = store.name === "ui" ? join(root, ".keiko") : join(root, ".keiko", "memory");
    mkdirSync(parent, { recursive: true });
    symlinkSync(join(outside, "missing.db"), join(parent, store.filename));
    expect(store.defaultResolve).toThrow();
  });
  it("retains normal fresh state and reopen support", (): void => {
    const { state } = fixture();
    const path = store.resolve(state);
    const db = store.open(path);
    db.close();
    const reopened = store.open(path);
    expect(reopened.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    reopened.close();
  });
});
