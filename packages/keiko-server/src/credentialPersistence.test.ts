// Regression coverage for the migration failure path (#3244 review, thread 12): before this test
// existed, `migrateLocalConfigCredentials`'s catch swallowed every migration failure and returned
// `{ migrated: false }` with no operator diagnostic at all — a plaintext credential configuration
// could remain in use indefinitely and nobody would ever see why. This proves the redacted,
// correlation-keyed diagnostic is emitted instead of the failure staying silent.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLocalConfigCredentials } from "./credentialPersistence.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "credential-persistence-migrate-"));
  dirs.push(dir);
  return dir;
}

function recordingDiagnosticSink(): {
  sink: ServerDiagnosticSink;
  records: ServerDiagnosticRecord[];
} {
  const records: ServerDiagnosticRecord[] = [];
  return {
    sink: {
      record: (record): void => {
        records.push(record);
      },
    },
    records,
  };
}

describe("migrateLocalConfigCredentials", () => {
  it("does nothing and reports no diagnostic when the config file simply does not exist", () => {
    const dir = tempConfigDir();
    const { sink, records } = recordingDiagnosticSink();

    const outcome = migrateLocalConfigCredentials({
      configPath: join(dir, "keiko.config.json"),
      env: {},
      evidenceDir: dir,
      diagnostics: sink,
    });

    expect(outcome).toEqual({ migrated: false });
    expect(records).toHaveLength(0);
  });

  it("reports a redacted, correlation-keyed diagnostic when migration fails, instead of failing silently", () => {
    const dir = tempConfigDir();
    const configPath = join(dir, "keiko.config.json");
    // Malformed JSON makes JSON.parse throw inside migrateLocalConfigCredentials's try, exercising
    // the best-effort catch without needing a real vault/provider fixture.
    writeFileSync(configPath, "{ not valid json", "utf8");
    const { sink, records } = recordingDiagnosticSink();

    const outcome = migrateLocalConfigCredentials({
      configPath,
      env: {},
      evidenceDir: dir,
      diagnostics: sink,
    });

    expect(outcome).toEqual({ migrated: false });
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      operation: "credential.migration",
      source: "credentialPersistence.migrateLocalConfigCredentials",
      errorClass: "SyntaxError",
    });
    expect(typeof record?.correlationId).toBe("string");
    expect(record?.correlationId.length ?? 0).toBeGreaterThan(0);
    // Redacted: never the config path or the malformed file content.
    expect(JSON.stringify(record)).not.toContain(configPath);
    expect(JSON.stringify(record)).not.toContain("not valid json");
  });
});
