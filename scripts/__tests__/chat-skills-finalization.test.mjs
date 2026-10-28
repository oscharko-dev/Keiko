import { readFileSync } from "node:fs";
import { URL } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as runtimeOwner from "../testing/chat-skills-lab/runtime.mjs";

const source = readFileSync(new URL("../testing/chat-skills-lab/run.mjs", import.meta.url), "utf8");
const tree = ts.createSourceFile(
  "caller.mjs",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const finalizers = tree.statements.filter((node) => ts.isTryStatement(node) && node.finallyBlock);
if (finalizers.length !== 1) throw new Error("qualification-finalizer-owner-ambiguous");
const execute = new Function(
  "ledger",
  "runtime",
  "process",
  "save",
  "finalizeRuntime",
  `return (async () => ${finalizers[0].finallyBlock.getText(tree)})();`,
);

function containsFailure(actual, expected) {
  return (
    actual === expected ||
    (actual instanceof AggregateError &&
      actual.errors.some((error) => containsFailure(error, expected)))
  );
}

describe("actual public Chat skill CLI finalizer", () => {
  it.each([
    ["healthy", false, false],
    ["drain refusal", true, false],
    ["close refusal", false, true],
    ["drain and close refusal", true, true],
  ])("saves evidence and preserves all failures after %s", async (_name, failDrain, failClose) => {
    const drainFailure = new Error("synthetic-drain-refusal"),
      closeFailure = new Error("synthetic-close-refusal");
    const runtime = {
      drain: vi.fn(async () => {
        if (failDrain) throw drainFailure;
      }),
      close: vi.fn(async () => {
        if (failClose) throw closeFailure;
      }),
    };
    const save = vi.fn();
    const [result] = await Promise.allSettled([
      execute([], runtime, { exitCode: 0 }, save, runtimeOwner.finalizeRuntime),
    ]);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(result.status).toBe(failDrain || failClose ? "rejected" : "fulfilled");
    if (failDrain) expect(containsFailure(result.reason, drainFailure)).toBe(true);
    if (failClose) expect(containsFailure(result.reason, closeFailure)).toBe(true);
  });

  it("records failed finalization and a failing exit disposition before saving", async () => {
    const failure = new Error("synthetic-close-refusal");
    const save = vi.fn(),
      processState = { exitCode: 0 };
    await expect(
      execute(
        [],
        {
          drain: vi.fn(),
          close() {
            throw failure;
          },
        },
        processState,
        save,
        runtimeOwner.finalizeRuntime,
      ),
    ).rejects.toBe(failure);
    expect(processState.exitCode).toBe(1);
    expect(save).toHaveBeenCalledExactlyOnceWith({
      status: "failed",
      drain: "fulfilled",
      close: "rejected",
    });
  });
});

describe("shared qualification finalization", () => {
  it("attempts all operations and retains synchronous drain, close and save failures", async () => {
    const failures = [new Error("drain"), new Error("close"), new Error("save")];
    const close = vi.fn(() => {
      throw failures[1];
    });
    const save = vi.fn(() => {
      throw failures[2];
    });
    const error = await runtimeOwner
      .finalizeRuntime(
        {
          drain() {
            throw failures[0];
          },
          close,
        },
        save,
      )
      .catch((failure) => failure);
    expect(close).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual(failures);
    expect(error.cause).toBe(failures[0]);
  });

  it("records no started runtime without inventing process operations", async () => {
    const save = vi.fn();
    await runtimeOwner.finalizeRuntime(undefined, save);
    expect(save).toHaveBeenCalledExactlyOnceWith({
      status: "not-started",
      drain: "not-started",
      close: "not-started",
    });
  });

  it("preserves a save failure after healthy cleanup", async () => {
    const failure = new Error("synthetic-save-refusal");
    const close = vi.fn();
    await expect(
      runtimeOwner.finalizeRuntime({ drain: vi.fn(), close }, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not swallow an undefined rejection reason", async () => {
    const save = vi.fn();
    const [result] = await Promise.allSettled([
      runtimeOwner.finalizeRuntime(
        { drain: () => Promise.reject(undefined), close: vi.fn() },
        save,
      ),
    ]);
    expect(result.status).toBe("rejected");
    expect(save).toHaveBeenCalledOnce();
  });
});
