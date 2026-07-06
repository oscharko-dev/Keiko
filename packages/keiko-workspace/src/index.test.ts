// Public-surface pin test, mirroring keiko-security/src/index.test.ts and
// keiko-model-gateway/src/index.test.ts. Every symbol that lives on the package's main entry
// point is touched here so a future refactor that accidentally drops a named export — or
// downgrades a value to a type-only re-export — fails this test instead of silently breaking
// a downstream caller.

import { describe, expect, it } from "vitest";
import * as workspace from "./index.js";

describe("keiko-workspace public surface", () => {
  it("exposes the documented barrel members", () => {
    expect(workspace.KEIKO_WORKSPACE_VERSION).toBe("0.2.13");
    expect(typeof workspace.detectWorkspace).toBe("function");
    expect(typeof workspace.discoverFiles).toBe("function");
    expect(typeof workspace.discoverWithStats).toBe("function");
    expect(typeof workspace.readWorkspaceFile).toBe("function");
    expect(typeof workspace.buildContextPack).toBe("function");
    expect(typeof workspace.buildContextPackFromFiles).toBe("function");
    expect(typeof workspace.buildWorkspaceSummary).toBe("function");
    expect(typeof workspace.summarizeForAudit).toBe("function");
    expect(typeof workspace.createWorkspaceIndex).toBe("function");
    expect(typeof workspace.createFileWorkspaceIndexStore).toBe("function");
    expect(typeof workspace.createInMemoryWorkspaceIndexStore).toBe("function");
    expect(typeof workspace.buildWorkspaceIndexScopeKey).toBe("function");
    expect(typeof workspace.buildWorkspaceIndexSnapshot).toBe("function");
    expect(typeof workspace.prepareWorkspaceIndexSnapshot).toBe("function");
    expect(typeof workspace.workspaceIndexCandidateSet).toBe("function");
    expect(typeof workspace.buildImportGraph).toBe("function");
    expect(typeof workspace.buildEndpointContractGraph).toBe("function");
    expect(typeof workspace.normalizeEndpointPath).toBe("function");
    expect(typeof workspace.fuseLexicalAndSemanticRanks).toBe("function");
    expect(typeof workspace.semanticSearchTool).toBe("function");
    expect(typeof workspace.candidateBucketForPath).toBe("function");
    expect(workspace.SEMANTIC_RRF_K).toBe(60);
    expect(typeof workspace.buildSymbolGraph).toBe("function");
    expect(typeof workspace.definitionsForSymbol).toBe("function");
    expect(typeof workspace.referencesForSymbol).toBe("function");
    expect(typeof workspace.callsToSymbol).toBe("function");
    expect(typeof workspace.followSymbolTrace).toBe("function");
    expect(typeof workspace.collectImportSpecifiers).toBe("function");
    expect(typeof workspace.importsFromSource).toBe("function");
    expect(typeof workspace.importersForTarget).toBe("function");
    expect(typeof workspace.endpointContractAdapter).toBe("object");
    expect(typeof workspace.importEdgeStableId).toBe("function");
    expect(typeof workspace.symbolGraphRecordStableId).toBe("function");
    expect(typeof workspace.resolveWithinWorkspace).toBe("function");
    expect(typeof workspace.isWithinWorkspace).toBe("function");
    expect(typeof workspace.compileIgnore).toBe("function");
    expect(typeof workspace.isDenied).toBe("function");
    expect(typeof workspace.isIgnored).toBe("function");
    expect(typeof workspace.lexicalRetrievalStrategy).toBe("object");
    expect(typeof workspace.lexicalRetrievalStrategy.rank).toBe("function");
    expect(typeof workspace.assertContainedRealPath).toBe("function");
    expect(typeof workspace.containedRealPathInfo).toBe("function");
    expect(workspace).not.toHaveProperty("nodeWorkspaceFs");
    expect(workspace.DEFAULT_DENY_PATTERNS).toBeDefined();
    expect(workspace.DEFAULT_CONTEXT_REQUEST).toBeDefined();
    expect(workspace.DEFAULT_DISCOVERY_OPTIONS).toBeDefined();
    expect(workspace.DEFAULT_READ_OPTIONS).toBeDefined();
    expect(workspace.WORKSPACE_INDEX_SNAPSHOT_VERSION).toBe(2);
    expect(workspace.SELECTION_REASON_PRIORITY).toBeDefined();
    expect(workspace.WORKSPACE_CODES).toBeDefined();
    expect(workspace.WorkspaceError).toBeDefined();
    expect(workspace.PathEscapeError).toBeDefined();
    expect(workspace.PathDeniedError).toBeDefined();
    expect(workspace.WorkspaceNotFoundError).toBeDefined();
    expect(workspace.FileTooLargeError).toBeDefined();
    expect(workspace.WorkspaceReadError).toBeDefined();
  });
});
