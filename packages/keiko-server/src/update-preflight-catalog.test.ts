import { describe, expect, it, vi } from "vitest";

// FAILS BEFORE / PASSES AFTER (#2902 w4b): the bare `catch {}` around the bundled-catalog read
// used to discard a corrupted-file read entirely — no diagnostic, no retry, just a silently
// cached "invalid" result. This forces that exact failure mode (readFileSync throws) and asserts
// a structured, content-free diagnostic now surfaces where none did before.
const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn((): never => {
    throw new Error("EACCES: permission denied, open 'release-impact.catalog.json'");
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: readFileSyncMock };
});

import { readBundledCatalogFromDisk } from "./update-preflight-catalog.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

describe("readBundledCatalogFromDisk", () => {
  it("logs a content-free diagnostic when the bundled catalog is unreadable", () => {
    const records: ServerDiagnosticRecord[] = [];
    const result = readBundledCatalogFromDisk({
      record: (record) => records.push(record),
    });

    expect(result).toBeUndefined();
    expect(records).toHaveLength(1);
    const [record] = records;
    if (record === undefined) throw new Error("expected a diagnostic record");
    expect(record.source).toBe("update-preflight-catalog.read-bundled-catalog-from-disk");
    expect(record.operation).toBe("update.preflight.bundled-catalog.read");
    expect(record.errorClass).toBe("Error");
    expect(record.message).toBe("release-impact-bundled-catalog-corrupted");

    // Content-free: neither the file path nor the raw exception text ever reaches the diagnostic.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("release-impact.catalog.json");
    expect(serialized).not.toContain("EACCES");
  });
});
