import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerConflictBridge,
  type ConflictBridge,
  type ConflictEditor,
  type ConflictModel,
} from "./conflict-bridge.js";

const SOURCE = "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n";
const DIFF3 = "<<<<<<< local\nleft\n||||||| base\nold\n=======\nright\n>>>>>>> remote\n";

function model(initialText = SOURCE): ConflictModel & {
  version: number;
  fire(): void;
  setText(value: string): void;
} {
  const listeners = new Set<() => void>();
  let text = initialText;
  return {
    version: 1,
    getValue: (): string => text,
    getVersionId(): number {
      return this.version;
    },
    getPositionAt: (offset): { readonly lineNumber: number; readonly column: number } => {
      const before = text.slice(0, offset).split("\n");
      return { lineNumber: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
    },
    onDidChangeContent: (listener): { dispose(): void } => {
      listeners.add(listener);
      return {
        dispose: (): void => {
          listeners.delete(listener);
        },
      };
    },
    fire: (): void => {
      for (const listener of listeners) listener();
    },
    setText: (value): void => {
      text = value;
    },
  };
}

interface Harness {
  readonly bridge: ConflictBridge;
  readonly initialModel: ReturnType<typeof model>;
  readonly editor: ConflictEditor & {
    readonly setPosition: ReturnType<typeof vi.fn>;
    readonly deltaDecorations: ReturnType<typeof vi.fn>;
  };
  readonly executeEdits: ReturnType<typeof vi.fn>;
  readonly pushUndoStop: ReturnType<typeof vi.fn>;
  readonly actions: ReadonlyMap<string, () => void | Promise<void>>;
  readonly onChange: ReturnType<typeof vi.fn>;
  readonly onStale: ReturnType<typeof vi.fn>;
  readonly setModel: (next: ConflictModel | null) => void;
}

function setup(
  text = SOURCE,
  digest: ((value: string) => Promise<string>) | null = (value) => Promise.resolve(value),
  initialLine: number | null = 1,
): Harness {
  const initialModel = model(text);
  let current: ConflictModel | null = initialModel;
  let line = initialLine;
  const executeEdits = vi.fn(() => true);
  const pushUndoStop = vi.fn(() => true);
  const actions = new Map<string, () => void | Promise<void>>();
  const onChange = vi.fn();
  const onStale = vi.fn();
  const editor = {
    getModel: (): ConflictModel | null => current,
    getPosition: (): { readonly lineNumber: number; readonly column: number } | null =>
      line === null ? null : { lineNumber: line, column: 1 },
    setPosition: vi.fn((position: { lineNumber: number }) => {
      line = position.lineNumber;
    }),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    deltaDecorations: vi.fn((_old, next: readonly unknown[]) =>
      next.map((_, index) => `d${String(index)}`),
    ),
    addAction: vi.fn((action: { id: string; run: () => void | Promise<void> }) => {
      actions.set(action.id, action.run);
      return { dispose: vi.fn() };
    }),
    executeEdits,
    pushUndoStop,
  };
  const bridge = registerConflictBridge({
    editor,
    labels: { next: "Next", previous: "Previous", ours: "Ours", theirs: "Theirs", both: "Both" },
    onChange,
    onStale,
    ...(digest === null ? {} : { digest }),
  });
  return {
    bridge,
    initialModel,
    editor,
    executeEdits,
    pushUndoStop,
    actions,
    onChange,
    onStale,
    setModel: (next: ConflictModel | null): void => {
      current = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("registerConflictBridge", () => {
  it.each([
    ["keiko.editor.acceptConflictOurs", "left\n"],
    ["keiko.editor.acceptConflictTheirs", "right\n"],
    ["keiko.editor.acceptConflictBoth", "left\nright\n"],
  ])("resolves %s as one edit bracketed by undo stops", async (action, replacement) => {
    vi.useFakeTimers();
    const harness = setup();
    await vi.runAllTimersAsync();

    await harness.actions.get(action)?.();

    expect(harness.executeEdits).toHaveBeenCalledTimes(1);
    expect(harness.executeEdits).toHaveBeenCalledWith("keiko.mergeConflict", [
      expect.objectContaining({ text: replacement }),
    ]);
    expect(harness.pushUndoStop).toHaveBeenCalledTimes(2);
    harness.bridge.dispose();
  });

  it("wraps navigation in both directions", async () => {
    vi.useFakeTimers();
    const harness = setup();
    await vi.runAllTimersAsync();

    harness.bridge.next();
    harness.bridge.previous();
    expect(harness.editor.setPosition).toHaveBeenCalledTimes(2);
    harness.bridge.dispose();
  });

  it("navigates three conflicts in both directions with wraparound", async () => {
    vi.useFakeTimers();
    const harness = setup(`${SOURCE}${DIFF3}${SOURCE}`);
    await vi.runAllTimersAsync();

    harness.bridge.previous();
    expect(harness.editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 13, column: 1 });
    harness.bridge.next();
    expect(harness.editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 1, column: 1 });
  });

  it("starts navigation at either edge when the cursor is outside every conflict", async () => {
    vi.useFakeTimers();
    const next = setup(`${SOURCE}${SOURCE}`, undefined, null);
    const previous = setup(`${SOURCE}${SOURCE}`, undefined, 999);
    await vi.runAllTimersAsync();

    next.bridge.next();
    previous.bridge.previous();
    expect(next.editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 1, column: 1 });
    expect(previous.editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 6, column: 1 });
  });

  it("uses Web Crypto SHA-256 and tolerates a model removed before the initial scan", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer) },
    });
    const cryptoHarness = setup(SOURCE, null);
    const removed = setup();
    removed.setModel(null);
    await vi.runAllTimersAsync();

    await cryptoHarness.bridge.accept("ours");
    expect(cryptoHarness.executeEdits).toHaveBeenCalledOnce();
    expect(removed.onChange).not.toHaveBeenCalled();
  });

  it("rejects stale model versions and model/tab swaps without editing", async () => {
    vi.useFakeTimers();
    const versionHarness = setup();
    await vi.runAllTimersAsync();
    versionHarness.initialModel.version = 2;
    await versionHarness.bridge.accept("ours");
    expect(versionHarness.executeEdits).not.toHaveBeenCalled();

    const modelHarness = setup();
    await vi.runAllTimersAsync();
    modelHarness.setModel(model("plain text\n"));
    await modelHarness.bridge.accept("theirs");
    expect(modelHarness.executeEdits).not.toHaveBeenCalled();
  });

  it("rejects a digest mismatch on the same model and version", async () => {
    vi.useFakeTimers();
    const harness = setup();
    await vi.runAllTimersAsync();
    harness.initialModel.setText(SOURCE.replace("left", "changed"));

    await harness.bridge.accept("ours");

    expect(harness.executeEdits).not.toHaveBeenCalled();
    expect(harness.onStale).toHaveBeenCalledOnce();
  });

  it("rejects a same-model edit made while the digest check is pending", async () => {
    vi.useFakeTimers();
    let completeDigest: (() => void) | undefined;
    let calls = 0;
    const digest = (value: string): Promise<string> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(value);
      return new Promise((resolve) => {
        completeDigest = (): void => {
          resolve(value);
        };
      });
    };
    const harness = setup(SOURCE, digest);
    await vi.runAllTimersAsync();
    const acceptance = harness.bridge.accept("ours");
    await Promise.resolve();
    harness.initialModel.setText(`prefix\n${SOURCE}`);
    harness.initialModel.version += 1;
    completeDigest?.();
    await acceptance;

    expect(harness.executeEdits).not.toHaveBeenCalled();
    expect(harness.onStale).toHaveBeenCalledOnce();
  });

  it("fails closed when SHA-256 is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", undefined);
    const harness = setup(SOURCE, null);
    await vi.runAllTimersAsync();

    await harness.bridge.accept("ours");

    expect(harness.onChange).toHaveBeenCalledWith(0, true);
    expect(harness.executeEdits).not.toHaveBeenCalled();
  });

  it("handles an accept-time digest failure without editing or rejecting", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const harness = setup(SOURCE, (value) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("digest unavailable")) : Promise.resolve(value);
    });
    await vi.runAllTimersAsync();

    await expect(harness.bridge.accept("ours")).resolves.toBeUndefined();

    expect(harness.executeEdits).not.toHaveBeenCalled();
    expect(harness.onStale).toHaveBeenCalledOnce();
    harness.bridge.dispose();
  });

  it("does no navigation or editing work when the model has no conflicts", async () => {
    vi.useFakeTimers();
    const harness = setup("plain text\n");
    await vi.runAllTimersAsync();

    harness.bridge.next();
    harness.bridge.previous();
    await harness.bridge.accept("both");

    expect(harness.editor.setPosition).not.toHaveBeenCalled();
    expect(harness.executeEdits).not.toHaveBeenCalled();
    expect(harness.editor.deltaDecorations).toHaveBeenCalledWith([], []);
  });

  it("coalesces content scans and keeps decoration identities separate", async () => {
    vi.useFakeTimers();
    const harness = setup();
    await vi.runAllTimersAsync();
    harness.initialModel.fire();
    harness.initialModel.fire();
    harness.initialModel.fire();
    await vi.runAllTimersAsync();
    expect(harness.editor.deltaDecorations).toHaveBeenCalledTimes(2);
    expect(harness.editor.deltaDecorations.mock.calls[0]?.[1]).toHaveLength(2);
  });
});
