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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { publishSupportReportFile, readSupportReportFile } from "./support-export.js";
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readSync: vi.fn(original.readSync) };
});
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-report-io-"));
});
afterEach(() => {
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
