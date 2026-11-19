// Windows keeps an exited helper's file open for a moment, so removing its private copy can be
// refused transiently (EPERM, EBUSY). The removal retries within a fixed bound; only a copy that
// stays is a failure.
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultServerDiagnosticSink, type ServerDiagnosticRecord } from "../diagnostics-log.js";
import {
  discardVerifiedHelperCopy,
  onFirstCall,
  removeHelperCopyDirectory,
} from "./nativeRuntimeProcessBackend.js";

function refusal(code: string): Error {
  return Object.assign(new Error("refused"), { code });
}

describe("removeHelperCopyDirectory", () => {
  it.each(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"])(
    "retries a transient %s refusal and then succeeds",
    async (code) => {
      const waits: number[] = [];
      let attempts = 0;
      await removeHelperCopyDirectory("copy", {
        remove: () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(refusal(code)) : Promise.resolve();
        },
        sleep: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      });
      expect(attempts).toBe(2);
      expect(waits).toEqual([50]);
    },
  );

  it("gives up with the original error after a bounded number of attempts", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const error = refusal("EPERM");
    await expect(
      removeHelperCopyDirectory("copy", {
        remove: () => {
          attempts += 1;
          return Promise.reject(error);
        },
        sleep: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(6);
    expect(waits).toEqual([50, 100, 200, 400, 800]);
  });

  it("does not retry a refusal that is not transient", async () => {
    let attempts = 0;
    const error = refusal("EIO");
    await expect(
      removeHelperCopyDirectory("copy", {
        remove: () => {
          attempts += 1;
          return Promise.reject(error);
        },
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});

// A helper reports its end through its exit, its error or both. Two removals of the same copy
// would race on one folder, and a copy that stays would be recorded twice.
describe("onFirstCall", () => {
  it("runs the action once, however often the end is reported", () => {
    let runs = 0;
    const discard = onFirstCall(() => {
      runs += 1;
    });
    discard();
    discard();
    discard();
    expect(runs).toBe(1);
  });
});

describe("discardVerifiedHelperCopy", () => {
  const FAILURE = { operation: "coding.runtime.native-helper.cleanup", source: "test" } as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function recorded(): ServerDiagnosticRecord[] {
    const records: ServerDiagnosticRecord[] = [];
    vi.spyOn(defaultServerDiagnosticSink, "record").mockImplementation((record) => {
      records.push(record);
    });
    return records;
  }

  it("records a copy that stays under the run that owns the helper, without its path", async () => {
    const records = recorded();
    const error = Object.assign(
      new Error("EPERM: operation not permitted, rmdir 'C:\\Users\\Jo\\private-folder'"),
      { code: "EPERM" },
    );
    await discardVerifiedHelperCopy(
      { path: "C:\\Users\\Jo\\private-folder\\helper.exe", cleanup: () => Promise.reject(error) },
      { ...FAILURE, correlationId: "run-native-helper-01" },
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: "run-native-helper-01",
      operation: FAILURE.operation,
      code: "EPERM",
    });
    // The error's text names the folder; the record keeps the closed code and no part of the path.
    const line = JSON.stringify(records[0]);
    for (const part of ["private-folder", "Users", "rmdir"]) expect(line).not.toContain(part);
  });

  it("records nothing for a copy that was removed, and never rejects", async () => {
    const records = recorded();
    await expect(
      discardVerifiedHelperCopy({ path: "copy", cleanup: () => Promise.resolve() }, FAILURE),
    ).resolves.toBeUndefined();
    expect(records).toEqual([]);
  });
});
