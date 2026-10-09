import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceFs, WorkspaceInfo, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { SearchReference } from "@oscharko-dev/keiko-workflows";
import { admitExplicitPaths } from "./grounded-explicit-paths.js";

const TARGET = "src/locations.ts";
const CONTENT = Array.from(
  { length: 60 },
  (_, index) => `export const physicalFact${String(index)} = ${String(index)};`,
).join("\n");
let root = "";
let outside = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-explicit-classification-"));
  outside = mkdtempSync(join(tmpdir(), "keiko-explicit-outside-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, TARGET), CONTENT);
  writeFileSync(join(outside, "private.ts"), "PRIVATE_OUTSIDE_CONTENT");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface ClassificationFixture {
  readonly readFileBytes: Mock<NonNullable<WorkspaceFs["readFileBytes"]>>;
  readonly reserve: Mock<() => boolean>;
  readonly request: Parameters<typeof admitExplicitPaths>[0] & {
    readonly references: readonly SearchReference[];
  };
}

function inputs(count: number): ClassificationFixture {
  const readFileBytes = vi.fn<NonNullable<WorkspaceFs["readFileBytes"]>>(
    nodeWorkspaceFs.readFileBytes,
  );
  const reserve = vi.fn(() => true);
  const workspace: WorkspaceInfo = {
    root,
    selectedRoot: root,
    name: "explicit classification fixture",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
  const scope: SelectedScope = {
    schemaVersion: "1",
    scopeId: "classification",
    workspaceRoot: root,
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: 1,
  };
  return {
    readFileBytes,
    reserve,
    request: {
      scope,
      searchScope: { workspace, scopeId: scope.scopeId, relativePaths: [] },
      query: {
        kind: "natural-language" as const,
        text: "Explain the physical facts",
        caseSensitive: false,
        maxResults: 100,
        emittedAtMs: 1,
      },
      references: Array.from({ length: count }, (_, index): SearchReference => ({
        path: TARGET,
        line: (index + 1) * 10,
        origin: "diagnostic",
      })),
      fs: { ...nodeWorkspaceFs, readFileBytes },
      nowMs: (): number => 1,
      deadlineAtMs: 1_001,
      signal: undefined as AbortSignal | undefined,
      tryReserveSearchCall: reserve,
    },
  };
}

function afterFirstReference(change: () => void): readonly SearchReference[] {
  const references: SearchReference[] = [
    { path: TARGET, line: 10, origin: "diagnostic" },
    { path: TARGET, line: 20, origin: "diagnostic" },
  ];
  Object.defineProperty(references, "1", {
    get: (): SearchReference => {
      change();
      return { path: TARGET, line: 20, origin: "diagnostic" };
    },
  });
  return references;
}

describe("request-local repeated-location eligibility classification", () => {
  it.each([1, 3, 6])(
    "classifies one physical file once for %i distinct line hints",
    async (count) => {
      const fixture = inputs(count);
      const result = await admitExplicitPaths(fixture.request);
      expect(result.selections.map((reference) => reference.line)).toEqual(
        fixture.request.references.map((reference) => reference.line),
      );
      expect(result.observation).toMatchObject({
        explicitPathAnchorCount: count,
        explicitPathAdmittedCount: 1,
        explicitLineHintCount: count,
        explicitPathRejectedCount: 0,
      });
      expect(fixture.readFileBytes).toHaveBeenCalledTimes(1);
      expect(fixture.reserve).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps all distinct locations within one actual classification grant", async () => {
    const fixture = inputs(6);
    fixture.reserve.mockImplementationOnce(() => true).mockImplementation(() => false);
    const result = await admitExplicitPaths(fixture.request);
    expect(result.selections).toHaveLength(6);
    expect(result.omitted).toEqual([]);
    expect(fixture.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it("reclassifies a same-size file replacement before reusing eligibility", async () => {
    const fixture = inputs(2);
    const references = afterFirstReference(() => {
      writeFileSync(join(root, TARGET), Buffer.alloc(Buffer.byteLength(CONTENT)));
    });
    const result = await admitExplicitPaths({ ...fixture.request, references });
    expect(result.selections.map((reference) => reference.line)).toEqual([10]);
    expect(result.observation.explicitPathRejectionReasons).toEqual(["binary"]);
    expect(fixture.reserve).toHaveBeenCalledTimes(2);
    expect(fixture.readFileBytes.mock.calls.length).toBeGreaterThan(1);
  });

  it.each(["missing", "outside-scope"] as const)(
    "does not reuse a replaced path that is %s",
    async (reason) => {
      const fixture = inputs(2);
      const references = afterFirstReference(() => {
        unlinkSync(join(root, TARGET));
        if (reason === "outside-scope")
          symlinkSync(join(outside, "private.ts"), join(root, TARGET));
      });
      const result = await admitExplicitPaths({ ...fixture.request, references });
      expect(result.selections.map((reference) => reference.line)).toEqual([10]);
      expect(result.observation.explicitPathRejectionReasons).toEqual([reason]);
      expect(fixture.readFileBytes).toHaveBeenCalledTimes(1);
      expect(fixture.reserve).toHaveBeenCalledTimes(1);
    },
  );

  it("never shares eligibility with a later request or another selected scope", async () => {
    const fixture = inputs(3);
    await admitExplicitPaths(fixture.request);
    fixture.reserve.mockClear();
    fixture.readFileBytes.mockClear();
    const scope: SelectedScope = {
      ...fixture.request.scope,
      kind: "directory",
      relativePaths: ["other"],
    };
    const result = await admitExplicitPaths({ ...fixture.request, scope });
    expect(result.selections).toEqual([]);
    expect(result.observation.explicitPathRejectionReasons).toEqual(["outside-scope"]);
    expect(fixture.reserve).not.toHaveBeenCalled();
    expect(fixture.readFileBytes).not.toHaveBeenCalled();
    await admitExplicitPaths(fixture.request);
    expect(fixture.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it("retains fresh classification when the filesystem cannot prove stable file identity", async () => {
    const fixture = inputs(3);
    const base = memFs(root, { [TARGET]: CONTENT });
    const readFileBytes = vi.fn(base.readFileBytes);
    const stat = (path: string): WorkspaceStat => {
      const observed = base.stat(path);
      return {
        size: observed.size,
        isFile: observed.isFile,
        isDirectory: observed.isDirectory,
        isSymbolicLink: observed.isSymbolicLink,
        hardLinkCount: observed.hardLinkCount,
      };
    };
    const result = await admitExplicitPaths({
      ...fixture.request,
      fs: { ...base, readFileBytes, stat },
    });
    expect(result.selections).toHaveLength(3);
    expect(fixture.reserve).toHaveBeenCalledTimes(3);
    expect(readFileBytes).toHaveBeenCalledTimes(3);
  });

  it("revalidates selected membership after an in-request scope narrowing", async () => {
    const fixture = inputs(2);
    const relativePaths = ["src"];
    const scope: SelectedScope = { ...fixture.request.scope, kind: "directory", relativePaths };
    const references = afterFirstReference(() => {
      relativePaths.splice(0, 1, "other");
    });
    const result = await admitExplicitPaths({ ...fixture.request, scope, references });
    expect(result.selections.map((reference) => reference.line)).toEqual([10]);
    expect(result.observation.explicitPathRejectionReasons).toEqual(["outside-scope"]);
    expect(fixture.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "deadline"])(
    "stops before any subsequent metadata or read on %s",
    async (stop) => {
      const fixture = inputs(2);
      const controller = new AbortController();
      let now = 1;
      const stat = vi.fn(nodeWorkspaceFs.stat);
      let completedStats = 0;
      const references = afterFirstReference(() => {
        completedStats = stat.mock.calls.length;
        if (stop === "abort") controller.abort();
        else now = 1_001;
      });
      const result = await admitExplicitPaths({
        ...fixture.request,
        references,
        signal: controller.signal,
        nowMs: (): number => now,
        fs: { ...fixture.request.fs, stat },
      });
      expect(result.selections.map((reference) => reference.line)).toEqual([10]);
      expect(stat).toHaveBeenCalledTimes(completedStats);
      expect(fixture.readFileBytes).toHaveBeenCalledTimes(1);
      expect(fixture.reserve).toHaveBeenCalledTimes(1);
    },
  );
});
