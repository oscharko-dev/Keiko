import { describe, expect, it, vi } from "vitest";
import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  DEFAULT_PATCH_SCOPE_LIMITS,
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  type WorkflowHandoffRequest,
} from "@oscharko-dev/keiko-contracts/workflow-handoff";
import type { PatchValidation, WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import {
  approvalTokenInputFor,
  buildGovernedHandoffEvidence,
  contextPackStableIdForPacks,
  createApprovalToken,
  createScopedWriter,
  evidenceAtomIdsForPacks,
  proposedPatchEntriesFromValidation,
  readOnlyPathsForPacks,
} from "./governed-workflow.js";

function pack(
  stableId: string,
  files: readonly {
    readonly scopePath: string;
    readonly atomIds: readonly string[];
  }[],
): ConnectedContextPack {
  return {
    schemaVersion: "1",
    stableId,
    scope: {
      schemaVersion: "1",
      scopeId: `scope-${stableId}`,
      workspaceRoot: "/repo",
      kind: "files",
      relativePaths: files.map((file) => file.scopePath),
      conversationId: undefined,
      connectedAtMs: 1,
    },
    query: {
      kind: "natural-language",
      text: "explain the changed code",
      caseSensitive: false,
      maxResults: 8,
      emittedAtMs: 1,
    },
    budget: {
      searchCallsMax: 1,
      filesReadMax: 2,
      excerptBytesMax: 3,
      modelInputTokensMax: 4,
      modelOutputTokensMax: 5,
      elapsedMsMax: 6,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    files: files.map((file) => ({
      scopePath: file.scopePath,
      role: "read-only",
      selectionReason: "unit-test fixture",
      excerpts: file.atomIds.map((atomId, index) => ({
        atom: {
          schemaVersion: "1",
          stableId: atomId,
          scopePath: file.scopePath,
          lineRange: { startLine: index + 1, endLine: index + 1 },
          score: 1,
          provenance: {
            kind: "excerpt-read",
            tool: "unit-test",
            queryFingerprint: "query",
          },
          redactionState: "redacted",
          emittedAtMs: 1,
          ledgerRef: undefined,
        },
        content: `excerpt ${atomId}`,
        contentBytes: Buffer.byteLength(`excerpt ${atomId}`, "utf8"),
      })),
    })),
    omitted: [],
    uncertainty: [],
    emittedAtMs: 1,
    ledgerRef: undefined,
  };
}

function governedRequest(overrides: Partial<WorkflowHandoffRequest> = {}): WorkflowHandoffRequest {
  const draft: WorkflowHandoffRequest = {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    contextPackStableId: `p-${"b".repeat(64)}`,
    workflowKind: "verification",
    patchScope: {
      schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
      editablePaths: ["src/app.ts", "README.md"],
      readOnlyPaths: ["src/lib.ts"],
      evidenceAtomIds: ["atom-2", "atom-1"],
      limits: DEFAULT_PATCH_SCOPE_LIMITS,
      expectedChecks: ["lint", "verify"],
      unknowns: ["needs-human-review"],
    },
    requestedAtMs: 1_700_000_000_000,
    userApprovalToken: "0".repeat(64),
    ...overrides,
  };
  return { ...draft, userApprovalToken: createApprovalToken(approvalTokenInputFor(draft)) };
}

describe("context pack workflow projections", () => {
  it("keeps a single pack id and hashes multiple packs deterministically", () => {
    const first = pack(`p-${"1".repeat(64)}`, []);
    const second = pack(`p-${"2".repeat(64)}`, []);

    expect(contextPackStableIdForPacks([first])).toBe(first.stableId);
    expect(contextPackStableIdForPacks([second, first])).toBe(
      contextPackStableIdForPacks([first, second]),
    );
    expect(contextPackStableIdForPacks([first, second])).toMatch(/^p-[0-9a-f]{64}$/);
  });

  it("deduplicates and sorts read-only paths and evidence atom ids", () => {
    const packs = [
      pack(`p-${"3".repeat(64)}`, [
        { scopePath: "src/editable.ts", atomIds: ["atom-z"] },
        { scopePath: "src/read-only.ts", atomIds: ["atom-b", "atom-a"] },
      ]),
      pack(`p-${"4".repeat(64)}`, [
        { scopePath: "src/read-only.ts", atomIds: ["atom-b"] },
        { scopePath: "docs/notes.md", atomIds: ["atom-c"] },
      ]),
    ];

    expect(readOnlyPathsForPacks(packs, ["src/editable.ts"])).toEqual([
      "docs/notes.md",
      "src/read-only.ts",
    ]);
    expect(evidenceAtomIdsForPacks(packs)).toEqual(["atom-a", "atom-b", "atom-c", "atom-z"]);
  });
});

describe("governed handoff evidence", () => {
  it("normalizes approval token input before hashing", () => {
    const request = governedRequest({
      patchScope: {
        schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
        editablePaths: ["z.ts", "a.ts"],
        readOnlyPaths: ["read-b.ts", "read-a.ts"],
        evidenceAtomIds: ["atom-z", "atom-a"],
        limits: DEFAULT_PATCH_SCOPE_LIMITS,
        expectedChecks: ["verify", "typecheck", "lint"],
        unknowns: ["z", "a"],
      },
    });

    expect(approvalTokenInputFor(request)).toMatchObject({
      editablePaths: ["a.ts", "z.ts"],
      readOnlyPaths: ["read-a.ts", "read-b.ts"],
      evidenceAtomIds: ["atom-a", "atom-z"],
      expectedChecks: ["verify", "lint", "typecheck"],
      unknowns: ["a", "z"],
    });
  });

  it("emits content-minimized evidence with optional voice audit only when present", () => {
    const request = governedRequest();

    expect(buildGovernedHandoffEvidence({ request })).toMatchObject({
      sourceGroundedRunId: "unavailable",
      workflowKind: "verification",
      editablePathCount: 2,
      readOnlyPathCount: 1,
      evidenceAtomCount: 2,
      expectedChecks: ["lint", "verify"],
    });
    expect(buildGovernedHandoffEvidence({ request })).not.toHaveProperty("voiceAction");

    const voiceAction = {
      schemaVersion: "1",
      effectClass: "read-only",
      state: "proposed",
      confirmationRequired: false,
      confirmed: false,
      outcome: "routed",
      source: "dictation",
      turnIndex: 4,
      committedSegmentCount: 2,
      committedChars: 24,
      bindingDigest: "a".repeat(64),
    } as const;

    expect(
      buildGovernedHandoffEvidence({
        request,
        sourceGroundedRunId: "grounded-run-1",
        voiceAction,
      }),
    ).toMatchObject({
      sourceGroundedRunId: "grounded-run-1",
      voiceAction,
    });
  });
});

describe("createScopedWriter", () => {
  it("allows only in-scope file mutations and matching parent directories", () => {
    const baseWriter: WorkspaceWriter = {
      writeFileUtf8: vi.fn(),
      mkdirp: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
    };
    const scoped = createScopedWriter(baseWriter, "/workspace", [
      "src/app.ts",
      "generated/output.ts",
    ]);

    scoped.mkdirp("/workspace/src");
    scoped.writeFileUtf8("/workspace/src/app.ts", "content");
    scoped.rename("/workspace/src/app.ts", "/workspace/generated/output.ts");
    scoped.remove("/workspace/generated/output.ts");

    expect(baseWriter.mkdirp).toHaveBeenCalledWith("/workspace/src");
    expect(baseWriter.writeFileUtf8).toHaveBeenCalledWith("/workspace/src/app.ts", "content");
    expect(baseWriter.rename).toHaveBeenCalledWith(
      "/workspace/src/app.ts",
      "/workspace/generated/output.ts",
    );
    expect(baseWriter.remove).toHaveBeenCalledWith("/workspace/generated/output.ts");

    expect(() => {
      scoped.mkdirp("/workspace/tmp");
    }).toThrow(/forbids creating/);
    expect(() => {
      scoped.writeFileUtf8("/workspace/src/other.ts", "content");
    }).toThrow(/forbids writing/);
    expect(() => {
      scoped.rename("/workspace/src/app.ts", "/workspace/tmp/output.ts");
    }).toThrow(/forbids writing/);
  });
});

describe("proposedPatchEntriesFromValidation", () => {
  it("returns no entries for empty validations", () => {
    const validation: PatchValidation = {
      ok: true,
      files: [],
      totalChangedLines: 0,
      totalBytes: 0,
      reasons: [],
      conflicts: [],
    };

    expect(proposedPatchEntriesFromValidation(validation)).toEqual([]);
  });

  it("projects create, modify, and delete files and attributes byte deltas to the last entry", () => {
    const validation: PatchValidation = {
      ok: true,
      files: [
        {
          path: "src/new.ts",
          kind: "create",
          hunks: [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ["+export const created = true;"],
            },
          ],
          addedLines: 1,
          removedLines: 0,
        },
        {
          path: "src/existing.ts",
          kind: "modify",
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old", "+new"],
            },
          ],
          addedLines: 1,
          removedLines: 1,
        },
        {
          path: "src/removed.ts",
          kind: "delete",
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 0,
              newLines: 0,
              lines: ["-export const removed = true;"],
            },
          ],
          addedLines: 0,
          removedLines: 1,
        },
      ],
      totalChangedLines: 4,
      totalBytes: 10_000,
      reasons: [],
      conflicts: [],
    };

    const entries = proposedPatchEntriesFromValidation(validation);

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => ({ path: entry.path, newFile: entry.newFile }))).toEqual([
      { path: "src/new.ts", newFile: true },
      { path: "src/existing.ts", newFile: false },
      { path: "src/removed.ts", newFile: false },
    ]);
    expect(entries.reduce((sum, entry) => sum + entry.patchBytes, 0)).toBe(10_000);
    expect(entries[2]?.patchBytes).toBeGreaterThan(entries[0]?.patchBytes ?? 0);
  });
});
