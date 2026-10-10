import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { buildCodeIntelligenceIndexFromCandidates } from "./codeIntelligence.js";
import { buildEndpointContractGraphFromCandidates } from "./endpointContractGraph.js";
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
});
