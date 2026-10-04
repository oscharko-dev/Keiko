import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFiles, DEFAULT_SEARCH_LIMITS } from "./repoSearch.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { createStructuralAdapterRequestContext } from "./structuralAdapterRequestContext.js";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchScope } from "./repoSearch.js";

let root = "";
let outside = "";
const limits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 96 };
const query: RetrievalQuery = {
  kind: "file-pattern",
  text: "**/*",
  caseSensitive: false,
  maxResults: 96,
  emittedAtMs: 0,
};

function scope(): SearchScope {
  return {
    scopeId: "grouped-files",
    relativePaths: [],
    workspace: {
      root,
      selectedRoot: root,
      name: "grouped-files",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}

function groups(patterns: readonly string[]): {
  readonly patterns: readonly string[];
  readonly maxMatchesPerPattern: number;
} {
  return { patterns, maxMatchesPerPattern: 96 };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-grouped-listing-"));
  outside = mkdtempSync(join(tmpdir(), "keiko-grouped-listing-outside-"));
  for (let index = 0; index < 110; index += 1) {
    const dir = join(root, String(index).padStart(3, "0"));
    mkdirSync(dir);
    writeFileSync(join(dir, "FairAlphaProbe.ts"), "export const value = 73;\n");
  }
  mkdirSync(join(root, "zzzz"));
  writeFileSync(join(root, "zzzz/FairBetaProbe.ts"), "export const value = 91;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("trusted grouped filename listings", () => {
  it("retains late targets fairly with one traversal, bounded output and overlapping patterns", async () => {
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new TypeError("Native iteration is required.");
    let rootIterations = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        if (path === realpathSync(root)) rootIterations += 1;
        yield* iterate(path);
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), limits, fs, {});
    const result = await context.findFiles(query, limits, {
      filePatternGroups: groups([
        "**/fairalphaprobe.*",
        "**/FairAlphaProbe.*",
        "**/fairbetaprobe.*",
      ]),
    });
    expect(result.atoms.some((atom) => atom.scopePath === "zzzz/FairBetaProbe.ts")).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath.endsWith("/FairAlphaProbe.ts"))).toBe(true);
    expect(result.atoms).toHaveLength(96);
    expect(new Set(result.atoms.map((atom) => atom.stableId)).size).toBe(96);
    expect(result.coverage.filesScanned).toBe(111);
    expect(result.coverage.reasons).toEqual(["match-cap"]);
    expect(rootIterations).toBe(1);
    expect(context.diagnostics().fileSearchCount).toBe(1);
    expect(context.diagnostics().candidateInventoryBuildCount).toBe(0);
  });

  it("closes streamed directories when grouped discovery is cancelled", async () => {
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new TypeError("Native iteration is required.");
    const controller = new AbortController();
    let opened = 0;
    let closed = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        opened += 1;
        try {
          for await (const entry of iterate(path)) {
            controller.abort();
            yield entry;
          }
        } finally {
          closed += 1;
        }
      },
    };
    const result = await findFiles(scope(), query, limits, {
      fs,
      signal: controller.signal,
      filePatternGroups: groups(["**/FairBetaProbe.*"]),
    });
    expect(result.coverage.reasons).toEqual(["aborted"]);
    expect(result.coverage.incomplete).toBe(true);
    expect(result.atoms).toHaveLength(0);
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
  });

  it("binds evidence fingerprints to the actual filename groups", async () => {
    const a = await findFiles(scope(), query, limits, {
      filePatternGroups: groups(["**/FairAlphaProbe.*"]),
    });
    const b = await findFiles(scope(), query, limits, {
      filePatternGroups: groups(["**/FairAlphaProbe.*", "**/FairBetaProbe.*"]),
    });
    expect(a.atoms[0]?.provenance.queryFingerprint).not.toBe(
      b.atoms[0]?.provenance.queryFingerprint,
    );
  });

  it("keeps sensitive paths, aliases, hardlinks and decoded binary files outside grouped evidence", async () => {
    writeFileSync(join(outside, "AliasProbe.ts"), "export const value = 123;\n");
    symlinkSync(join(outside, "AliasProbe.ts"), join(root, "AliasProbe.ts"));
    linkSync(join(outside, "AliasProbe.ts"), join(root, "HardlinkProbe.ts"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git/SensitiveProbe.ts"), "export const value = 456;\n");
    writeFileSync(join(root, "BinaryProbe.ts"), Buffer.from("header\n\u0000binary tail"));
    const result = await findFiles(scope(), query, limits, {
      filePatternGroups: groups(["**/*Probe.ts"]),
    });
    expect(
      result.atoms.some((atom) => /(?:Alias|Hardlink|Sensitive|Binary)Probe/.test(atom.scopePath)),
    ).toBe(false);
  });

  it.each(["REJECTED_CALLBACK_CONTENT_MUST_STAY_PRIVATE", undefined])(
    "fails closed for a malformed matcher rejection %s without exposing its value",
    async (unexpected) => {
      const test = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (
        this: RegExp,
        value: string,
      ): boolean {
        if (this.source.includes("FairBetaProbe") && value.endsWith("FairBetaProbe.ts")) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberately malformed callback tests the collector's Error boundary.
          throw unexpected;
        }
        return this.exec(value) !== null;
      });
      try {
        await expect(
          findFiles(scope(), query, limits, {
            filePatternGroups: groups(["**/FairBetaProbe.*"]),
          }),
        ).rejects.toSatisfy(
          (error: unknown): boolean =>
            error instanceof Error &&
            error.name === "WorkspaceReadError" &&
            !error.message.includes("REJECTED_CALLBACK_CONTENT_MUST_STAY_PRIVATE"),
        );
      } finally {
        test.mockRestore();
      }
    },
  );

  it("rejects unbounded group inputs before filesystem work", async () => {
    let touches = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      stat: (path) => {
        touches += 1;
        return nodeWorkspaceFs.stat(path);
      },
    };
    await expect(
      findFiles(scope(), query, limits, {
        fs,
        filePatternGroups: groups(Array.from({ length: 9 }, () => "**/*")),
      }),
    ).rejects.toThrow("invalid internal filename group bounds");
    expect(touches).toBe(0);
  });
});
