import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { buildCodeIntelligenceIndexFromCandidates } from "./codeIntelligence.js";
import { buildEndpointContractGraphFromCandidates } from "./endpointContractGraph.js";
import { nodeWorkspaceFs } from "./fs.js";
import type { WorkspaceDescriptorUtf8Read, WorkspaceFs, WorkspaceStat } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, type SearchLimits, type SearchScope } from "./repoSearch.js";
import { gatherCandidates } from "./repoSearchScan.js";
import { createStructuralAdapterRequestContext } from "./structuralAdapterRequestContext.js";

const ROOT = "/source-reuse";
const PATH = "src/Controller.java";
const SOURCE =
  '@RestController\nclass Controller {\n@GetMapping("/before")\npublic String load() { return "ok"; }\n}\n';
const LIMITS: SearchLimits = {
  ...DEFAULT_SEARCH_LIMITS,
  maxFilesScanned: 600,
  elapsedMsMax: null,
};

function scope(root = ROOT): SearchScope {
  return {
    scopeId: "source-reuse",
    relativePaths: [],
    workspace: {
      root,
      selectedRoot: root,
      name: "source-reuse",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: [],
      languages: ["java", "typescript"],
      ignoreLines: [],
    },
  };
}

function measured(files: Record<string, string> = { [PATH]: SOURCE }): {
  readonly fs: WorkspaceFs;
  readonly bodies: string[];
  readonly probes: string[];
  readonly files: Record<string, string>;
} {
  const base = memFs(ROOT, files);
  const bodies: string[] = [];
  const probes: string[] = [];
  return {
    files,
    bodies,
    probes,
    fs: {
      ...base,
      readFileUtf8SameDescriptor: (
        absolute,
        cap,
        hardLinks,
        expected,
      ): WorkspaceDescriptorUtf8Read => {
        bodies.push(absolute);
        const read = base.readFileUtf8SameDescriptor;
        if (read === undefined) throw new TypeError("descriptor fixture unavailable");
        return read(absolute, cap, hardLinks, expected);
      },
      readFileBytes: async (absolute, cap, hardLinks, expected): Promise<Uint8Array> => {
        probes.push(absolute);
        const read = base.readFileBytes;
        if (read === undefined) throw new TypeError("byte fixture unavailable");
        return read(absolute, cap, hardLinks, expected);
      },
    },
  };
}

function withoutStrongIdentity(stat: WorkspaceStat): WorkspaceStat {
  return {
    size: stat.size,
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    isSymbolicLink: stat.isSymbolicLink,
    hardLinkCount: stat.hardLinkCount,
  };
}

describe("complete request-local code-to-endpoint source reuse", () => {
  it("reads a complete descriptor body once while retaining the live endpoint binary probe", async () => {
    const fixture = measured();
    const selected = scope();
    const candidates = gatherCandidates(selected, LIMITS, fixture.fs);
    const expectedCode = buildCodeIntelligenceIndexFromCandidates(
      selected,
      LIMITS,
      fixture.fs,
      candidates,
      { disableCache: true },
    );
    const expectedEndpoint = await buildEndpointContractGraphFromCandidates(
      selected,
      LIMITS,
      fixture.fs,
      candidates,
    );
    fixture.bodies.length = 0;
    fixture.probes.length = 0;
    const context = createStructuralAdapterRequestContext(selected, LIMITS, fixture.fs);
    expect(await context.codeIntelligenceIndex()).toEqual(expectedCode);
    expect(await context.endpointContractGraph()).toEqual(expectedEndpoint);
    expect(fixture.bodies).toEqual([`${ROOT}/${PATH}`]);
    expect(fixture.probes).toEqual([`${ROOT}/${PATH}`]);
    expect(context.diagnostics()).toMatchObject({
      codeIndexBuildCount: 1,
      endpointGraphBuildCount: 1,
    });
  });

  it("retains the first 512 complete sources across an ordered scan larger than the bound", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 520 }, (_, index) => [
        `src/Controller${String(index).padStart(3, "0")}.java`,
        SOURCE,
      ]),
    );
    const fixture = measured(files);
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fixture.fs);
    await context.codeIntelligenceIndex();
    await context.endpointContractGraph();
    expect(fixture.bodies).toHaveLength(528);
    expect(fixture.bodies.filter((path) => path.endsWith("Controller000.java"))).toHaveLength(1);
    expect(fixture.bodies.filter((path) => path.endsWith("Controller519.java"))).toHaveLength(2);
    expect(fixture.probes).toHaveLength(520);
  });

  it("does not retain a source above the existing 64 KiB complete-preview ceiling", async () => {
    const fixture = measured({ [PATH]: SOURCE + " ".repeat(65_536) });
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fixture.fs);
    await context.codeIntelligenceIndex();
    await context.endpointContractGraph();
    expect(fixture.bodies).toHaveLength(2);
  });

  it("rereads a source changed between the two consumers", async () => {
    const fixture = measured();
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fixture.fs);
    await context.codeIntelligenceIndex();
    fixture.files[PATH] = SOURCE.replace("/before", "/after");
    const graph = await context.endpointContractGraph();
    expect(graph.routes.map((route) => route.path)).toEqual(["/after"]);
    expect(fixture.bodies).toHaveLength(2);
  });

  it("keeps weak metadata on the original live-read fallback", async () => {
    const fixture = measured();
    const fs: WorkspaceFs = {
      ...fixture.fs,
      stat: (absolute): WorkspaceStat => withoutStrongIdentity(fixture.fs.stat(absolute)),
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs);
    await context.codeIntelligenceIndex();
    await context.endpointContractGraph();
    expect(fixture.bodies).toHaveLength(2);
  });

  it("never carries source text to an independent request context", async () => {
    const fixture = measured();
    await createStructuralAdapterRequestContext(
      scope(),
      LIMITS,
      fixture.fs,
    ).codeIntelligenceIndex();
    await createStructuralAdapterRequestContext(
      scope(),
      LIMITS,
      fixture.fs,
    ).endpointContractGraph();
    expect(fixture.bodies).toHaveLength(2);
  });
  it("does not lend a code-index read to a smaller endpoint byte grant", async () => {
    const fixture = measured({ [PATH]: SOURCE + " ".repeat(400) });
    const limited = { ...LIMITS, maxBytesPerFileScanned: 256 };
    const context = createStructuralAdapterRequestContext(scope(), limited, fixture.fs);
    await context.codeIntelligenceIndex();
    const graph = await context.endpointContractGraph();
    expect(graph.routes).toEqual([]);
    expect(graph.diagnostics.filesSkipped).toBe(1);
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.probes).toHaveLength(1);
  });

  it("preserves physical lines after multiline secret redaction", async () => {
    const secret =
      "// -----BEGIN PRIVATE KEY-----\n// inert-fixture\n// -----END PRIVATE KEY-----\n";
    const fixture = measured({ [PATH]: secret + SOURCE });
    const selected = scope();
    const expected = await buildEndpointContractGraphFromCandidates(
      selected,
      LIMITS,
      fixture.fs,
      gatherCandidates(selected, LIMITS, fixture.fs),
    );
    fixture.bodies.length = 0;
    const context = createStructuralAdapterRequestContext(selected, LIMITS, fixture.fs);
    await context.codeIntelligenceIndex();
    expect(await context.endpointContractGraph()).toEqual(expected);
    expect(expected.routes[0]?.line).toBe(6);
    expect(fixture.bodies).toHaveLength(1);
  });

  it("does not reuse a removed source", async () => {
    const fixture = measured();
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fixture.fs);
    await context.codeIntelligenceIndex();
    delete fixture.files["src/Controller.java"];
    const graph = await context.endpointContractGraph();
    expect(graph.routes).toEqual([]);
    expect(graph.diagnostics.filesSkipped).toBe(1);
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.probes).toHaveLength(0);
  });

  it.each(["escape", "denied"] as const)(
    "rejects a changed canonical %s alias before any endpoint body or probe",
    async (kind) => {
      const fixture = measured();
      let changed = false;
      const fs: WorkspaceFs = {
        ...fixture.fs,
        realPath: (absolute): string =>
          changed && absolute === `${ROOT}/${PATH}`
            ? kind === "escape"
              ? "/outside/Controller.java"
              : `${ROOT}/.env`
            : fixture.fs.realPath(absolute),
      };
      const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs);
      await context.codeIntelligenceIndex();
      changed = true;
      expect((await context.endpointContractGraph()).routes).toEqual([]);
      expect(fixture.bodies).toHaveLength(1);
      expect(fixture.probes).toHaveLength(0);
    },
  );

  it("rejects a hard-link replacement before any endpoint body or probe", async () => {
    const fixture = measured();
    let changed = false;
    const fs: WorkspaceFs = {
      ...fixture.fs,
      stat: (absolute): WorkspaceStat => ({
        ...fixture.fs.stat(absolute),
        ...(changed && absolute.endsWith(PATH) ? { hardLinkCount: 2 } : {}),
      }),
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs);
    await context.codeIntelligenceIndex();
    changed = true;
    expect((await context.endpointContractGraph()).routes).toEqual([]);
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.probes).toHaveLength(0);
  });

  it("rechecks dynamic eligibility after an endpoint stat and before its binary probe", async () => {
    const fixture = measured();
    let endpoint = false;
    let allowed = true;
    const fs: WorkspaceFs = {
      ...fixture.fs,
      stat: (absolute): WorkspaceStat => {
        const stat = fixture.fs.stat(absolute);
        if (endpoint && absolute.endsWith(PATH)) allowed = false;
        return stat;
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs, {
      isCandidateAllowed: () => allowed,
    });
    await context.codeIntelligenceIndex();
    endpoint = true;
    expect((await context.endpointContractGraph()).routes).toEqual([]);
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.probes).toHaveLength(0);
  });

  it("keeps an abort during the live binary probe from accepting cached text", async () => {
    const fixture = measured();
    const abort = new AbortController();
    const fs: WorkspaceFs = {
      ...fixture.fs,
      readFileBytes: async (absolute, cap, hardLinks, expected): Promise<Uint8Array> => {
        const read = fixture.fs.readFileBytes;
        if (read === undefined) throw new TypeError("byte fixture unavailable");
        const bytes = await read(absolute, cap, hardLinks, expected);
        abort.abort();
        return bytes;
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs, {
      signal: abort.signal,
    });
    await context.codeIntelligenceIndex();
    const graph = await context.endpointContractGraph();
    expect(graph.routes).toEqual([]);
    expect(graph.diagnostics.candidateLimitReached).toBe(true);
    expect(fixture.bodies).toHaveLength(1);
  });

  it("rechecks expiry after final live metadata validation", async () => {
    const fixture = measured();
    let now = 0;
    let endpoint = false;
    let endpointStats = 0;
    const fs: WorkspaceFs = {
      ...fixture.fs,
      stat: (absolute): WorkspaceStat => {
        const stat = fixture.fs.stat(absolute);
        if (endpoint && absolute.endsWith(PATH) && ++endpointStats === 5) now = 10;
        return stat;
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs, {
      nowMs: () => now,
      deadlineAtMs: 10,
    });
    await context.codeIntelligenceIndex();
    endpoint = true;
    const graph = await context.endpointContractGraph();
    expect(graph.routes).toEqual([]);
    expect(graph.diagnostics.candidateLimitReached).toBe(true);
    expect(fixture.bodies).toHaveLength(1);
  });

  it("falls back to a fresh complete read when the final cache validation observes mutation", async () => {
    const fixture = measured();
    let endpoint = false;
    let endpointStats = 0;
    const fs: WorkspaceFs = {
      ...fixture.fs,
      stat: (absolute): WorkspaceStat => {
        if (endpoint && absolute.endsWith(PATH) && ++endpointStats === 5)
          fixture.files[PATH] = SOURCE.replace("/before", "/after");
        return fixture.fs.stat(absolute);
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs);
    await context.codeIntelligenceIndex();
    endpoint = true;
    expect((await context.endpointContractGraph()).routes.map((route) => route.path)).toEqual([
      "/after",
    ]);
    expect(fixture.bodies).toHaveLength(2);
  });

  it("binds root and scope snapshots and refuses a mutated external binding", async () => {
    const fixture = measured();
    const selected = scope();
    const context = createStructuralAdapterRequestContext(selected, LIMITS, fixture.fs);
    await context.codeIntelligenceIndex();
    const otherRoot = scope("/other-root");
    expect(() => {
      context.assertGraphBinding(otherRoot, LIMITS, fixture.fs);
    }).toThrow(TypeError);
    expect(() => {
      context.assertGraphBinding({ ...selected, relativePaths: ["src"] }, LIMITS, fixture.fs);
    }).toThrow(TypeError);
    expect(() => {
      context.assertGraphBinding(selected, { ...LIMITS, maxBytesPerFileScanned: 64 }, fixture.fs);
    }).toThrow(TypeError);
    expect(() => {
      context.assertGraphBinding(selected, LIMITS, memFs(ROOT, { [PATH]: SOURCE }));
    }).toThrow(TypeError);
    expect(fixture.bodies).toHaveLength(1);
  });

  it("reuses an actual complete Node descriptor read, then rejects its replacement identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-structural-source-"));
    const absolute = join(root, PATH);
    mkdirSync(join(root, "src"));
    writeFileSync(absolute, SOURCE);
    const bodies: string[] = [];
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileUtf8SameDescriptor: (path, cap, hardLinks, expected): WorkspaceDescriptorUtf8Read => {
        bodies.push(path);
        const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
        if (read === undefined) throw new TypeError("native descriptor reader unavailable");
        return read(path, cap, hardLinks, expected);
      },
    };
    try {
      const first = createStructuralAdapterRequestContext(scope(root), LIMITS, fs);
      await first.codeIntelligenceIndex();
      expect((await first.endpointContractGraph()).routes.map((route) => route.path)).toEqual([
        "/before",
      ]);
      expect(bodies).toHaveLength(1);
      const second = createStructuralAdapterRequestContext(scope(root), LIMITS, fs);
      await second.codeIntelligenceIndex();
      renameSync(absolute, `${absolute}.old`);
      writeFileSync(absolute, SOURCE.replace("/before", "/after"));
      expect((await second.endpointContractGraph()).routes.map((route) => route.path)).toEqual([
        "/after",
      ]);
      expect(bodies).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the oversized partial code prefix and never promotes it to complete endpoint evidence", async () => {
    const fixture = measured({ [PATH]: SOURCE + " ".repeat(2_097_152) });
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fixture.fs);
    const code = await context.codeIntelligenceIndex();
    const graph = await context.endpointContractGraph();
    expect(code.filesPartiallyIndexed).toBe(1);
    expect(graph.routes).toEqual([]);
    expect(graph.diagnostics.filesSkipped).toBe(1);
    expect(fixture.bodies).toHaveLength(0);
  });

  it("does not stamp a stale ranking preview with a newer complete-source identity", async () => {
    const fixture = measured({
      "src/a.ts": "export const decoy = 1;",
      "src/z.ts": "export const oldTerm = 1;",
    });
    const full = { ...LIMITS, maxFilesScanned: 2 };
    const narrow = { ...full, maxFilesScanned: 1 };
    const context = createStructuralAdapterRequestContext(scope(), full, fixture.fs);
    const query = (
      text: string,
    ): import("@oscharko-dev/keiko-contracts/connected-context").RetrievalQuery => ({
      kind: "exact-symbol",
      text,
      caseSensitive: true,
      maxResults: 10,
      emittedAtMs: 0,
    });
    expect(
      (await context.searchText(query("oldTerm"), narrow)).atoms.map((atom) => atom.scopePath),
    ).toEqual(["src/z.ts"]);
    expect(fixture.bodies).toHaveLength(2);
    fixture.files["src/z.ts"] = "export const freshTerm = 2;";
    await context.codeIntelligenceIndex();
    expect(
      (await context.searchText(query("fresh"), narrow)).atoms.map((atom) => atom.scopePath),
    ).toEqual(["src/z.ts"]);
    expect((await context.searchText(query("oldTerm"), narrow)).atoms).toEqual([]);
  });
  it("does not populate unused lexical previews from complete-source-only records", async () => {
    const fixture = measured({
      "src/a.ts": "export const decoy = 1;",
      "src/z.ts": "export const other = 2;",
    });
    const full = { ...LIMITS, maxFilesScanned: 2 };
    const narrow = { ...full, maxFilesScanned: 1 };
    const context = createStructuralAdapterRequestContext(scope(), full, fixture.fs);
    await context.codeIntelligenceIndex();
    expect(fixture.bodies).toHaveLength(2);
    const query: import("@oscharko-dev/keiko-contracts/connected-context").RetrievalQuery = {
      kind: "regex",
      text: "^absent$",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: 0,
    };
    expect((await context.searchText(query, narrow)).atoms).toEqual([]);
    expect((await context.searchText(query, narrow)).atoms).toEqual([]);
    expect(fixture.bodies).toHaveLength(2);
  });

  it("does not retain endpoint-only reads for a later code-index consumer", async () => {
    const fixture = measured();
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fixture.fs);
    await context.endpointContractGraph();
    await context.codeIntelligenceIndex();
    expect(fixture.bodies).toHaveLength(2);
    expect(fixture.probes).toHaveLength(1);
  });

  it("does not retain a read whose descriptor lacks strong identity metadata", async () => {
    const fixture = measured();
    const fs: WorkspaceFs = {
      ...fixture.fs,
      readFileUtf8SameDescriptor: (
        absolute,
        cap,
        hardLinks,
        expected,
      ): WorkspaceDescriptorUtf8Read => {
        const read = fixture.fs.readFileUtf8SameDescriptor;
        if (read === undefined) throw new TypeError("descriptor fixture unavailable");
        const result = read(absolute, cap, hardLinks, expected);
        return { ...result, stat: withoutStrongIdentity(result.stat) };
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs);
    await context.codeIntelligenceIndex();
    await context.endpointContractGraph();
    expect(fixture.bodies).toHaveLength(2);
  });
  it("does not retain a short descriptor result as complete source evidence", async () => {
    const fixture = measured();
    let reads = 0;
    const fs: WorkspaceFs = {
      ...fixture.fs,
      readFileUtf8SameDescriptor: (
        absolute,
        cap,
        hardLinks,
        expected,
      ): WorkspaceDescriptorUtf8Read => {
        const read = fixture.fs.readFileUtf8SameDescriptor;
        if (read === undefined) throw new TypeError("descriptor fixture unavailable");
        const result = read(absolute, cap, hardLinks, expected);
        return ++reads === 1 ? { ...result, rawText: "// short read", sizeBytes: 13 } : result;
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs);
    await context.codeIntelligenceIndex();
    expect((await context.endpointContractGraph()).routes.map((route) => route.path)).toEqual([
      "/before",
    ]);
    expect(fixture.bodies).toHaveLength(2);
  });

  it("checks dynamic eligibility again at the actual complete descriptor boundary", async () => {
    const fixture = measured();
    let denyOnNextStat = false;
    let allowed = true;
    const fs: WorkspaceFs = {
      ...fixture.fs,
      stat: (absolute): WorkspaceStat => {
        const stat = fixture.fs.stat(absolute);
        if (denyOnNextStat && absolute.endsWith(PATH)) allowed = false;
        return stat;
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), LIMITS, fs, {
      isCandidateAllowed: () => allowed,
    });
    expect(context.candidatePaths()).toEqual([PATH]);
    fixture.bodies.length = 0;
    denyOnNextStat = true;
    const code = await context.codeIntelligenceIndex();
    expect(code.filesIndexed).toBe(0);
    expect(fixture.bodies).toHaveLength(0);
  });
});
