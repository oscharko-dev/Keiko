// Tests for bounded, deny-checked rehydration (ADR-0053 D5). Builds an in-memory WorkspaceFs +
// SearchScope over synthetic files, proves repo-file/message/evidence/tool refs resolve through
// bounded readers, a content mutation flips invalidated, denied paths degrade without throwing, and
// a notPersistedReason short-circuits without any read.

import { describe, expect, it } from "vitest";

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  type ContextProvenanceRef,
  type ContextRehydrationHandle,
  type ContextToolRehydrationHandle,
} from "@oscharko-dev/keiko-contracts";
import {
  hashExcerptContent,
  type SearchScope,
  type WorkspaceFs,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";

import {
  rehydrateHandle,
  rehydrateProvenanceRef,
  rehydrateToolResultHandle,
} from "./rehydration.js";

const ROOT = "/ws";

function toAbs(rel: string): string {
  return `${ROOT}/${rel}`.replace(/\/+/gu, "/");
}

// Minimal in-memory WorkspaceFs over a flat path->content map (mirrors keiko-workspace/_memfs).
function memFs(files: Readonly<Record<string, string>>): WorkspaceFs {
  const findKey = (absolutePath: string): string | undefined =>
    Object.keys(files).find((key) => toAbs(key) === absolutePath);
  return {
    readFileUtf8: (absolutePath: string): string => {
      const key = findKey(absolutePath);
      if (key === undefined) {
        throw new Error(`ENOENT: ${absolutePath}`);
      }
      return files[key] ?? "";
    },
    stat: (absolutePath: string): WorkspaceStat => {
      const key = findKey(absolutePath);
      if (key === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return {
        size: Buffer.byteLength(files[key] ?? "", "utf8"),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
    },
    readDir: () => [],
    realPath: (absolutePath: string): string => absolutePath,
    exists: (absolutePath: string): boolean =>
      findKey(absolutePath) !== undefined || absolutePath === ROOT,
    readFileBytes: (absolutePath: string, maxBytes: number): Promise<Uint8Array> => {
      const key = findKey(absolutePath);
      if (key === undefined) {
        return Promise.reject(new Error(`ENOENT: ${absolutePath}`));
      }
      const encoded = new TextEncoder().encode(files[key] ?? "");
      return Promise.resolve(encoded.subarray(0, Math.max(0, Math.floor(maxBytes))));
    },
  };
}

function scopeOver(relativePaths: readonly string[]): SearchScope {
  const workspace: WorkspaceInfo = {
    root: ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
  return { workspace, scopeId: "scope-1", relativePaths };
}

const FILE_BODY = ["line one", "line two SENTINEL", "line three", "line four"].join("\n");

function repoRef(
  scopePath: string,
  startLine: number,
  endLine: number,
  contentHash?: string,
): ContextProvenanceRef {
  return {
    kind: "repo-file",
    stableId: "a-ref",
    scopePath,
    lineRange: { startLine, endLine },
    ...(contentHash !== undefined ? { contentHash } : {}),
  };
}

describe("rehydrateProvenanceRef — repo-file", () => {
  it("resolves a repo-file ref and returns the requested excerpt", async () => {
    const fs = memFs({ "src/sample.ts": FILE_BODY });
    const result = await rehydrateProvenanceRef(
      repoRef("src/sample.ts", 2, 2),
      scopeOver(["src"]),
      fs,
    );
    expect(result.resolved).toBe(true);
    expect(result.content).toContain("line two SENTINEL");
  });

  it("flags invalidated:true after the file content changes under a recorded hash", async () => {
    const original = memFs({ "src/sample.ts": FILE_BODY });
    const baseline = await rehydrateProvenanceRef(
      repoRef("src/sample.ts", 2, 2),
      scopeOver(["src"]),
      original,
    );
    const recordedHash = hashExcerptContent(baseline.content ?? "");
    const mutated = memFs({ "src/sample.ts": FILE_BODY.replace("SENTINEL", "CHANGED") });
    const result = await rehydrateProvenanceRef(
      repoRef("src/sample.ts", 2, 2, recordedHash),
      scopeOver(["src"]),
      mutated,
    );
    expect(result.resolved).toBe(true);
    expect(result.invalidated).toBe(true);
  });

  it("reports invalidated:false when the recorded hash still matches", async () => {
    const fs = memFs({ "src/sample.ts": FILE_BODY });
    const baseline = await rehydrateProvenanceRef(
      repoRef("src/sample.ts", 2, 2),
      scopeOver(["src"]),
      fs,
    );
    const recordedHash = hashExcerptContent(baseline.content ?? "");
    const result = await rehydrateProvenanceRef(
      repoRef("src/sample.ts", 2, 2, recordedHash),
      scopeOver(["src"]),
      fs,
    );
    expect(result.invalidated).toBe(false);
  });

  it("degrades to {resolved:false} for a denied path without throwing", async () => {
    const fs = memFs({ ".env": "API_KEY=secret-value" });
    const result = await rehydrateProvenanceRef(repoRef(".env", 1, 1), scopeOver([]), fs);
    expect(result.resolved).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.content).toBeUndefined();
  });

  it("degrades to {resolved:false} for a node_modules path without throwing", async () => {
    const fs = memFs({ "node_modules/pkg/index.js": "module.exports = 1\n" });
    const result = await rehydrateProvenanceRef(
      repoRef("node_modules/pkg/index.js", 1, 1),
      scopeOver([]),
      fs,
    );
    expect(result.resolved).toBe(false);
  });
});

describe("rehydrateProvenanceRef — non-repo-file", () => {
  it("reports a missing artifact reader for a tool-result ref with no IO", async () => {
    const fs = memFs({});
    const ref: ContextProvenanceRef = { kind: "tool-result", stableId: "t-1" };
    const result = await rehydrateProvenanceRef(ref, scopeOver([]), fs);
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("artifact reader unavailable");
  });

  it("resolves a tool-result ref through the injected artifact reader", async () => {
    const fs = memFs({});
    const ref: ContextProvenanceRef = { kind: "tool-result", stableId: "artifact-1" };
    const result = await rehydrateProvenanceRef(ref, scopeOver([]), fs, undefined, {
      toolArtifacts: { read: (artifactId): string | undefined => `full output for ${artifactId}` },
    });
    expect(result.resolved).toBe(true);
    expect(result.content).toBe("full output for artifact-1");
  });

  it("resolves a message ref through the injected message reader and clamps content", async () => {
    const fs = memFs({});
    const ref: ContextProvenanceRef = { kind: "message", stableId: "history-msg-1" };
    const result = await rehydrateProvenanceRef(ref, scopeOver([]), fs, 7, {
      messages: { read: (messageId): string | undefined => `message ${messageId}` },
    });
    expect(result.resolved).toBe(true);
    expect(result.content).toBe("message");
    expect(result.reason).toContain("truncated");
  });

  it("reports a missing message reader without falling back to opaque deferred status", async () => {
    const fs = memFs({});
    const ref: ContextProvenanceRef = { kind: "message", stableId: "history-msg-2" };
    const result = await rehydrateProvenanceRef(ref, scopeOver([]), fs);
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("message reader unavailable");
  });

  it("resolves an evidence-atom ref through the injected evidence atom reader", async () => {
    const fs = memFs({});
    const ref: ContextProvenanceRef = {
      kind: "evidence-atom",
      stableId: "source-span-1",
      evidenceAtomId: "atom-1",
    };
    const result = await rehydrateProvenanceRef(ref, scopeOver([]), fs, undefined, {
      evidenceAtoms: { read: (atomId): string | undefined => `atom payload ${atomId}` },
    });
    expect(result.resolved).toBe(true);
    expect(result.content).toBe("atom payload atom-1");
  });

  it("returns notPersistedReason without reading", async () => {
    const fs = memFs({ "src/sample.ts": FILE_BODY });
    const ref: ContextProvenanceRef = {
      kind: "repo-file",
      stableId: "a-ref",
      scopePath: "src/sample.ts",
      lineRange: { startLine: 1, endLine: 1 },
      notPersistedReason: "redacted at capture",
    };
    const result = await rehydrateProvenanceRef(ref, scopeOver(["src"]), fs);
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe("redacted at capture");
    expect(result.content).toBeUndefined();
  });
});

describe("rehydrateHandle", () => {
  it("resolves a handle carrying kind + scopePath + lineRange", async () => {
    const fs = memFs({ "src/sample.ts": FILE_BODY });
    const handle: ContextRehydrationHandle = {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "repo-evidence",
      handleId: "h-1",
      itemCount: 1,
      approxTokens: 10,
      kind: "repo-file",
      scopePath: "src/sample.ts",
      lineRange: { startLine: 3, endLine: 3 },
    };
    const result = await rehydrateHandle(handle, scopeOver(["src"]), fs);
    expect(result.resolved).toBe(true);
    expect(result.content).toContain("line three");
  });

  it("reports a lane-level handle as not directly rehydratable", async () => {
    const fs = memFs({});
    const handle: ContextRehydrationHandle = {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "repo-evidence",
      handleId: "h-2",
      itemCount: 3,
      approxTokens: 50,
    };
    const result = await rehydrateHandle(handle, scopeOver([]), fs);
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("lane-level");
  });

  it("resolves a tool-result handle through an injected artifact reader", async () => {
    const fs = memFs({});
    const handle: ContextRehydrationHandle = {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "tool-observations",
      handleId: "h-tool",
      itemCount: 1,
      approxTokens: 10,
      kind: "tool-result",
      artifactId: "artifact-2",
    };
    const result = await rehydrateHandle(handle, scopeOver([]), fs, undefined, {
      toolArtifacts: { read: (artifactId): string | undefined => `tool output ${artifactId}` },
    });
    expect(result.resolved).toBe(true);
    expect(result.content).toBe("tool output artifact-2");
  });

  it("resolves an evidence-atom handle through an injected evidence atom reader", async () => {
    const fs = memFs({});
    const handle: ContextRehydrationHandle = {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "verification-evidence",
      handleId: "h-atom",
      itemCount: 1,
      approxTokens: 10,
      kind: "evidence-atom",
      evidenceAtomId: "atom-2",
    };
    const result = await rehydrateHandle(handle, scopeOver([]), fs, undefined, {
      evidenceAtoms: { read: (atomId): string | undefined => `evidence atom ${atomId}` },
    });
    expect(result.resolved).toBe(true);
    expect(result.content).toBe("evidence atom atom-2");
  });

  it("reports a tool-result handle without artifactId as unresolved", async () => {
    const fs = memFs({});
    const handle: ContextRehydrationHandle = {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "tool-observations",
      handleId: "h-tool",
      itemCount: 1,
      approxTokens: 10,
      kind: "tool-result",
    };
    const result = await rehydrateHandle(handle, scopeOver([]), fs, undefined, {
      toolArtifacts: { read: (): string => "unused" },
    });
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("missing artifactId");
  });
});

describe("rehydrateToolResultHandle", () => {
  it("resolves a ContextToolRehydrationHandle and clamps to the rehydration budget", () => {
    const handle: ContextToolRehydrationHandle = {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "tool-observations",
      kind: "tool-result",
      artifactId: "artifact-3",
      itemCount: 1,
      approxTokens: 10,
    };
    const result = rehydrateToolResultHandle(
      handle,
      { toolArtifacts: { read: (): string => "abcdef" } },
      3,
    );
    expect(result.resolved).toBe(true);
    expect(result.content).toBe("abc");
    expect(result.reason).toContain("truncated");
  });

  it("honors notPersistedReason without reading", () => {
    let reads = 0;
    const handle: ContextToolRehydrationHandle = {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "tool-observations",
      kind: "tool-result",
      artifactId: "artifact-4",
      itemCount: 1,
      approxTokens: 10,
      notPersistedReason: "writer unavailable",
    };
    const result = rehydrateToolResultHandle(handle, {
      toolArtifacts: {
        read: (): string => {
          reads += 1;
          return "should not read";
        },
      },
    });
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe("writer unavailable");
    expect(reads).toBe(0);
  });
});
