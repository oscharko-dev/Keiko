import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memFs } from "./_memfs.js";
import { PathDeniedError } from "./errors.js";
import type {
  WorkspaceDescriptorUtf8Read,
  WorkspaceDirEntry,
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
  it.each(["aborted", "timeout"] as const)(
    "settles a stalled directory next on %s before its queued cleanup can finish",
    async (reason) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const entered = deferred<undefined>();
      const releaseRead = deferred<undefined>();
      const closed = deferred<undefined>();
      const abort = new AbortController();
      let closeCount = 0;
      let outcome: unknown;
      const fs: WorkspaceFs = {
        ...memFs(ROOT, {}),
        iterateDirectory: async function* () {
          try {
            entered.resolve(undefined);
            await releaseRead.promise;
            yield { name: "late", isDirectory: false, isFile: true, isSymbolicLink: false };
          } finally {
            closeCount += 1;
            closed.resolve(undefined);
          }
        },
      };
      const controlled = executionControlledWorkspaceFs(fs, {
        nowMs: () => 0,
        deadlineAtMs: reason === "timeout" ? 10 : Infinity,
        signal: abort.signal,
      });
      const iterator = controlled.iterateDirectory?.(ROOT)[Symbol.asyncIterator]();
      if (iterator === undefined) throw new Error("missing controlled iterator");
      const next = iterator.next().catch((error: unknown) => {
        outcome = error;
      });
      await entered.promise;
      if (reason === "aborted") abort.abort();
      else await vi.advanceTimersByTimeAsync(10);
      await setImmediate();
      try {
        expect(outcome).toBeInstanceOf(StructuralExecutionStoppedError);
        expect(outcome).toMatchObject({ reason });
        expect(closeCount).toBe(0);
      } finally {
        releaseRead.resolve(undefined);
        await next;
        await iterator.return?.();
        await closed.promise;
      }
      expect(closeCount).toBe(1);
    },
  );

  it("keeps prototype adapter methods bound and does not invent an absent iterator", async () => {
    class DirectoryAdapter {
      private readonly name = "prototype.txt";
      public async *iterateDirectory(path: string): AsyncIterable<WorkspaceDirEntry> {
        await Promise.resolve();
        expect(path).toBe(ROOT);
        yield { name: this.name, isDirectory: false, isFile: true, isSymbolicLink: false };
      }
    }
    const control = { nowMs: (): number => 0, deadlineAtMs: Infinity };
    const base = memFs(ROOT, {});
    expect(executionControlledWorkspaceFs(base, control).iterateDirectory).toBeUndefined();
    const fs = Object.assign(new DirectoryAdapter(), base);
    const wrapped = executionControlledWorkspaceFs(fs, control);
    const names: string[] = [];
    for await (const entry of wrapped.iterateDirectory?.(ROOT) ?? []) names.push(entry.name);
    expect(names).toEqual(["prototype.txt"]);
  });

  it.each(["aborted", "timeout"] as const)(
    "stops between directory entries and closes the underlying iterator on %s",
    async (reason) => {
      let closed = false;
      let clock = 0;
      const abort = new AbortController();
      const fs: WorkspaceFs = {
        ...memFs(ROOT, {}),
        iterateDirectory: async function* () {
          await Promise.resolve();
          try {
            for (const name of ["first", "second"])
              yield { name, isDirectory: false, isFile: true, isSymbolicLink: false };
          } finally {
            closed = true;
          }
        },
      };
      const controlled = executionControlledWorkspaceFs(fs, {
        nowMs: () => clock,
        deadlineAtMs: 10,
        signal: abort.signal,
      });
      const iterator = controlled.iterateDirectory?.(ROOT)[Symbol.asyncIterator]();
      if (iterator === undefined) throw new Error("missing controlled iterator");
      expect(await iterator.next()).toMatchObject({ done: false, value: { name: "first" } });
      if (reason === "aborted") abort.abort();
      else clock = 10;
      await expect(iterator.next()).rejects.toMatchObject({ reason });
      expect(closed).toBe(true);
    },
  );

  it("preserves the directory iterator receiver and closes it on early exit", async (): Promise<void> => {
    let closed = false;
    const fs: WorkspaceFs = {
      ...memFs(ROOT, { "entry.txt": "text" }),
      iterateDirectory: async function* (path) {
        await Promise.resolve();
        expect(this).toBe(fs);
        expect(path).toBe(ROOT);
        try {
          yield { name: "entry.txt", isDirectory: false, isFile: true, isSymbolicLink: false };
        } finally {
          closed = true;
        }
      },
    };
    const controlled = executionControlledWorkspaceFs(fs, {
      nowMs: () => 0,
      deadlineAtMs: Infinity,
    });
    const entries = controlled.iterateDirectory?.(ROOT);
    if (entries === undefined) throw new Error("missing controlled iterator");
    for await (const entry of entries) {
      expect(entry.name).toBe("entry.txt");
      break;
    }
    expect(closed).toBe(true);
  });

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
