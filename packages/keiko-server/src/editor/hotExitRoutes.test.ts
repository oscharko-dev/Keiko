import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import {
  buildRedactor,
  createInMemoryUiStore,
  type RouteContext,
  type UiHandlerDeps,
} from "../index.js";
import type { UiStore } from "../store/index.js";
import type { EditorHotExitStore, EditorHotExitStoredSnapshot } from "./hotExitStore.js";
import {
  handleEditorHotExitDelete,
  handleEditorHotExitRead,
  handleEditorHotExitWrite,
} from "./hotExitRoutes.js";

interface FakeHotExitStore {
  readonly store: EditorHotExitStore;
  readonly writes: readonly EditorHotExitSnapshotV1[];
  readonly deletes: readonly string[];
}

let root: string;
let uiStore: UiStore;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function snapshotRefFor(workspaceRoot: string, relativePath: string): string {
  return `hot-exit:${sha256Hex(`${workspaceRoot}\0${relativePath}`)}`;
}

function storedSnapshot(snapshot: EditorHotExitSnapshotV1): EditorHotExitStoredSnapshot {
  return {
    schemaVersion: 1,
    content: snapshot.content,
    baseVersion: snapshot.baseVersion,
    contentHash: snapshot.contentHash,
    savedContentHash: snapshot.savedContentHash,
    contentSizeBytes: Buffer.byteLength(snapshot.content, "utf8"),
    updatedAt: snapshot.updatedAt,
    paneId: snapshot.paneId,
    windowId: snapshot.windowId,
  };
}

function createFakeHotExitStore(): FakeHotExitStore {
  const snapshots = new Map<string, EditorHotExitStoredSnapshot>();
  const writes: EditorHotExitSnapshotV1[] = [];
  const deletes: string[] = [];
  const store: EditorHotExitStore = {
    snapshotRefFor,
    write(snapshot) {
      const snapshotRef = snapshotRefFor(snapshot.workspaceRoot, snapshot.relativePath);
      writes.push(snapshot);
      snapshots.set(snapshotRef, storedSnapshot(snapshot));
      return { snapshotRef, contentSizeBytes: Buffer.byteLength(snapshot.content, "utf8") };
    },
    read(snapshotRef) {
      return snapshots.get(snapshotRef) ?? null;
    },
    delete(snapshotRef) {
      deletes.push(snapshotRef);
      snapshots.delete(snapshotRef);
    },
  };
  return { store, writes, deletes };
}

function postContext(pathname: string, body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${pathname}`),
  };
}

function deps(hotExitStore: EditorHotExitStore): UiHandlerDeps {
  return {
    store: uiStore,
    redactor: buildRedactor({}),
    editorHotExitStore: hotExitStore,
  } as unknown as UiHandlerDeps;
}

function snapshot(overrides: Partial<EditorHotExitSnapshotV1> = {}): EditorHotExitSnapshotV1 {
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot: root,
    relativePath: "src/app.ts",
    content: "const value = 1;\n",
    baseVersion: { sizeBytes: 16, modifiedAt: 1, contentHash: "a".repeat(64) },
    contentHash: "b".repeat(64),
    savedContentHash: "a".repeat(64),
    updatedAt: 1_000,
    paneId: "pane-1",
    windowId: "editor-1",
    ...overrides,
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-hot-exit-route-")));
  uiStore = createInMemoryUiStore();
  uiStore.createProject(root, "fixture");
});

afterEach(async () => {
  uiStore.close();
  await rm(root, { recursive: true, force: true });
});

describe("editor hot-exit routes", () => {
  it("rejects denied paths before durable recovery content is written", async () => {
    const fake = createFakeHotExitStore();

    const result = await handleEditorHotExitWrite(
      postContext("/api/editor/hot-exit/write", {
        snapshot: snapshot({ relativePath: ".env" }),
      }),
      deps(fake.store),
    );

    expect(result).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
    expect(fake.writes).toHaveLength(0);
  });

  it("suppresses secret-shaped dirty buffers and clears any previous recovery snapshot", async () => {
    const fake = createFakeHotExitStore();
    const result = await handleEditorHotExitWrite(
      postContext("/api/editor/hot-exit/write", {
        snapshot: snapshot({
          content: "API_KEY=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        }),
      }),
      deps(fake.store),
    );
    const expectedRef = snapshotRefFor(root, "src/app.ts");

    expect(result).toMatchObject({
      status: 200,
      body: { snapshotRef: expectedRef, contentSizeBytes: 0, suppressed: true },
    });
    expect(fake.writes).toHaveLength(0);
    expect(fake.deletes).toEqual([expectedRef]);
  });

  it("binds recovery reads to the workspace root and relative path", async () => {
    const fake = createFakeHotExitStore();
    const write = await handleEditorHotExitWrite(
      postContext("/api/editor/hot-exit/write", { snapshot: snapshot() }),
      deps(fake.store),
    );
    const snapshotRef = (write.body as { readonly snapshotRef: string }).snapshotRef;

    const mismatched = await handleEditorHotExitRead(
      postContext("/api/editor/hot-exit/read", {
        workspaceRoot: root,
        relativePath: "src/other.ts",
        snapshotRef,
      }),
      deps(fake.store),
    );
    const matched = await handleEditorHotExitRead(
      postContext("/api/editor/hot-exit/read", {
        workspaceRoot: root,
        relativePath: "src/app.ts",
        snapshotRef,
      }),
      deps(fake.store),
    );

    expect(mismatched).toMatchObject({
      status: 403,
      body: { error: { code: "HOT_EXIT_REF_MISMATCH" } },
    });
    expect(matched).toMatchObject({ status: 200, body: { found: true } });
  });

  it("fails closed on delete when the recovery ref does not match the requested file", async () => {
    const fake = createFakeHotExitStore();
    const write = await handleEditorHotExitWrite(
      postContext("/api/editor/hot-exit/write", { snapshot: snapshot() }),
      deps(fake.store),
    );
    const snapshotRef = (write.body as { readonly snapshotRef: string }).snapshotRef;

    const mismatched = await handleEditorHotExitDelete(
      postContext("/api/editor/hot-exit/delete", {
        workspaceRoot: root,
        relativePath: "src/other.ts",
        snapshotRef,
      }),
      deps(fake.store),
    );
    const matchedRead = await handleEditorHotExitRead(
      postContext("/api/editor/hot-exit/read", {
        workspaceRoot: root,
        relativePath: "src/app.ts",
        snapshotRef,
      }),
      deps(fake.store),
    );

    expect(mismatched).toMatchObject({
      status: 403,
      body: { error: { code: "HOT_EXIT_REF_MISMATCH" } },
    });
    expect(fake.deletes).toHaveLength(0);
    expect(matchedRead).toMatchObject({ status: 200, body: { found: true } });
  });
});
