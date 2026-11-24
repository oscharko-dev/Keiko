// #4434 / #4435: the Files filename search skips locked, protected and vanished entries and
// counts them, while an unreadable selected root and descriptor exhaustion still fail the search.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { recordFilesSearchCompleted } from "./files-search-activity.js";
import { buildRedactor, createInMemoryUiStore, searchFiles } from "./index.js";
import type { UiStore } from "./store/index.js";

type FailureRule = (path: string) => string | undefined;

const failures: { lstat?: FailureRule; opendir?: FailureRule } = {};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (code: string): Error =>
    Object.assign(new Error("PRIVATE_FIXTURE_DETAIL"), { code });
  return {
    ...actual,
    lstat: ((path: string, ...rest: unknown[]): unknown => {
      const code = failures.lstat?.(path);
      if (code !== undefined) return Promise.reject(fail(code));
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.lstat,
    opendir: ((path: string, ...rest: unknown[]): unknown => {
      const code = failures.opendir?.(path);
      if (code !== undefined) return Promise.reject(fail(code));
      return (actual.opendir as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.opendir,
  };
});

function endsWithSegment(path: string, suffix: string): boolean {
  return path.replaceAll("\\", "/").endsWith(suffix);
}

describe("Files filename search availability", () => {
  let root: string;
  let store: UiStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "keiko-fs-avail-")));
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "docs", "protected"));
    await writeFile(join(root, "docs", "report-locked.md"), "locked\n");
    await writeFile(join(root, "docs", "report-open.md"), "open\n");
    await writeFile(join(root, "docs", "report-gone.md"), "gone\n");
    await writeFile(join(root, "docs", "protected", "report-hidden.md"), "hidden\n");
    store = createInMemoryUiStore();
    store.createProject(root, "fixture");
  });

  afterEach(async () => {
    delete failures.lstat;
    delete failures.opendir;
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("skips and counts a locked file, a protected folder and a vanished file", async () => {
    failures.lstat = (path): string | undefined => {
      if (endsWithSegment(path, "/docs/report-locked.md")) return "EBUSY";
      if (endsWithSegment(path, "/docs/report-gone.md")) return "ENOENT";
      return undefined;
    };
    failures.opendir = (path): string | undefined =>
      endsWithSegment(path, "/docs/protected") ? "EACCES" : undefined;
    const result = await searchFiles(store, root, "report", 10, buildRedactor({}));
    expect(result.results.map((entry) => entry.path)).toEqual(["docs/report-open.md"]);
    expect(result.unavailableEntryCount).toBe(2);
    expect(result.vanishedEntryCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE_DETAIL");
  });

  it("omits the counts when nothing was skipped", async () => {
    const result = await searchFiles(store, root, "report", 10, buildRedactor({}));
    expect(result.results).toHaveLength(4);
    expect(result).not.toHaveProperty("unavailableEntryCount");
    expect(result).not.toHaveProperty("vanishedEntryCount");
    expect(result).not.toHaveProperty("systemEntryPrunedCount");
  });

  it("never opens Windows system folders and counts the pruned entries (#4437)", async () => {
    await mkdir(join(root, "$Recycle.Bin", "S-1-5-21"), { recursive: true });
    await writeFile(join(root, "$Recycle.Bin", "S-1-5-21", "report-deleted.md"), "gone\n");
    await writeFile(join(root, "docs", "desktop.ini"), "[report]\n");
    const opened: string[] = [];
    failures.opendir = (path): string | undefined => {
      opened.push(path.replaceAll("\\", "/"));
      return undefined;
    };
    const result = await searchFiles(store, root, "report", 10, buildRedactor({}));
    expect(result.results.map((entry) => entry.path)).not.toContain(
      "$Recycle.Bin/S-1-5-21/report-deleted.md",
    );
    expect(result.results).toHaveLength(4);
    expect(result.systemEntryPrunedCount).toBe(2);
    expect(opened.some((path) => path.includes("$Recycle.Bin"))).toBe(false);
  });

  it.each(["EMFILE", "ENFILE"])("still fails the search on %s", async (code) => {
    failures.lstat = (path): string | undefined =>
      endsWithSegment(path, "/docs/report-locked.md") ? code : undefined;
    await expect(searchFiles(store, root, "report", 10, buildRedactor({}))).rejects.toMatchObject({
      code,
    });
  });

  it("still fails the search when the selected root cannot be read", async () => {
    failures.opendir = (path): string | undefined => (path === root ? "EACCES" : undefined);
    await expect(searchFiles(store, root, "report", 10, buildRedactor({}))).rejects.toMatchObject({
      code: "EACCES",
    });
  });
});

describe("files.search.completed activity", () => {
  it("records skipped counts body-free under the request correlation", () => {
    const sink = createBufferedServerLogSink();
    recordFilesSearchCompleted({ activityLog: sink }, "files-search-correlation", {
      results: [{}, {}],
      scannedFileCount: 7,
      truncated: false,
      unavailableEntryCount: 2,
      vanishedEntryCount: 1,
      systemEntryPrunedCount: 3,
    });
    expect(sink.events).toHaveLength(1);
    const line = formatActivityLogProofLine(sink.events[0] ?? {});
    expect(expectActivityLogProof("files.search.completed.line", line)).toMatchObject({
      resultCount: 2,
      scannedFileCount: 7,
      truncated: false,
      unavailableEntryCount: 2,
      vanishedEntryCount: 1,
      systemEntryPrunedCount: 3,
    });
    expect(sink.events[0]).toMatchObject({
      op: "files.search.completed",
      correlationId: "files-search-correlation",
    });
  });

  it("records zero counts for a search that skipped nothing", () => {
    const sink = createBufferedServerLogSink();
    recordFilesSearchCompleted({ activityLog: sink }, undefined, {
      results: [],
      scannedFileCount: 0,
      truncated: false,
    });
    const line = formatActivityLogProofLine(sink.events[0] ?? {});
    expect(expectActivityLogProof("files.search.completed.line", line)).toMatchObject({
      unavailableEntryCount: 0,
      vanishedEntryCount: 0,
      systemEntryPrunedCount: 0,
    });
  });
});
