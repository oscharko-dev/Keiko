import { afterEach, describe, expect, it, vi } from "vitest";
import { memFs } from "./_memfs.js";
import { PathDeniedError } from "./errors.js";
import type {
  WorkspaceDescriptorUtf8Read,
  WorkspaceFileReader,
  WorkspaceFs,
  WorkspaceStat,
} from "./fs.js";
import { workspaceFsWithOwnedRootAuthority } from "./ownedRootMint.js";
import { resolveExistingAllowedWorkspaceRealRoot } from "./realpath.js";
import {
  executionControlledWorkspaceFs,
  sameStructuralExecutionFs,
  StructuralExecutionStoppedError,
  type StructuralExecutionControl,
} from "./structuralExecution.js";

const ROOT = "/ws";
const EXPECTED_FILE_STAT: WorkspaceStat = {
  size: 4,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

interface WriteCapableTestFs extends WorkspaceFs {
  readonly makeDir: () => void;
  readonly writeFileUtf8: () => void;
}

function fullWorkspaceFs(onTouch: () => void): WriteCapableTestFs {
  const base = memFs(ROOT, { "src/a.ts": "text" });
  return {
    ...base,
    canonicalWorkspaceRoot: (root): string => {
      onTouch();
      return root;
    },
    readFileUtf8SameDescriptor: (path, maxBytes): WorkspaceDescriptorUtf8Read => {
      onTouch();
      const rawText = base.readFileUtf8(path).slice(0, maxBytes);
      return { rawText, sizeBytes: Buffer.byteLength(rawText), stat: base.stat(path) };
    },
    readFileUtf8WithinRootSameDescriptor: (_root, path, maxBytes): WorkspaceDescriptorUtf8Read => {
      onTouch();
      const rawText = base.readFileUtf8(path).slice(0, maxBytes);
      return { rawText, sizeBytes: Buffer.byteLength(rawText), stat: base.stat(path) };
    },
    makeDir: (): void => {
      onTouch();
    },
    writeFileUtf8: (): void => {
      onTouch();
    },
    openFileReader: (): Promise<WorkspaceFileReader> => {
      onTouch();
      return Promise.resolve({
        readRange: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
        close: (): Promise<void> => Promise.resolve(),
      });
    },
  };
}

function synchronousOperations(fs: WorkspaceFs): readonly (() => unknown)[] {
  return [
    (): unknown => fs.readFileUtf8(`${ROOT}/src/a.ts`),
    (): unknown =>
      fs.readFileUtf8SameDescriptor?.(`${ROOT}/src/a.ts`, 4, "reject", EXPECTED_FILE_STAT),
    (): unknown =>
      fs.readFileUtf8WithinRootSameDescriptor?.(ROOT, `${ROOT}/src/a.ts`, 4, "reject", "complete"),
    (): unknown => fs.stat(`${ROOT}/src/a.ts`),
    (): unknown => fs.readDir(ROOT),
    (): unknown => fs.realPath(ROOT),
    (): unknown => fs.canonicalWorkspaceRoot?.(ROOT),
    (): unknown => fs.exists(ROOT),
    (): unknown => fs.readFileBytes?.(`${ROOT}/src/a.ts`, 4, "reject", EXPECTED_FILE_STAT),
    (): unknown => fs.readFileUtf8Prefix?.(`${ROOT}/src/a.ts`, 4, "reject", EXPECTED_FILE_STAT),
    (): unknown => fs.readFileRange?.(`${ROOT}/src/a.ts`, 0, 4, "reject", EXPECTED_FILE_STAT),
  ];
}

describe("executionControlledWorkspaceFs", () => {
  it("preserves exact owned-root authority without authorizing a sibling", () => {
    const root = "/home/user/.keiko/task-workspaces/repo_a/ws_b";
    const source = workspaceFsWithOwnedRootAuthority(memFs(root, {}), root);
    const controlled = executionControlledWorkspaceFs(source, {
      nowMs: () => 0,
      deadlineAtMs: 1,
    });

    expect(resolveExistingAllowedWorkspaceRealRoot(controlled, root)).toBe(root);
    expect(() => resolveExistingAllowedWorkspaceRealRoot(controlled, `${root}/../ws_c`)).toThrow(
      PathDeniedError,
    );
    expect(sameStructuralExecutionFs(controlled, source)).toBe(true);
  });

  it("rejects every filesystem operation without touching the port after expiry", async () => {
    let touches = 0;
    const control: StructuralExecutionControl = { nowMs: () => 10, deadlineAtMs: 10 };
    const fs = executionControlledWorkspaceFs(
      fullWorkspaceFs(() => {
        touches += 1;
      }),
      control,
    );

    for (const operation of synchronousOperations(fs)) {
      expect(operation).toThrow(StructuralExecutionStoppedError);
    }
    await expect(
      fs.openFileReader?.(`${ROOT}/src/a.ts`, "reject", EXPECTED_FILE_STAT),
    ).rejects.toBeInstanceOf(StructuralExecutionStoppedError);
    expect("makeDir" in fs).toBe(false);
    expect("writeFileUtf8" in fs).toBe(false);
    expect(touches).toBe(0);
  });

  it("allows descriptor cleanup after expiry while blocking a new range read", async () => {
    let currentMs = 0;
    let opens = 0;
    let reads = 0;
    let closes = 0;
    const base = memFs(ROOT, { "src/a.ts": "text" });
    const fs: WorkspaceFs = {
      ...base,
      openFileReader: (): Promise<WorkspaceFileReader> => {
        opens += 1;
        return Promise.resolve({
          readRange: (): Promise<Uint8Array> => {
            reads += 1;
            return Promise.resolve(new Uint8Array());
          },
          close: (): Promise<void> => {
            closes += 1;
            return Promise.resolve();
          },
        });
      },
    };
    const controlled = executionControlledWorkspaceFs(fs, {
      nowMs: () => currentMs,
      deadlineAtMs: 10,
    });

    const reader = await controlled.openFileReader?.(
      `${ROOT}/src/a.ts`,
      "reject",
      EXPECTED_FILE_STAT,
    );
    if (reader === undefined) throw new TypeError("missing controlled reader");
    currentMs = 10;
    expect(() => reader.readRange(0, 1)).toThrow(StructuralExecutionStoppedError);
    await reader.close();

    expect({ opens, reads, closes }).toEqual({ opens: 1, reads: 0, closes: 1 });
  });

  it("bounds a never-settling byte read by the absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pending = deferred<Uint8Array>();
    const base = memFs(ROOT, { "src/a.ts": "text" });
    const fs = executionControlledWorkspaceFs(
      { ...base, readFileBytes: (): Promise<Uint8Array> => pending.promise },
      { nowMs: Date.now, deadlineAtMs: 10 },
    );

    const outcome = fs.readFileBytes?.(`${ROOT}/src/a.ts`, 4, "reject", EXPECTED_FILE_STAT);
    const expectation = expect(outcome).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(10);

    await expectation;
    pending.reject(new Error("late byte-read rejection"));
    await Promise.resolve();
  });

  it("classifies a byte-read rejection after the deadline as a timeout", async () => {
    let currentMs = 0;
    const base = memFs(ROOT, { "src/a.ts": "text" });
    const fs = executionControlledWorkspaceFs(
      {
        ...base,
        readFileBytes: async (): Promise<Uint8Array> => {
          await Promise.resolve();
          currentMs = 10;
          throw new Error("underlying read failure");
        },
      },
      { nowMs: () => currentMs, deadlineAtMs: 10 },
    );

    await expect(
      fs.readFileBytes?.(`${ROOT}/src/a.ts`, 4, "reject", EXPECTED_FILE_STAT),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("removes the abort listener after cancelling a never-settling range read", async () => {
    const pending = deferred<Uint8Array>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const base = memFs(ROOT, { "src/a.ts": "text" });
    const fs = executionControlledWorkspaceFs(
      { ...base, readFileRange: (): Promise<Uint8Array> => pending.promise },
      {
        nowMs: () => 0,
        deadlineAtMs: Number.POSITIVE_INFINITY,
        signal: controller.signal,
      },
    );

    const outcome = fs.readFileRange?.(`${ROOT}/src/a.ts`, 0, 4, "reject", EXPECTED_FILE_STAT);
    const expectation = expect(outcome).rejects.toMatchObject({ reason: "aborted" });
    controller.abort();

    await expectation;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    pending.resolve(new Uint8Array([1]));
    await Promise.resolve();
  });

  it("does not let Node clamp a far-future deadline to an immediate timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pending = deferred<Uint8Array>();
    const controller = new AbortController();
    const base = memFs(ROOT, { "src/a.ts": "text" });
    const fs = executionControlledWorkspaceFs(
      { ...base, readFileBytes: (): Promise<Uint8Array> => pending.promise },
      {
        nowMs: Date.now,
        deadlineAtMs: 2_147_483_647 + 1_000,
        signal: controller.signal,
      },
    );

    const outcome = fs.readFileBytes?.(`${ROOT}/src/a.ts`, 4, "reject", EXPECTED_FILE_STAT);
    let settled = false;
    void outcome?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);

    const expectation = expect(outcome).rejects.toMatchObject({ reason: "aborted" });
    controller.abort();
    await expectation;
    pending.resolve(new Uint8Array());
  });

  it("closes a descriptor that opens only after caller cancellation", async () => {
    const opened = deferred<WorkspaceFileReader>();
    const controller = new AbortController();
    let closes = 0;
    const base = memFs(ROOT, { "src/a.ts": "text" });
    const fs = executionControlledWorkspaceFs(
      { ...base, openFileReader: (): Promise<WorkspaceFileReader> => opened.promise },
      {
        nowMs: () => 0,
        deadlineAtMs: Number.POSITIVE_INFINITY,
        signal: controller.signal,
      },
    );
    const outcome = fs.openFileReader?.(`${ROOT}/src/a.ts`, "reject", EXPECTED_FILE_STAT);
    const expectation = expect(outcome).rejects.toMatchObject({ reason: "aborted" });

    controller.abort();
    await expectation;
    opened.resolve({
      readRange: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
      close: (): Promise<void> => {
        closes += 1;
        return Promise.resolve();
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(closes).toBe(1);
  });

  it("fails closed without touching the filesystem for a NaN deadline", () => {
    let touches = 0;
    const fs = executionControlledWorkspaceFs(
      fullWorkspaceFs(() => {
        touches += 1;
      }),
      { nowMs: () => 0, deadlineAtMs: Number.NaN },
    );

    expect(() => fs.readFileUtf8(`${ROOT}/src/a.ts`)).toThrow(StructuralExecutionStoppedError);
    expect(touches).toBe(0);
  });
});
