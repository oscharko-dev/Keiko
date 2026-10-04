import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { detectWorkspaceAt, type SearchScope } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs, type WorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { _fileStateCacheIdentityForTests as capture } from "./grounded-orchestrator.js";

let root = "";
let paths: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-cache-scheduling-"));
  paths = Array.from({ length: 2_000 }, (_, index) => `record-${String(index)}.txt`);
  for (const path of paths) writeFileSync(join(root, path), "known fixture text\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function scope(): SearchScope {
  return { workspace: detectWorkspaceAt(root), scopeId: "cache-scheduling", relativePaths: [] };
}

it("observes a real event-loop abort before completing a large safe cache identity walk", async () => {
  const selected = scope();
  const controller = new AbortController();
  let statCalls = 0;
  let callsAfterAbort = 0;
  const fs: WorkspaceFs = {
    ...nodeWorkspaceFs,
    stat: (path) => {
      statCalls += 1;
      if (controller.signal.aborted) callsAfterAbort += 1;
      return nodeWorkspaceFs.stat(path);
    },
  };
  const abort = setImmediate(() => {
    controller.abort();
  });
  try {
    await expect(
      Promise.resolve().then(() =>
        capture(paths, selected, fs, Date.now, Infinity, controller.signal),
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(statCalls).toBeGreaterThan(0);
    expect(statCalls).toBeLessThan(paths.length);
    expect(callsAfterAbort).toBe(0);
  } finally {
    clearImmediate(abort);
  }
});

it("stops metadata work when an explicit deadline crosses during a scheduling yield", async () => {
  const selected = scope();
  let expired = false;
  let lateCalls = 0;
  const fs: WorkspaceFs = {
    ...nodeWorkspaceFs,
    stat: (path) => {
      if (expired) lateCalls += 1;
      return nodeWorkspaceFs.stat(path);
    },
  };
  const deadline = setImmediate(() => {
    expired = true;
  });
  try {
    const identity = await capture(paths, selected, fs, () => Number(expired), 1, undefined);
    expect(expired).toBe(true);
    expect(identity).toBeUndefined();
    expect(lateCalls).toBe(0);
  } finally {
    clearImmediate(deadline);
  }
});

it("preserves the actual safe per-file identity across scheduling yields and input order", async () => {
  const selected = scope();
  const individual = await Promise.all(
    paths.map((path) => capture([path], selected, nodeWorkspaceFs, Date.now, Infinity, undefined)),
  );
  const expected = individual
    .flatMap((identity) => identity ?? [])
    .sort((a, b) => a.localeCompare(b));
  expect(expected).toHaveLength(paths.length);
  const actual = await capture(
    [...paths].reverse(),
    selected,
    nodeWorkspaceFs,
    Date.now,
    Infinity,
    undefined,
  );
  expect(actual).toEqual(expected);
});
