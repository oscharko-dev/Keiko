import { describe, expect, it } from "vitest";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  RetrievalQuery,
  SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { admitExplicitPaths, explicitPathReferences } from "./grounded-explicit-paths.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const ROOT = "/admission-documents";
const workspace: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "admission documents",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};
const scope: SelectedScope = {
  schemaVersion: "1",
  scopeId: "admission-documents",
  workspaceRoot: ROOT,
  kind: "workspace-root",
  relativePaths: [],
  conversationId: undefined,
  connectedAtMs: 1,
  explicitConnection: true,
};
function query(text: string): RetrievalQuery {
  return {
    kind: "natural-language" as const,
    text,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1,
  };
}
function admit(text: string, fs: WorkspaceFs): ReturnType<typeof admitExplicitPaths> {
  return admitExplicitPaths({
    scope,
    query: query(text),
    searchScope: { workspace, scopeId: scope.scopeId, relativePaths: [] },
    fs,
    nowMs: () => 1,
    deadlineAtMs: 1000,
    signal: undefined,
    tryReserveSearchCall: () => true,
  });
}

describe("explicit admission preserves bounded document and filesystem semantics", () => {
  it("continues after an expected stat disappearance and admits another file", async () => {
    const base = memFs(ROOT, {
      "src/vanished.ts": "export const vanished = true;",
      "src/healthy.ts": "export const healthy = true;",
    });
    const fs: WorkspaceFs = {
      ...base,
      stat: (path) => {
        if (path.endsWith("vanished.ts"))
          throw Object.assign(new Error("private vanished body"), { code: "ENOENT" });
        return base.stat(path);
      },
    };
    const result = await admit("Explain src/vanished.ts and src/healthy.ts", fs);
    expect(result.selections.map((entry) => entry.path)).toContain("src/healthy.ts");
    expect(result.observation).toMatchObject({
      explicitPathRejectedCount: 1,
      explicitPathRejectionReasons: ["missing"],
    });
  });
  it.each(["docx", "xlsx"])(
    "discovers a named %s container from metadata without text admission",
    async (extension) => {
      const path = `docs/report.${extension}`;
      const result = await admit(
        `Explain report.${extension}`,
        memFs(ROOT, { [path]: "PK\u0003\u0004\u0000\u0000binary container" }),
      );
      expect(result.selections.map((entry) => entry.path)).toContain(path);
      expect(result.observation).toMatchObject({
        basenameDiscoveryTermCount: 1,
        basenameDiscoveryMatchCount: 1,
        explicitPathAdmittedCount: 1,
      });
    },
  );
  it("retains an ordinary text file with a legacy document suffix in code retrieval", async () => {
    const output = await retrieveConnectedContextPack(
      { workspaceRoot: ROOT, scope, query: query("Explain plainMarker") },
      {
        correlationId: "plain-document-admission",
        fs: memFs(ROOT, { "src/plain.doc": "export const plainMarker = 73;\n" }),
        detectWorkspace: () => workspace,
        nowMs: () => 1,
        answerer: { answer: () => Promise.resolve("") },
      },
    );
    expect(output.pack.files.map((file) => file.scopePath)).toContain("src/plain.doc");
    expect(output.pack.files[0]?.excerpts[0]?.content).toContain("plainMarker");
  });
  it.each(["validation.ts:301:5", "`validation.ts:301:5`"])(
    "normalizes bare located filename %s without losing its line",
    (text) => {
      expect(explicitPathReferences(text)).toEqual([
        { path: "validation.ts", line: 301, origin: "query" },
      ]);
    },
  );
});
