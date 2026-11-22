import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import {
  createInMemoryWorkspaceIndexStore,
  createTurnScopedWorkspaceIndex,
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceIndexScopeKey,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";

let root = "";
let scope: SearchScope;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-turn-index-"));
  for (let index = 0; index < 40; index += 1) {
    const target = join(root, `bereich-${String(index % 4)}`, `notiz-${String(index)}.md`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      [
        `# Notiz ${String(index)}`,
        `Budget ${String(index * 100)} Euro`,
        "Wartung am Sonntag",
        "",
      ].join("\n"),
    );
  }
  scope = {
    workspace: { ...detectWorkspaceAt(root), contentRedaction: "preserve" },
    scopeId: "turn-index-test",
    relativePaths: [],
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Recorded {
  readonly scopeKey: WorkspaceIndexScopeKey;
  readonly snapshot: WorkspaceIndexSnapshot;
}

interface CountingIndex extends WorkspaceIndex {
  readonly loads: () => number;
  readonly saves: readonly Recorded[];
}

function counting(
  base: WorkspaceIndex = createWorkspaceIndex(createInMemoryWorkspaceIndexStore()),
): CountingIndex {
  let loads = 0;
  const saves: Recorded[] = [];
  return {
    loadSnapshot: (scopeKey, isActive): ReturnType<WorkspaceIndex["loadSnapshot"]> => {
      loads += 1;
      return base.loadSnapshot(scopeKey, isActive);
    },
    saveSnapshot: (scopeKey, snapshot, isActive): Promise<void> => {
      saves.push({ scopeKey, snapshot });
      return base.saveSnapshot(scopeKey, snapshot, isActive);
    },
    loads: (): number => loads,
    saves,
  };
}

function query(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 20, emittedAtMs: 0 };
}

async function search(
  index: WorkspaceIndex,
  text: string,
  relativePaths: readonly string[] = [],
): Promise<Awaited<ReturnType<typeof searchText>>> {
  return searchText({ ...scope, relativePaths }, query(text), DEFAULT_SEARCH_LIMITS, {
    workspaceIndex: index,
  });
}

function atomsOf(result: Awaited<ReturnType<typeof searchText>>): readonly string[] {
  return result.atoms.map(
    (atom) =>
      `${atom.scopePath}:${String(atom.lineRange?.startLine)}-${String(atom.lineRange?.endLine)}:${String(atom.score)}`,
  );
}

/** A reporter for flushes that must not see a rejected save. */
function noFailure(cause: unknown): void {
  throw new Error("unexpected rejected save", { cause });
}

const TURN: readonly (readonly [string, readonly string[]])[] = [
  ["Budget", []],
  ["Wartung Sonntag", []],
  ["Budget", ["bereich-2"]],
  ["Notiz", []],
  ["Budget", []],
];

describe("turn-scoped workspace index", () => {
  it("returns the same search results as the base index for every call of a turn", async () => {
    const direct = createWorkspaceIndex(createInMemoryWorkspaceIndexStore());
    const turn = createTurnScopedWorkspaceIndex(
      createWorkspaceIndex(createInMemoryWorkspaceIndexStore()),
    );
    for (const [text, relativePaths] of TURN) {
      const expected = atomsOf(await search(direct, text, relativePaths));
      expect(expected.length).toBeGreaterThan(0);
      expect(atomsOf(await search(turn, text, relativePaths))).toEqual(expected);
    }
  });

  it("writes nothing to the base during the turn and asks it once per scope key", async () => {
    const base = counting();
    const turn = createTurnScopedWorkspaceIndex(base);
    await search(turn, "Budget");
    const loadsAfterFirst = base.loads();
    expect(loadsAfterFirst).toBeGreaterThan(0);
    await search(turn, "Wartung Sonntag");
    await search(turn, "Notiz");
    expect(base.loads()).toBe(loadsAfterFirst);
    expect(base.saves).toHaveLength(0);
    expect(turn.usage().reusedLoads).toBeGreaterThan(0);
    expect(turn.usage().deferredSaves).toBeGreaterThan(0);
  });

  it("flushes the newest snapshot of each scope key exactly once", async () => {
    const base = counting();
    const turn = createTurnScopedWorkspaceIndex(base);
    for (const [text, relativePaths] of TURN) await search(turn, text, relativePaths);
    const held = turn.usage().deferredSaves;
    const flushed = await turn.flush(noFailure);
    expect(flushed.failed).toBe(0);
    expect(flushed.saved).toBe(base.saves.length);
    expect(flushed.saved).toBeGreaterThan(0);
    expect(flushed.saved).toBeLessThan(held);
    expect(await turn.flush(noFailure)).toEqual({ saved: 0, failed: 0 });
  });

  it("leaves an index behind that a later request reuses, and only after a flush", async () => {
    const unflushed = createWorkspaceIndex(createInMemoryWorkspaceIndexStore());
    await search(createTurnScopedWorkspaceIndex(unflushed), "Budget");
    expect((await search(unflushed, "Wartung")).workspaceIndex?.reusedRecords ?? 0).toBe(0);

    const flushed = createWorkspaceIndex(createInMemoryWorkspaceIndexStore());
    const turn = createTurnScopedWorkspaceIndex(flushed);
    await search(turn, "Budget");
    await turn.flush(noFailure);
    expect((await search(flushed, "Wartung")).workspaceIndex?.reusedRecords ?? 0).toBeGreaterThan(
      0,
    );
  });

  it("collects the causes of rejected saves instead of throwing or dropping them", async () => {
    const recorder = counting();
    await search(recorder, "Budget");
    const first = recorder.saves[0];
    if (first === undefined) throw new Error("the fixture search saved nothing");
    const refused = new Error("store refused");
    const turn = createTurnScopedWorkspaceIndex({
      loadSnapshot: () => Promise.resolve(undefined),
      saveSnapshot: () => Promise.reject(refused),
    });
    await turn.saveSnapshot(first.scopeKey, first.snapshot);
    const causes: unknown[] = [];
    const flushed = await turn.flush((cause) => {
      causes.push(cause);
    });
    expect(flushed).toEqual({ saved: 0, failed: 1 });
    expect(causes).toEqual([refused]);
  });

  it("serves a held snapshot to the next load and never one the base would drop", async () => {
    const recorder = counting();
    await search(recorder, "Budget");
    const [first, second] = recorder.saves;
    if (first === undefined || second === undefined)
      throw new Error("the fixture search saved too little");
    const base = counting({
      loadSnapshot: () => Promise.resolve(undefined),
      saveSnapshot: () => Promise.resolve(),
    });
    const turn = createTurnScopedWorkspaceIndex(base);
    await turn.saveSnapshot(first.scopeKey, first.snapshot);
    expect(await turn.loadSnapshot(first.scopeKey)).toEqual(first.snapshot);
    expect(base.loads()).toBe(0);
    // A snapshot stored under another scope key fails the base's admission and is not held.
    await turn.saveSnapshot(second.scopeKey, first.snapshot);
    expect(await turn.loadSnapshot(second.scopeKey)).toBeUndefined();
    expect(base.loads()).toBe(1);
    expect((await turn.flush(noFailure)).saved).toBe(1);
  });

  it("does not remember the answer of an abandoned or failed load", async () => {
    const recorder = counting();
    await search(recorder, "Budget");
    const first = recorder.saves[0];
    if (first === undefined) throw new Error("the fixture search saved nothing");
    let failing = true;
    let loads = 0;
    const turn = createTurnScopedWorkspaceIndex({
      loadSnapshot: () => {
        loads += 1;
        return failing ? Promise.reject(new Error("unreadable")) : Promise.resolve(first.snapshot);
      },
      saveSnapshot: () => Promise.resolve(),
    });
    await expect(turn.loadSnapshot(first.scopeKey)).rejects.toThrow("unreadable");
    failing = false;
    expect(await turn.loadSnapshot(first.scopeKey, () => false)).toBeUndefined();
    expect(loads).toBe(1);
    let active = true;
    const abandoned = turn.loadSnapshot(first.scopeKey, () => active);
    active = false;
    await abandoned;
    expect(await turn.loadSnapshot(first.scopeKey)).toEqual(first.snapshot);
    expect(loads).toBe(3);
    expect(await turn.loadSnapshot(first.scopeKey)).toEqual(first.snapshot);
    expect(loads).toBe(3);
  });

  it("holds nothing for a request that is no longer active", async () => {
    const recorder = counting();
    await search(recorder, "Budget");
    const first = recorder.saves[0];
    if (first === undefined) throw new Error("the fixture search saved nothing");
    const base = counting({
      loadSnapshot: () => Promise.resolve(undefined),
      saveSnapshot: () => Promise.resolve(),
    });
    const turn = createTurnScopedWorkspaceIndex(base);
    await turn.saveSnapshot(first.scopeKey, first.snapshot, () => false);
    expect(turn.usage().deferredSaves).toBe(0);
    expect((await turn.flush(noFailure)).saved).toBe(0);
  });
});
