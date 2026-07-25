// Wave-2 audit finding 4 (#2616): local history was keyed by the manifest `workspaceId`, which is
// derived from a workspace's FOUNDING root. Joining a multi-root workspace absorbs and deletes the
// joiner's own workspace, and a founding root that leaves is re-minted under a discriminator — so
// the id moves while the root does not, and every checkpoint the root captured strands under an id
// nothing resolves to again. These are journeys through the real manifest service, not a unit stub:
// the defect only shows up once membership actually changes.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorkspaceManifest,
  WorkspaceRootDispatch,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../../deps.js";
import { createInMemoryUiStore, type UiStore } from "../../store/index.js";
import { WorkspaceManifestService } from "../../workspace-manifests.js";
import { resolveEditorLocalHistoryRoot } from "./localHistoryCapture.js";
import {
  createEditorLocalHistoryStore,
  type EditorLocalHistoryStore,
} from "./localHistoryStore.js";

const VAULT_KEY = Buffer.alloc(32, 0x37).toString("base64");

let tmp: string;
let rootA: string;
let rootB: string;
let store: UiStore;
let service: WorkspaceManifestService;
let history: EditorLocalHistoryStore;
let deps: Pick<UiHandlerDeps, "store">;

function dispatch(manifest: WorkspaceManifest, rootIndex: number): WorkspaceRootDispatch {
  const root = manifest.roots[rootIndex];
  if (root === undefined) throw new Error("missing fixture root");
  return {
    kind: "workspace-root-dispatch",
    schemaVersion: manifest.schemaVersion,
    workspaceId: manifest.workspaceId,
    manifestRef: manifest.manifestRef,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    rootRef: root.rootRef,
    rootIdentityDigest: root.identityDigest,
    operationClass: "mutating",
  };
}

function workspaceOf(canonicalRoot: string): WorkspaceManifest {
  const found = service
    .list()
    .find((manifest) => manifest.roots.some((root) => root.canonicalRoot === canonicalRoot));
  if (found === undefined) throw new Error("missing fixture workspace");
  return found;
}

function rootRefOf(canonicalRoot: string): WorkspaceRootRef {
  const root = workspaceOf(canonicalRoot).roots.find(
    (candidate) => candidate.canonicalRoot === canonicalRoot,
  );
  if (root === undefined) throw new Error("missing fixture root");
  return root.rootRef;
}

function captureIn(canonicalRoot: string, content: string, nowMs: number): void {
  const identity = resolveEditorLocalHistoryRoot(deps, canonicalRoot);
  const absolutePath = join(canonicalRoot, "src", "app.ts");
  writeFileSync(absolutePath, content, "utf8");
  history.capture({
    ...identity,
    relativePath: "src/app.ts",
    absolutePath,
    content,
    origin: "user-save",
    nowMs,
  });
}

function historyIn(canonicalRoot: string, nowMs: number): readonly string[] {
  const identity = resolveEditorLocalHistoryRoot(deps, canonicalRoot);
  return history.list(identity, "src/app.ts", nowMs).map((entry) => entry.entryRef);
}

function readIn(canonicalRoot: string, entryRef: string, nowMs: number): string {
  const identity = resolveEditorLocalHistoryRoot(deps, canonicalRoot);
  return history.read(identity, entryRef, nowMs).content;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-history-membership-")));
  rootA = join(tmp, "alpha");
  rootB = join(tmp, "beta");
  for (const root of [rootA, rootB]) {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "seed\n", "utf8");
  }
  store = createInMemoryUiStore({ now: () => 100 });
  store.createProject(rootA, "Alpha");
  store.createProject(rootB, "Beta");
  service = new WorkspaceManifestService(store);
  deps = { store };
  history = createEditorLocalHistoryStore({
    stateDir: join(tmp, "state"),
    env: { KEIKO_EDITOR_LOCAL_HISTORY_KEY: VAULT_KEY },
    limits: { coalesceMs: 0 },
  });
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("editor local-history across workspace root membership", () => {
  it("keeps a root's checkpoints when it joins another workspace and when it leaves again", () => {
    captureIn(rootA, "before membership\n", 1_000);
    const captured = historyIn(rootA, 1_001);
    expect(captured).toHaveLength(1);

    // Alpha joins Beta's workspace. Alpha's own single-root workspace is absorbed and deleted, so
    // its manifest workspaceId ceases to exist entirely.
    const absorbedWorkspaceId = workspaceOf(rootA).workspaceId;
    service.addRoot(dispatch(workspaceOf(rootB), 0), rootA);
    expect(workspaceOf(rootA).workspaceId).not.toBe(absorbedWorkspaceId);
    expect(workspaceOf(rootA).roots).toHaveLength(2);

    expect(historyIn(rootA, 1_002)).toEqual(captured);
    expect(readIn(rootA, captured[0] ?? "", 1_003)).toBe("before membership\n");

    // …and a capture taken while a member joins the same history, not a second one.
    captureIn(rootA, "while a member\n", 2_000);
    expect(historyIn(rootA, 2_001)).toHaveLength(2);

    // Alpha leaves again and is re-minted as its own workspace.
    const merged = workspaceOf(rootA);
    const alphaIndex = merged.roots.findIndex((root) => root.canonicalRoot === rootA);
    service.removeRoot(dispatch(merged, alphaIndex === 0 ? 1 : 0), rootRefOf(rootA));
    expect(workspaceOf(rootA).roots).toHaveLength(1);

    expect(historyIn(rootA, 3_000)).toHaveLength(2);
    expect(readIn(rootA, captured[0] ?? "", 3_001)).toBe("before membership\n");
  });

  it("keeps the two roots' histories separate while they share one workspace", () => {
    service.addRoot(dispatch(workspaceOf(rootB), 0), rootA);
    captureIn(rootA, "alpha content\n", 1_000);
    captureIn(rootB, "beta content\n", 1_010);

    const alpha = historyIn(rootA, 1_020);
    const beta = historyIn(rootB, 1_020);

    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
    expect(alpha).not.toEqual(beta);
    expect(readIn(rootA, alpha[0] ?? "", 1_021)).toBe("alpha content\n");
    expect(readIn(rootB, beta[0] ?? "", 1_021)).toBe("beta content\n");
    // A root may not reach the other's checkpoints just because they share a workspace.
    expect(() => readIn(rootA, beta[0] ?? "", 1_022)).toThrow(
      expect.objectContaining({ code: "ENTRY_NOT_FOUND" }),
    );
  });
});
