// Tests for bounded, deny-checked rehydration (ADR-0053 D5). Builds an in-memory WorkspaceFs +
// SearchScope over synthetic files, proves a repo-file ref resolves, a content mutation flips
// invalidated, a denied path degrades to {resolved:false} without throwing, a deferred kind is
// reported, and a notPersistedReason short-circuits without any read.

import { describe, expect, it } from "vitest";

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  type ContextProvenanceRef,
  type ContextRehydrationHandle,
} from "@oscharko-dev/keiko-contracts";
import {
  hashExcerptContent,
  type SearchScope,
  type WorkspaceFs,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";

import { rehydrateHandle, rehydrateProvenanceRef } from "./rehydration.js";

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
  it("returns a deferred result for a tool-result ref with no IO", async () => {
    const fs = memFs({});
    const ref: ContextProvenanceRef = { kind: "tool-result", stableId: "t-1" };
    const result = await rehydrateProvenanceRef(ref, scopeOver([]), fs);
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("tool-result");
    expect(result.reason).toContain("deferred");
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
});
