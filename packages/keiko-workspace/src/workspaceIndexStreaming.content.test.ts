import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";
import {
  createFileWorkspaceIndexStore,
  createInMemoryWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceIndexSnapshot,
  type WorkspaceIndexStore,
} from "./workspaceIndex.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LIMITS = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null, elapsedMsMax: null };
const NOW = (): number => 0;
const FILES: Readonly<Record<string, string>> = {
  "docs/vesper.md": "# Vesper\n\nThe Vesper furnace keeps its temperature at 73.5 C.\n",
  "docs/orbit.md": "# Orbit\n\nOrbit telemetry reports altitude and heading every minute.\n",
  "src/furnace.ts":
    "export function furnaceTemperature(): number {\n  return 73.5; // Vesper setpoint\n}\n",
  "src/orbit.ts": "export const orbitAltitude = (heading: number): number => heading * 2;\n",
  "notes/ledger.txt": "The ledger lists every telemetry batch and its furnace reading.\n",
};
const FILE_COUNT = Object.keys(FILES).length;

function question(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 20, emittedAtMs: 0 };
}

const FIRST = question("Which temperature does the Vesper furnace keep?");
const SECOND = question("How often does orbit telemetry report altitude?");

interface Fixture {
  readonly root: string;
  readonly scope: (workspace?: Partial<WorkspaceInfo>) => SearchScope;
  readonly reads: ReturnType<typeof vi.fn<NonNullable<typeof nodeWorkspaceFs.readFileBytes>>>;
  readonly fs: typeof nodeWorkspaceFs;
  readonly reopen: () => WorkspaceIndex;
}

function writeFixtureFile(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function encryptedStore(): () => WorkspaceIndexStore {
  const runtimeDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-content-store-")));
  roots.push(runtimeDir);
  return () => createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: Buffer.alloc(32, 7) });
}

function fixture(storeFor: () => WorkspaceIndexStore = encryptedStore()): Fixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-index-content-"));
  roots.push(root);
  for (const [path, text] of Object.entries(FILES)) writeFixtureFile(root, path, text);
  const detected = detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false });
  const reads = vi.fn(nodeWorkspaceFs.readFileBytes);
  return {
    root,
    scope: (workspace = {}): SearchScope => ({
      workspace: { ...detected, ...workspace },
      scopeId: "content",
      relativePaths: [],
    }),
    reads,
    fs: { ...nodeWorkspaceFs, readFileBytes: reads },
    reopen: () => createWorkspaceIndex(storeFor()),
  };
}

async function indexedSearch(
  current: Fixture,
  query: RetrievalQuery,
  workspace: Partial<WorkspaceInfo> = {},
): Promise<Awaited<ReturnType<typeof searchText>>> {
  return searchText(current.scope(workspace), query, LIMITS, {
    fs: current.fs,
    nowMs: NOW,
    workspaceIndex: current.reopen(),
  });
}

/** The same question without any index: what the stored text must reproduce exactly. */
async function liveSearch(
  current: Fixture,
  query: RetrievalQuery,
  workspace: Partial<WorkspaceInfo> = {},
): Promise<Awaited<ReturnType<typeof searchText>>> {
  return searchText(current.scope(workspace), query, LIMITS, { fs: nodeWorkspaceFs, nowMs: NOW });
}

function readPaths(current: Fixture): readonly string[] {
  return current.reads.mock.calls.map(([path]) => path.replaceAll("\\", "/")).sort();
}

describe("query-independent content layer (#4457)", () => {
  it("answers a differently worded question without reading any unchanged file", async () => {
    const current = fixture();
    const first = await indexedSearch(current, FIRST);
    expect(first.workspaceIndex).toMatchObject({ reusedRecords: 0 });
    expect(new Set(readPaths(current)).size).toBe(FILE_COUNT);
    current.reads.mockClear();

    const second = await indexedSearch(current, SECOND);
    expect(current.reads).not.toHaveBeenCalled();
    expect(second.workspaceIndex).toMatchObject({
      reusedRecords: FILE_COUNT,
      indexedRecords: 0,
      staleRecords: 0,
    });
    const live = await liveSearch(current, SECOND);
    expect(second.atoms.length).toBeGreaterThan(0);
    expect(second.atoms).toEqual(live.atoms);
    expect(second.coverage.filesScanned).toBe(live.coverage.filesScanned);

    current.reads.mockClear();
    const again = await indexedSearch(current, FIRST);
    expect(current.reads).not.toHaveBeenCalled();
    expect(again.workspaceIndex?.reusedRecords).toBe(FILE_COUNT);
    expect(again.atoms).toEqual(first.atoms);
  });

  it("detects changed, added and deleted files exactly as a live read does", async () => {
    const current = fixture();
    await indexedSearch(current, FIRST);
    writeFixtureFile(
      current.root,
      "docs/orbit.md",
      "# Orbit\n\nOrbit telemetry now reports altitude twice.\n",
    );
    writeFixtureFile(current.root, "docs/added.md", "Added orbit telemetry altitude notes.\n");
    unlinkSync(join(current.root, "src/orbit.ts"));
    current.reads.mockClear();

    const second = await indexedSearch(current, SECOND);
    expect([
      ...new Set(readPaths(current).map((path) => path.slice(path.lastIndexOf("/") + 1))),
    ]).toEqual(["added.md", "orbit.md"]);
    expect(second.workspaceIndex).toMatchObject({
      reusedRecords: FILE_COUNT - 2,
      staleRecords: 1,
    });
    expect(second.atoms).toEqual((await liveSearch(current, SECOND)).atoms);
    expect(second.atoms.map((atom) => atom.scopePath)).not.toContain("src/orbit.ts");
  });

  it("never serves stored text after the configured secret literals change", async () => {
    const current = fixture();
    const secret = "furnace";
    const before = {
      contentRedaction: "preserve" as const,
      contentSecrets: (): readonly string[] => [],
    };
    const after = {
      contentRedaction: "preserve" as const,
      contentSecrets: (): readonly string[] => [secret],
    };
    await indexedSearch(current, FIRST, before);
    current.reads.mockClear();

    const redacted = await indexedSearch(current, SECOND, after);
    expect(new Set(readPaths(current)).size).toBe(FILE_COUNT);
    expect(redacted.workspaceIndex?.reusedRecords).toBe(0);
    expect(redacted.atoms).toEqual((await liveSearch(current, SECOND, after)).atoms);
  });

  it("keeps the redacted and the preserving lane text apart", async () => {
    const current = fixture();
    await indexedSearch(current, FIRST, { contentRedaction: "preserve", contentSecrets: () => [] });
    current.reads.mockClear();
    const strict = await indexedSearch(current, SECOND);
    expect(new Set(readPaths(current)).size).toBe(FILE_COUNT);
    expect(strict.workspaceIndex?.reusedRecords).toBe(0);
  });

  it("reads the file again when a stored text no longer proves its digest", async () => {
    const base = createInMemoryWorkspaceIndexStore();
    const tampering: WorkspaceIndexStore = {
      loadSnapshot: async (key, active) => {
        const snapshot = await base.loadSnapshot(key, active);
        return snapshot?.contentShard === undefined ? snapshot : tamperedText(snapshot);
      },
      saveSnapshot: base.saveSnapshot,
    };
    const current = fixture(() => tampering);
    await indexedSearch(current, FIRST);
    current.reads.mockClear();

    const second = await indexedSearch(current, SECOND);
    expect(new Set(readPaths(current)).size).toBe(FILE_COUNT);
    expect(second.workspaceIndex?.reusedRecords).toBe(0);
    expect(second.atoms).toEqual((await liveSearch(current, SECOND)).atoms);
  });

  it("stores lane text only in content shards, never beside a query match", async () => {
    const saved: WorkspaceIndexSnapshot[] = [];
    const base = createInMemoryWorkspaceIndexStore();
    const current = fixture(() => ({
      loadSnapshot: base.loadSnapshot,
      saveSnapshot: async (key, snapshot, active): Promise<void> => {
        saved.push(snapshot);
        await base.saveSnapshot(key, snapshot, active);
      },
    }));
    await indexedSearch(current, FIRST);
    const content = saved.filter((snapshot) => snapshot.contentShard !== undefined);
    const matches = saved.filter((snapshot) => snapshot.queryMatchShard !== undefined);
    expect(content.flatMap((snapshot) => snapshot.records)).toHaveLength(FILE_COUNT);
    expect(
      content.flatMap((snapshot) => snapshot.records).every((r) => r.queryMatch === undefined),
    ).toBe(true);
    expect(
      matches.flatMap((snapshot) => snapshot.records).every((r) => r.content === undefined),
    ).toBe(true);
    expect(JSON.stringify(content)).not.toContain("Vesper furnace keeps");
  });
});

function tamperedText(snapshot: WorkspaceIndexSnapshot): WorkspaceIndexSnapshot {
  return {
    ...snapshot,
    records: snapshot.records.map((record) =>
      record.content === undefined
        ? record
        : { ...record, content: { ...record.content, sha256: "0".repeat(64) } },
    ),
  };
}
