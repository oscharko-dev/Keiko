import { describe, expect, it } from "vitest";

import {
  DEFAULT_PATCH_SCOPE_LIMITS,
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  type WorkflowHandoffRequest,
} from "@oscharko-dev/keiko-contracts/workflow-handoff";
import { resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import type { WorkspaceWriter } from "@oscharko-dev/keiko-tools";

import { createScopedWriter, governedPatchRejectionCode } from "./governed-handoff.js";

const WORKSPACE_ROOT = "/repo";

function handoff(): WorkflowHandoffRequest {
  return {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    contextPackStableId: "pl-0123456789abcdef",
    workflowKind: "unit-test-generation",
    patchScope: {
      schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
      editablePaths: ["tests/add.test.ts"],
      readOnlyPaths: ["src/add.ts"],
      evidenceAtomIds: ["atom-add-1"],
      limits: DEFAULT_PATCH_SCOPE_LIMITS,
      expectedChecks: ["tests"],
      unknowns: [],
    },
    requestedAtMs: 1_700_000_000_000,
    userApprovalToken: "a".repeat(64),
  };
}

describe("governed handoff enforcement helpers", () => {
  it("rejects a dry-run patch that escapes editablePaths", () => {
    const rejection = governedPatchRejectionCode(handoff(), {
      ok: true,
      files: [
        {
          path: "src/add.ts",
          kind: "modify",
          hunks: [],
          addedLines: 0,
          removedLines: 0,
        },
      ],
      totalChangedLines: 0,
      totalBytes: 16,
      reasons: [],
      conflicts: [],
    });
    expect(rejection).toBe("out-of-scope");
  });

  it("blocks actual writes outside the governed editable set", () => {
    const writes: string[] = [];
    const baseWriter: WorkspaceWriter = {
      writeFileUtf8(absolutePath): void {
        writes.push(absolutePath);
      },
      mkdirp(): void {
        // noop
      },
      remove(): void {
        // noop
      },
      rename(): void {
        // noop
      },
    };
    const scoped = createScopedWriter(baseWriter, WORKSPACE_ROOT, ["tests/add.test.ts"]);
    const allowed = resolveWithinWorkspace(WORKSPACE_ROOT, "tests/add.test.ts");
    const denied = resolveWithinWorkspace(WORKSPACE_ROOT, "src/add.ts");

    expect((): void => {
      scoped.writeFileUtf8(allowed, "ok");
    }).not.toThrow();
    expect((): void => {
      scoped.writeFileUtf8(denied, "blocked");
    }).toThrow(
      /Patch scope forbids writing/u,
    );
    expect(writes).toEqual([allowed]);
  });
});
