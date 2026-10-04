// #3534 retires the open JSONL exporter. Its file trust-boundary pins now exercise the canonical
// report writer; generic interrupted publication and race pins remain in keiko-security.
import * as fs from "node:fs";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalSupportJson,
  MAX_SUPPORT_REPORT_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { publishSupportReportFile, readSupportReportFile } from "./support-export.js";
import {
  analyzeSupportReport,
  createClientOnlySupportReport,
  parseSupportReport,
  SupportReportError,
} from "@oscharko-dev/keiko-activity-log/reader";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-activity-log";
import { runSupportCli } from "./support.js";
import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readSync: vi.fn(original.readSync) };
});

describe("bounded standard gzip report transport", () => {
  function canonicalReport(): string {
    return createClientOnlySupportReport(undefined, "session-unavailable").reportJson;
  }

  function writeGzip(bytes: string | Uint8Array): string {
    const path = join(root, "report.json.gz");
    writeFileSync(path, gzipSync(bytes), { mode: 0o600 });
    return path;
  }

  it("analyzes the byte-identical inner canonical report and hashes that source, not gzip transport", () => {
    const canonical = canonicalReport();
    const decoded = readSupportReportFile(writeGzip(canonical));
    expect(decoded).toBe(canonical);
    // The existing analyzer receives the canonical JSON, so its source digest describes those
    // exact decompressed bytes; gzip metadata never changes report integrity or authenticity.
    expect(analyzeSupportReport(decoded)).toEqual(analyzeSupportReport(canonical));
  });

  it("runs gzip through normal CLI analysis and records the existing body-free report lifecycle", async () => {
    const canonical = canonicalReport();
    const controlStateDir = join(root, "control-state");
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runSupportCli(
      ["analyze", writeGzip(canonical), "--json"],
      {
        out: (text): void => {
          output.push(text);
        },
        err: (text): void => {
          errors.push(text);
        },
      },
      {},
      { cwd: root, controlActivityStateDir: controlStateDir },
    );
    expect(code, errors.join("")).toBe(0);
    const actual: unknown = JSON.parse(output.join(""));
    expect(actual).toEqual(analyzeSupportReport(canonical));
    const log = readPersistedActivityLog(controlStateDir);
    expect(persistedActivityLogLines(log, "support.report.started")).toHaveLength(1);
    expect(persistedActivityLogLines(log, "support.report.completed")).toHaveLength(1);
    expect(persistedActivityLogLines(log, "support.report.failed")).toEqual([]);
    expect(log).not.toContain(root);
  });

  it("uses the already verified descriptor even if the selected path is replaced during reading", async () => {
    const canonical = canonicalReport();
    const path = writeGzip(canonical);
    const replacement = join(root, "replacement.json");
    writeFileSync(replacement, "not a report", { mode: 0o600 });
    const { readSync: realRead } = await vi.importActual<typeof import("node:fs")>("node:fs");
    let replaced = false;
    vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof fs.readSync>): number => {
      if (!replaced) {
        replaced = true;
        renameSync(replacement, path);
      }
      return realRead(...args);
    });
    expect(readSupportReportFile(path)).toBe(canonical);
    expect(replaced).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("not a report");
  });

  it.each(["crc", "truncated"] as const)("rejects %s gzip bytes", (kind) => {
    const bytes = gzipSync(canonicalReport());
    const corrupt = kind === "crc" ? Buffer.from(bytes) : bytes.subarray(0, bytes.length - 4);
    if (kind === "crc") corrupt[corrupt.length - 8] = (corrupt[corrupt.length - 8] ?? 0) ^ 1;
    const path = join(root, "report.json.gz");
    writeFileSync(path, corrupt, { mode: 0o600 });
    expect(() => readSupportReportFile(path)).toThrow("corrupt-report");
  });

  it("bounds decompressed bytes before a tiny gzip bomb can allocate an oversized report", () => {
    const path = writeGzip(Buffer.alloc(MAX_SUPPORT_REPORT_BYTES + 1, 0x61));
    expect(readFileSync(path).length).toBeLessThan(MAX_SUPPORT_REPORT_BYTES);
    expect(() => readSupportReportFile(path)).toThrow("report-budget-exceeded");
  });

  it("accepts the inclusive decompressed byte boundary without changing strict report parsing", () => {
    const text = readSupportReportFile(writeGzip(Buffer.alloc(MAX_SUPPORT_REPORT_BYTES, 0x61)));
    expect(Buffer.byteLength(text)).toBe(MAX_SUPPORT_REPORT_BYTES);
    expect(() => analyzeSupportReport(text)).toThrow("corrupt-report");
  });

  it("checks compressed file bytes before attempting decompression", () => {
    const path = join(root, "report.json.gz");
    const bytes = Buffer.alloc(MAX_SUPPORT_REPORT_BYTES + 1);
    bytes[0] = 0x1f;
    bytes[1] = 0x8b;
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(() => readSupportReportFile(path)).toThrow("report-budget-exceeded");
  });

  it("rejects invalid UTF-8 after decompression", () => {
    expect(() => readSupportReportFile(writeGzip(Buffer.from([0xc0, 0xaf])))).toThrow(
      "corrupt-report",
    );
  });

  it("rejects a symlink and public permissions without mutating the selected gzip artifact", () => {
    const path = writeGzip(canonicalReport());
    const link = join(root, "link.json.gz");
    symlinkSync(path, link);
    expect(() => readSupportReportFile(link)).toThrow();
    const before = readFileSync(path);
    chmodSync(path, 0o644);
    expect(() => readSupportReportFile(path)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(["whitespace", "schema", "integrity"] as const)(
    "pins the exact %s refusal after gzip decompression",
    (kind) => {
      const canonical = canonicalReport();
      const report = parseSupportReport(canonical);
      const modified =
        kind === "schema"
          ? { ...report, schemaVersion: 999 }
          : { ...report, integrity: { ...report.integrity, reportDigest: "f".repeat(64) } };
      const changed =
        kind === "whitespace"
          ? JSON.stringify(report, null, 2) + "\n"
          : canonicalSupportJson(modified) + "\n";
      expect(changed).not.toBe(canonical);
      const decoded = readSupportReportFile(writeGzip(changed));
      expect(decoded).toBe(changed);
      expect(JSON.parse(decoded)).toMatchObject({
        schemaVersion: kind === "schema" ? 999 : report.schemaVersion,
        incident: report.incident,
      });
      expect(() => analyzeSupportReport(decoded)).toThrow(SupportReportError);
      expect(() => analyzeSupportReport(decoded)).toThrow(
        new SupportReportError(kind === "schema" ? "unsupported-report" : "corrupt-report"),
      );
    },
  );
});
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-report-io-"));
});
afterEach(() => {
  closeFileServerLogSinks();
  vi.restoreAllMocks();
  vi.mocked(fs.readSync).mockReset();
  rmSync(root, { recursive: true, force: true });
});
describe("bounded private report file I/O", () => {
  it("publishes exactly one file and never replaces prior bytes", () => {
    const path = join(root, "report.json");
    publishSupportReportFile(path, "report-bytes\n");
    expect(readdirSync(root)).toEqual(["report.json"]);
    expect(readSupportReportFile(path)).toBe("report-bytes\n");
    expect(() => {
      publishSupportReportFile(path, "replacement");
    }).toThrow();
    expect(readFileSync(path, "utf8")).toBe("report-bytes\n");
  });
  it("rejects an output above the hard limit before creating any file", () => {
    const path = join(root, "report.json");
    expect(() => {
      publishSupportReportFile(path, "x".repeat(MAX_SUPPORT_REPORT_BYTES + 1));
    }).toThrow();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
  it("rejects oversized input from its verified descriptor", () => {
    const path = join(root, "report.json");
    writeFileSync(path, Buffer.alloc(MAX_SUPPORT_REPORT_BYTES + 1), { mode: 0o600 });
    expect(() => readSupportReportFile(path)).toThrow();
  });
  it("enforces the hard limit when a received file grows after the initial descriptor check", async () => {
    const path = join(root, "report.json");
    writeFileSync(path, Buffer.alloc(32 * 1024), { mode: 0o600 });
    const { readSync: realRead } = await vi.importActual<typeof import("node:fs")>("node:fs");
    let appended = false;
    vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof fs.readSync>): number => {
      if (!appended) {
        appended = true;
        appendFileSync(path, Buffer.alloc(MAX_SUPPORT_REPORT_BYTES));
      }
      return realRead(...args);
    });
    expect(() => readSupportReportFile(path)).toThrow("report-budget-exceeded");
    expect(appended).toBe(true);
  });
  it("rejects invalid UTF-8 instead of silently replacing bytes", () => {
    const path = join(root, "report.json");
    writeFileSync(path, Buffer.from([0xc0, 0xaf]), { mode: 0o600 });
    expect(() => readSupportReportFile(path)).toThrow();
  });
  it("rejects public permissions without changing the received artifact", () => {
    const path = join(root, "report.json");
    writeFileSync(path, "report-bytes", { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => readSupportReportFile(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("report-bytes");
  });
});
