import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts";
import type {
  MemoryId,
  ProjectId,
  WorkflowDefinitionId,
  WorkflowRunId,
} from "@oscharko-dev/keiko-contracts/memory";
import { auditRunIdFor } from "./memory-audit-handler.js";
import { createWorkflowMemoryPort } from "./memory-workflow-port.js";

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function runId(value: string): WorkflowRunId {
  return value as WorkflowRunId;
}

function projectId(value: string): ProjectId {
  return value as ProjectId;
}

function workflowDefinitionId(value: string): WorkflowDefinitionId {
  return value as WorkflowDefinitionId;
}

function createEvidenceStore(): EvidenceStore {
  const records = new Map<string, string>();
  return {
    put: (key, value): string => {
      records.set(key, value);
      return key;
    },
    get: (key): string | undefined => records.get(key),
    list: (): readonly string[] => Array.from(records.keys()),
    delete: (key): void => {
      records.delete(key);
    },
  };
}

function createVault(): { dir: string; vault: MemoryVaultStore } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-workflow-memory-"));
  return {
    dir,
    vault: createMemoryVault({ memoryDir: dir, redactString: (value) => value }),
  };
}

function readAuditEvents(store: EvidenceStore, nowMs: number): readonly Record<string, unknown>[] {
  const raw = store.get(auditRunIdFor(nowMs));
  return raw === undefined ? [] : (JSON.parse(raw) as readonly Record<string, unknown>[]);
}

function insertProjectMemory(
  vault: MemoryVaultStore,
  body: string,
  options: {
    readonly id?: string;
    readonly projectId?: string;
    readonly status?: MemoryRecord["status"];
    readonly confidence?: number;
  } = {},
): MemoryRecord {
  const now = 1_700_000_000_000;
  return vault.insertMemory({
    id: memoryId(options.id ?? "mem-project-1"),
    schemaVersion: "1",
    scope: { kind: "project", projectId: projectId(options.projectId ?? "/repo") },
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: options.confidence ?? 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: options.status ?? "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
}

describe("createWorkflowMemoryPort", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanup.length = 0;
  });

  it("retrieves workflow context and records a memory:retrieved audit event", async () => {
    const { dir, vault } = createVault();
    cleanup.push(dir);
    insertProjectMemory(vault, "Project alpha uses pnpm for installs.");
    const evidenceStore = createEvidenceStore();
    const nowMs = 1_710_000_000_000;
    const port = createWorkflowMemoryPort({
      vault,
      evidenceStore,
      runId: runId("wr-1"),
      redactString: (value) => value,
      now: () => nowMs,
    });

    const context = await port.getContextForWorkflow(
      [{ kind: "project", projectId: projectId("/repo") }],
      "pnpm installs",
      2048,
    );

    expect(context.text).toContain("pnpm");
    expect(context.includedMemoryIds).toEqual(["mem-project-1"]);
    const events = readAuditEvents(evidenceStore, nowMs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "memory:retrieved",
      initiatorSurface: "workflow",
      matchedMemoryIds: ["mem-project-1"],
    });
    vault.close();
  });

  it("does not retrieve workflow memory across project scopes", async () => {
    const { dir, vault } = createVault();
    cleanup.push(dir);
    insertProjectMemory(vault, "Project alpha uses pnpm for installs.", {
      projectId: "/repo-a",
    });
    const evidenceStore = createEvidenceStore();
    const nowMs = 1_710_000_000_000;
    const port = createWorkflowMemoryPort({
      vault,
      evidenceStore,
      runId: runId("wr-scope"),
      redactString: (value) => value,
      now: () => nowMs,
    });

    const context = await port.getContextForWorkflow(
      [{ kind: "project", projectId: projectId("/repo-b") }],
      "pnpm installs",
      2048,
    );

    expect(context.text).toBe("");
    expect(context.includedMemoryIds).toEqual([]);
    expect(readAuditEvents(evidenceStore, nowMs)).toEqual([]);
    vault.close();
  });

  it("records memory:workflow-omitted audit events without memory bodies", async () => {
    const { dir, vault } = createVault();
    cleanup.push(dir);
    insertProjectMemory(vault, "Project alpha uses pnpm for installs.", {
      id: "mem-included",
    });
    insertProjectMemory(vault, "Project alpha stores an obsolete private lesson.", {
      id: "mem-rejected",
      status: "rejected",
    });
    const evidenceStore = createEvidenceStore();
    const nowMs = 1_710_000_000_000;
    const port = createWorkflowMemoryPort({
      vault,
      evidenceStore,
      runId: runId("wr-omitted"),
      redactString: (value) => value,
      now: () => nowMs,
    });

    await port.getContextForWorkflow(
      [{ kind: "project", projectId: projectId("/repo") }],
      "pnpm installs",
      2048,
    );

    const events = readAuditEvents(evidenceStore, nowMs);
    expect(events.some((event) => event.kind === "memory:retrieved")).toBe(true);
    const omitted = events.find((event) => event.kind === "memory:workflow-omitted");
    expect(omitted).toMatchObject({
      kind: "memory:workflow-omitted",
      workflowRunId: "wr-omitted",
      omittedMemoryId: "mem-rejected",
      reason: "suppressed-by-status",
    });
    expect(JSON.stringify(events)).not.toContain("obsolete private lesson");
    vault.close();
  });

  it("records a memory:workflow-used audit event", () => {
    const { dir, vault } = createVault();
    cleanup.push(dir);
    const evidenceStore = createEvidenceStore();
    const nowMs = 1_710_000_000_000;
    const port = createWorkflowMemoryPort({
      vault,
      evidenceStore,
      runId: runId("wr-2"),
      redactString: (value) => value,
      now: () => nowMs,
    });

    if (port.onMemoryUsed === undefined) {
      throw new Error("expected workflow memory port to expose onMemoryUsed");
    }
    port.onMemoryUsed({
      memoryIds: [memoryId("mem-used-1")],
      scopes: [
        { kind: "workflow", workflowDefinitionId: workflowDefinitionId("bug-investigation") },
      ],
      reason: "bug-investigation:pre-prompt",
    });

    const events = readAuditEvents(evidenceStore, nowMs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "memory:workflow-used",
      workflowRunId: "wr-2",
      usedMemoryIds: ["mem-used-1"],
    });
    vault.close();
  });

  // #4213, R9: a workflow's own summary is not the person's words, so it never becomes a memory.
  it("offers a workflow no way to write a memory", () => {
    const { dir, vault } = createVault();
    cleanup.push(dir);
    const port = createWorkflowMemoryPort({
      vault,
      evidenceStore: createEvidenceStore(),
      runId: runId("wr-3"),
      redactString: (value) => value,
    });
    expect(Object.keys(port).sort()).toEqual([
      "getContextForWorkflow",
      "onMemoryOmitted",
      "onMemoryUsed",
    ]);
    vault.close();
  });
});
