import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS } from "./repoSearch.js";
import { collectStreamedSearchText } from "./repoSearchStream.js";
import type { SearchTextRunner } from "./repoSearchScan.js";
import type { WorkspaceFs } from "./fs.js";
import { PathDeniedError, WorkspaceReadError } from "./errors.js";
import {
  createStructuralExecutionControl,
  StructuralExecutionStoppedError,
} from "./structuralExecution.js";

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function concurrentFixture(
  directoryFailure: Error,
  rescue: boolean,
): {
  runner: SearchTextRunner;
  readsStarted: Promise<void>;
  releaseReads: () => void;
  failures: readonly Error[];
} {
  const prefix = rescue ? "dist/" : "";
  const base = memFs("/ws", { [`${prefix}a.txt`]: "probe-a", [`${prefix}b.txt`]: "probe-b" });
  const read = base.readFileBytes;
  if (read === undefined) throw new TypeError("Byte reads are required.");
  const started = gate();
  const reads = gate();
  let pending = 0;
  let rootWalks = 0;
  const failures: readonly [Error, Error] = [
    new TypeError("PRIVATE_SCORING_FAILURE"),
    new PathDeniedError("PRIVATE_PATH_FAILURE", "b.txt"),
  ];
  const fs: WorkspaceFs = {
    ...base,
    readFileBytes: async (...args): Promise<Uint8Array> => {
      pending += 1;
      if (pending === 2) started.release();
      await reads.promise;
      return read(...args);
    },
    iterateDirectory: async function* (path) {
      if (path === "/ws") rootWalks += 1;
      for (const entry of base.readDir(path)) yield await Promise.resolve(entry);
      if (rescue && (rootWalks < 2 || path === "/ws")) return;
      await started.promise;
      throw directoryFailure;
    },
  };
  const runner: SearchTextRunner = {
    fs,
    limits: DEFAULT_SEARCH_LIMITS,
    nowMs: () => 0,
    startMs: 0,
    fingerprint: "fixture",
    contentLane: "evidence",
    literalTerms: ["probe"],
    query: {
      kind: "natural-language",
      text: "probe",
      caseSensitive: false,
      emittedAtMs: 0,
      maxResults: 10,
    },
    matcher: {
      match: (line): number => {
        if (line.includes("probe-a")) throw failures[0];
        if (line.includes("probe-b")) throw failures[1];
        return 0;
      },
    },
    policy: {
      mode: "explicit-scope",
      intent: "generic",
      applyGitignore: false,
      omitLowValueWorkspaceFiles: rescue,
      lowValuePathAllowlist: [],
      recentPaths: [],
    },
    scope: {
      scopeId: "fixture",
      relativePaths: [],
      workspace: {
        root: "/ws",
        selectedRoot: "/ws",
        name: "fixture",
        version: undefined,
        testFramework: "unknown",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      },
    },
  };
  return { runner, readsStarted: started.promise, releaseReads: reads.release, failures };
}

describe.each([false, true])("streaming collector failure settlement (rescue=%s)", (rescue) => {
  it.each(["aborted", "timeout", "directory"] as const)(
    "retains competing file failures when %s interrupts discovery",
    async (kind) => {
      const directoryFailure =
        kind === "directory"
          ? new WorkspaceReadError("private directory message", "")
          : new StructuralExecutionStoppedError(kind);
      const fixture = concurrentFixture(directoryFailure, rescue);
      const result = collectStreamedSearchText(
        fixture.runner,
        createStructuralExecutionControl(null),
      );
      const outcome = result.catch((error: unknown) => error);
      await fixture.readsStarted;
      fixture.releaseReads();
      const error: unknown = await outcome;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new TypeError("Expected collected failures.");
      const failures: unknown[] = error.errors;
      expect(failures).toHaveLength(3);
      expect(failures).toContain(directoryFailure);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestedPath: `${rescue ? "dist/" : ""}a.txt`,
            cause: fixture.failures[0],
          }),
          expect.objectContaining({
            requestedPath: `${rescue ? "dist/" : ""}b.txt`,
            cause: fixture.failures[1],
          }),
        ]),
      );
      expect(error.cause).not.toBeInstanceOf(StructuralExecutionStoppedError);
      expect(error.message).not.toContain("PRIVATE_");
    },
  );
});
