// Tests for memory diagnostics export (#214). Each test asserts the snapshot shape and
// hard invariants: no raw body, no raw payload, redacted storage path, sanitised audit
// tail. The audit handler from this PR is exercised end-to-end so the tail comes from
// the same persistence path production uses.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuditRedactor,
  createInMemoryEvidenceStore,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryId,
  MemoryProjectId,
  MemoryRecord,
  MemoryScope,
  MemoryUserId,
  MemoryWorkspaceId,
} from "@oscharko-dev/keiko-contracts";
import { exportMemoryDiagnostics } from "./memory-diagnostics.js";
import { createMemoryAuditHandler } from "./memory-audit-handler.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function brandedMemoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}

function brandedMemoryUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}

function brandedMemoryProjectId(value: string): MemoryProjectId {
  const u: unknown = value;
  return u as MemoryProjectId;
}

function brandedMemoryWorkspaceId(value: string): MemoryWorkspaceId {
  const u: unknown = value;
  return u as MemoryWorkspaceId;
}

const USER_ID = brandedMemoryUserId("u-diagnostics");
const SCOPE: MemoryScope = { kind: "user", userId: USER_ID };
const FIXED_NOW = 1_750_000_000_000;

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keiko-mem-diag-"));
});

afterEach(() => {
  if (tmpDir !== "") {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

interface MakeRecordOptions {
  readonly id: string;
  readonly status?: MemoryRecord["status"];
  readonly pinned?: boolean;
  readonly body?: string;
}

function makeVault(
  evidenceStore?: EvidenceStore,
  redactString: (s: string) => string = (s) => s,
): MemoryVaultStore {
  const onMemoryEvent = evidenceStore
    ? createMemoryAuditHandler({
        evidenceStore,
        redactString,
        now: () => FIXED_NOW,
        newEventId: ((): (() => string) => {
          let i = 0;
          return (): string => {
            i += 1;
            return `evt-${String(i)}`;
          };
        })(),
      })
    : undefined;
  return createMemoryVault({
    memoryDir: tmpDir,
    env: { KEIKO_MEMORY_DIR: tmpDir },
    redactString,
    ...(onMemoryEvent ? { onMemoryEvent } : {}),
  });
}

function insertRecord(vault: MemoryVaultStore, options: MakeRecordOptions): MemoryRecord {
  const record: MemoryRecord = {
    id: brandedMemoryId(options.id),
    schemaVersion: "1",
    scope: SCOPE,
    type: "preference",
    body: options.body ?? `record ${options.id}`,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: FIXED_NOW,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: FIXED_NOW },
    status: options.status ?? "accepted",
    pinned: options.pinned ?? false,
    tags: [],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  return vault.insertMemory(record);
}

// ── Counts and histogram ─────────────────────────────────────────────────────

describe("exportMemoryDiagnostics — scope counts and status histogram", () => {
  it("counts records per scope and builds a status histogram", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "r-1", status: "proposed" });
    insertRecord(vault, { id: "r-2", status: "accepted" });
    insertRecord(vault, { id: "r-3", status: "accepted" });
    insertRecord(vault, { id: "r-4", status: "archived" });
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore: createInMemoryEvidenceStore(),
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      now: () => FIXED_NOW,
    });
    expect(diag.scopeCounts).toHaveLength(1);
    expect(diag.scopeCounts[0]?.count).toBe(4);
    expect(diag.statusHistogram.proposed).toBe(1);
    expect(diag.statusHistogram.accepted).toBe(2);
    expect(diag.statusHistogram.archived).toBe(1);
    expect(diag.statusHistogram.forgotten).toBe(0);
  });

  it("returns zero counts when a scope has no records", () => {
    const vault = makeVault();
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore: createInMemoryEvidenceStore(),
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      now: () => FIXED_NOW,
    });
    expect(diag.scopeCounts[0]?.count).toBe(0);
    expect(diag.statusHistogram.accepted).toBe(0);
  });
});

// ── Body and payload are never serialised ────────────────────────────────────

describe("exportMemoryDiagnostics — body and payload absence", () => {
  it("never includes the raw memory body in the serialised diagnostics", () => {
    const vault = makeVault();
    const fingerprint = "DIAG-BODY-FINGERPRINT-x4q2lm9p";
    insertRecord(vault, { id: "r-body", status: "accepted", body: fingerprint });
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore: createInMemoryEvidenceStore(),
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      now: () => FIXED_NOW,
    });
    expect(JSON.stringify(diag)).not.toContain(fingerprint);
  });
});

// ── Storage path redaction ────────────────────────────────────────────────────

describe("exportMemoryDiagnostics — storage path redaction", () => {
  it("runs the configured evidence dir through the redactor", () => {
    const vault = makeVault();
    // Fragmented secret so this test file contains no contiguous credential pattern.
    const secret = ["sk-", "live", "_", "AbCDef0123456789", "GhIjKl"].join("");
    const redact = createAuditRedactor({ additionalSecrets: [secret] }, {});
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore: createInMemoryEvidenceStore(),
      redactString: redact,
      // Plant the secret inside the path; redaction should remove it.
      evidenceDir: `/tmp/keiko/${secret}/evidence`,
      now: () => FIXED_NOW,
    });
    expect(diag.storagePath).not.toContain(secret);
  });

  it("masks scope coordinates in the diagnostics snapshot", () => {
    const vault = makeVault();
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [
        {
          kind: "project",
          projectId: brandedMemoryProjectId("/Users/private/project"),
        },
      ],
      evidenceStore: createInMemoryEvidenceStore(),
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      now: () => FIXED_NOW,
    });
    expect(JSON.stringify(diag)).not.toContain("/Users/private/project");
  });
});

// ── Audit tail ────────────────────────────────────────────────────────────────

describe("exportMemoryDiagnostics — sanitised audit tail", () => {
  it("returns the last-N audit events from today's manifest", () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    insertRecord(vault, { id: "r-a", status: "proposed" });
    insertRecord(vault, { id: "r-b", status: "proposed" });
    insertRecord(vault, { id: "r-c", status: "proposed" });
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore,
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      lastNAuditEvents: 2,
      now: () => FIXED_NOW,
    });
    expect(diag.recentAuditEvents).toHaveLength(2);
    expect(diag.recentAuditEvents[0]?.kind).toBe("memory:proposed");
    expect(diag.recentAuditEvents[1]?.kind).toBe("memory:proposed");
  });

  it("returns an empty tail when no audit events have been recorded", () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore,
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      now: () => FIXED_NOW,
    });
    expect(diag.recentAuditEvents).toHaveLength(0);
  });

  it("filters the audit tail down to the requested scopes", () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    const otherScope: MemoryScope = {
      kind: "workspace",
      workspaceId: brandedMemoryWorkspaceId("ws-other"),
    };
    insertRecord(vault, { id: "r-a", status: "proposed" });
    vault.insertMemory({
      id: brandedMemoryId("r-b"),
      schemaVersion: "1",
      scope: otherScope,
      type: "preference",
      body: "record r-b",
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: FIXED_NOW,
        confidence: 0.9,
        sensitivity: "public",
      },
      validity: { validFrom: FIXED_NOW },
      status: "proposed",
      pinned: false,
      tags: [],
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore,
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      lastNAuditEvents: 10,
      now: () => FIXED_NOW,
    });
    expect(diag.recentAuditEvents).toHaveLength(1);
    const first = diag.recentAuditEvents[0];
    if (first !== undefined && first.kind !== "memory:workflow-used") {
      if (first.kind === "memory:retrieved" || first.kind === "memory:workflow-omitted") {
        expect(first.scopes).toHaveLength(1);
      } else {
        expect(first.scope.kind).toBe("user");
      }
    }
  });

  it("clamps lastNAuditEvents to [1, 1000]", () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const vault = makeVault(evidenceStore);
    insertRecord(vault, { id: "r-1", status: "proposed" });
    const diagZero = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore,
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      lastNAuditEvents: 0,
      now: () => FIXED_NOW,
    });
    // 0 clamps to 1, but there is 1 audit event so we get it back.
    expect(diagZero.recentAuditEvents).toHaveLength(1);
  });
});

// ── Snapshot shape ────────────────────────────────────────────────────────────

describe("exportMemoryDiagnostics — snapshot shape", () => {
  it("pins schemaVersion to '1' and uses the injected clock", () => {
    const vault = makeVault();
    const diag = exportMemoryDiagnostics({
      vault,
      scopes: [SCOPE],
      evidenceStore: createInMemoryEvidenceStore(),
      redactString: (s) => s,
      evidenceDir: "/tmp/evidence",
      now: () => FIXED_NOW,
    });
    expect(diag.schemaVersion).toBe("1");
    expect(diag.generatedAt).toBe(FIXED_NOW);
  });
});
