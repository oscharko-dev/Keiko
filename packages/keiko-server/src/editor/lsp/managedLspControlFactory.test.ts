import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { EvidenceStore } from "@oscharko-dev/keiko-contracts";
import type { ServerDiagnosticRecord } from "../../diagnostics-log.js";
import { createNodeManagedLspControl } from "./managedLspControlFactory.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "keiko-managed-lsp-factory-")));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("node managed LSP control wiring", () => {
  it("emits a redacted operator diagnostic when secondary evidence projection fails", async () => {
    const secret = "SENTINEL_SECRET_PROJECTOR_FAILURE";
    const records: ServerDiagnosticRecord[] = [];
    const evidenceStore: EvidenceStore = {
      put: () => {
        throw new Error(secret);
      },
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    };
    const service = createNodeManagedLspControl({
      stateDir: temporaryDirectory(),
      processEnv: {},
      evidenceStore,
      redact: (value): unknown =>
        typeof value === "string" ? value.replace(secret, "[REDACTED]") : value,
      diagnosticSink: {
        record: (record): void => {
          records.push(record);
        },
      },
    });
    const root = temporaryDirectory();

    const result = await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "projection-diagnostic",
      language: "python",
      root,
    });

    expect(result.kind).toBe("ok");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: "managed-lsp-evidence-projection",
      operation: "managed-lsp.evidence.project",
      source: "managed-lsp-control",
      message: "[REDACTED]",
    });
    expect(JSON.stringify(records)).not.toContain(secret);
  });
});
