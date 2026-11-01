import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { plantDirectoryRedirect } from "../symlinkFixture.test-support.js";
import { sweepOrphanedOpenCodeRunState } from "./opencodeRunStateSweep.js";

const roots: string[] = [];

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-run-state-sweep-")));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runDirectory(base: string, runId: string): string {
  const directory = join(base, runId);
  mkdirSync(join(directory, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "state", "opencode.db"), "PRIVATE_DATABASE_BYTES");
  return directory;
}

function records(): {
  readonly sink: { readonly record: (record: ServerDiagnosticRecord) => void };
  readonly seen: ServerDiagnosticRecord[];
} {
  const seen: ServerDiagnosticRecord[] = [];
  return { seen, sink: { record: (record): void => void seen.push(record) } };
}

// Audit finding 8: a crash, or a disposal that failed, left a run's OpenCode database and
// configuration under the owned state directory for good.
describe("orphaned OpenCode run state sweep", () => {
  it("removes the state of runs that are neither live nor recoverable and keeps the rest", () => {
    const base = join(scratch(), "coding-runtime", "opencode");
    const orphan = runDirectory(base, "run-100");
    const recoverable = runDirectory(base, "run-200");
    const diagnostics = records();

    const result = sweepOrphanedOpenCodeRunState({
      stateBaseRoot: base,
      isRetained: (runId) => runId === "run-200",
      diagnostics: diagnostics.sink,
    });

    expect(result).toEqual({ scanned: 2, removed: 1, retained: 1, skipped: 0, failed: 0 });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(recoverable)).toBe(true);
    expect(diagnostics.seen).toHaveLength(1);
    expect(diagnostics.seen[0]).toMatchObject({
      operation: "coding-runtime.run-state",
      source: "opencode.run-state.sweep",
      code: "stage=startup:reason=orphaned-run-state:scanned=2:removed=1:retained=1:skipped=0:failed=0",
    });
    expect(JSON.stringify(diagnostics.seen)).not.toContain(base);
    expect(JSON.stringify(diagnostics.seen)).not.toContain("PRIVATE_DATABASE_BYTES");
  });

  it("writes nothing when there is nothing to remove", () => {
    const base = join(scratch(), "opencode");
    runDirectory(base, "run-1");
    const diagnostics = records();

    const result = sweepOrphanedOpenCodeRunState({
      stateBaseRoot: base,
      isRetained: () => true,
      diagnostics: diagnostics.sink,
    });

    expect(result).toEqual({ scanned: 1, removed: 0, retained: 1, skipped: 0, failed: 0 });
    expect(diagnostics.seen).toEqual([]);
    expect(
      sweepOrphanedOpenCodeRunState({
        stateBaseRoot: join(base, "missing"),
        isRetained: () => false,
        diagnostics: diagnostics.sink,
      }),
    ).toEqual({ scanned: 0, removed: 0, retained: 0, skipped: 0, failed: 0 });
  });

  it("never follows or removes a symbolic link, a file or a name that is not a run id", () => {
    const outside = scratch();
    writeFileSync(join(outside, "sentinel.txt"), "KEEP");
    const base = join(scratch(), "opencode");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    plantDirectoryRedirect(outside, join(base, "run-linked"));
    writeFileSync(join(base, "run-file"), "not a directory");
    mkdirSync(join(base, "not a run id"));

    const result = sweepOrphanedOpenCodeRunState({ stateBaseRoot: base, isRetained: () => false });

    expect(result).toEqual({ scanned: 1, removed: 0, retained: 0, skipped: 1, failed: 0 });
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("KEEP");
    expect(existsSync(join(base, "run-linked"))).toBe(true);
    expect(existsSync(join(base, "run-file"))).toBe(true);
    expect(existsSync(join(base, "not a run id"))).toBe(true);
  });

  it("does not scan through a base directory that is itself a symbolic link", () => {
    const real = scratch();
    const orphan = runDirectory(real, "run-1");
    const link = join(scratch(), "opencode");
    plantDirectoryRedirect(real, link);

    const result = sweepOrphanedOpenCodeRunState({ stateBaseRoot: link, isRetained: () => false });

    expect(result.scanned).toBe(0);
    expect(existsSync(orphan)).toBe(true);
  });

  it("counts a failed removal, keeps sweeping, and names the cause by class and frames only", () => {
    const base = join(scratch(), "opencode");
    runDirectory(base, "run-1");
    const second = runDirectory(base, "run-2");
    const diagnostics = records();

    const result = sweepOrphanedOpenCodeRunState({
      stateBaseRoot: base,
      isRetained: () => false,
      diagnostics: diagnostics.sink,
      remove: (path) => {
        if (path.endsWith("run-1")) throw new RangeError(`EACCES ${path}`);
        rmSync(path, { recursive: true, force: true });
      },
    });

    expect(result).toEqual({ scanned: 2, removed: 1, retained: 0, skipped: 0, failed: 1 });
    expect(existsSync(second)).toBe(false);
    expect(diagnostics.seen.map((record) => record.code)).toEqual([
      "stage=startup:reason=orphaned-run-state-remove-failed",
      "stage=startup:reason=orphaned-run-state:scanned=2:removed=1:retained=0:skipped=0:failed=1",
    ]);
    expect(diagnostics.seen[0]?.errorClass).toBe("RangeError");
    expect(JSON.stringify(diagnostics.seen)).not.toContain(base);
  });
});
