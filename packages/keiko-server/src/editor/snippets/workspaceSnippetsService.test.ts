import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  type EditorM7WorkspaceSnippetInput,
} from "@oscharko-dev/keiko-contracts";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import {
  createWorkspaceSnippetsService,
  workspaceSnippetsFingerprint,
  type WorkspaceSnippetsService,
} from "./workspaceSnippetsService.js";

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(stateDir = temporaryDirectory("editor-snippets-state")): WorkspaceSnippetsService {
  return createWorkspaceSnippetsService({
    stateDir,
    mutex: createWorkspaceMutexRegistry(),
  });
}

function snippet(
  overrides: Partial<EditorM7WorkspaceSnippetInput> = {},
): EditorM7WorkspaceSnippetInput {
  return {
    id: "test-log",
    name: "Test log",
    prefixes: ["tlog"],
    description: "Insert a deterministic test log",
    languages: ["typescript"],
    include: ["src/**/*.ts"],
    exclude: ["src/generated/**"],
    body: ["console.log(${1:value});", "$0"],
    ...overrides,
  };
}

function recordPath(stateDir: string, realRoot: string): string {
  return join(stateDir, `editor-snippets-${workspaceSnippetsFingerprint(realRoot)}.json`);
}

describe("workspace snippets service", () => {
  it("stores workspace-scoped snippets with revisioned, content-free snapshots", async () => {
    const root = temporaryDirectory("editor-snippets-root");
    const control = service();

    const absent = control.read(root);
    const result = await control.mutate({
      action: "replace",
      expectedRevision: 0,
      idempotencyKey: "seed-snippets",
      realRoot: root,
      snippets: [snippet()],
    });

    expect(absent).toMatchObject({ storeState: "absent", revision: 0, snippets: [] });
    expect(result).toMatchObject({ kind: "ok", changed: true, revision: 1 });
    expect(result.kind === "ok" ? result.snapshot.workspaceFingerprint : "").not.toBe(root);
    expect(result.kind === "ok" ? result.snapshot.snippets[0]?.provenance : undefined).toEqual({
      source: "workspace",
      workspaceFingerprint: workspaceSnippetsFingerprint(root),
    });
    expect(result.kind === "ok" ? result.etag : "").toMatch(/^"edsn-1-/u);
  });

  it("matches safe snippet completions only when insertion is allowed", async () => {
    const root = temporaryDirectory("editor-snippets-completions");
    const control = service();
    await control.mutate({
      action: "replace",
      expectedRevision: 0,
      idempotencyKey: "completion-snippets",
      realRoot: root,
      snippets: [snippet()],
    });

    const active = control.completions({
      insertionSafe: true,
      languageId: "typescript",
      prefix: "tl",
      realRoot: root,
      relativePath: "src/app.ts",
    });
    const readonly = control.completions({
      insertionSafe: false,
      languageId: "typescript",
      prefix: "tl",
      realRoot: root,
      relativePath: "src/app.ts",
    });

    expect(active).toMatchObject([
      {
        id: "test-log",
        label: "tlog",
        insertText: "console.log(${1:value});\n$0",
      },
    ]);
    expect(readonly).toEqual([]);
  });

  it("rejects stale, divergent idempotency, and unsafe updates without losing the last revision", async () => {
    const root = temporaryDirectory("editor-snippets-revisions");
    const control = service();
    const mutation = {
      action: "replace" as const,
      expectedRevision: 0,
      idempotencyKey: "repeatable",
      realRoot: root,
      snippets: [snippet()],
    };

    const first = await control.mutate(mutation);
    const replay = await control.mutate(mutation);
    const stale = await control.mutate({ ...mutation, idempotencyKey: "stale" });
    const reused = await control.mutate({
      ...mutation,
      idempotencyKey: "repeatable",
      snippets: [snippet({ body: ["different"] })],
    });
    const unsafe = await control.mutate({
      action: "replace",
      expectedRevision: 1,
      idempotencyKey: "unsafe",
      realRoot: root,
      snippets: [snippet({ body: ["${CLIPBOARD}"] })],
    });

    expect(first).toMatchObject({ kind: "ok", changed: true, revision: 1 });
    expect(replay).toMatchObject({ kind: "ok", changed: true, revision: 1 });
    expect(stale).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
    expect(reused).toMatchObject({
      kind: "idempotencyConflict",
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(unsafe).toMatchObject({ kind: "invalid", code: "UNSAFE_SNIPPET" });
    expect(control.read(root)).toMatchObject({ storeState: "ready", revision: 1 });
  });

  it("fails closed for malformed and future-versioned private records", async () => {
    const stateDir = temporaryDirectory("editor-snippets-corrupt-state");
    const root = temporaryDirectory("editor-snippets-corrupt-root");
    writeFileSync(
      recordPath(stateDir, root),
      JSON.stringify({
        kind: "workspace-snippets",
        schemaVersion: `${EDITOR_M7_SNIPPET_COLLECTION_VERSION}-future`,
      }),
      "utf8",
    );

    const control = service(stateDir);

    expect(control.read(root)).toMatchObject({ storeState: "unavailable", revision: 0 });
    await expect(
      control.mutate({
        action: "replace",
        expectedRevision: 0,
        idempotencyKey: "blocked-by-corruption",
        realRoot: root,
        snippets: [snippet()],
      }),
    ).resolves.toMatchObject({ kind: "unavailable", code: "STATE_UNAVAILABLE" });
  });
});
