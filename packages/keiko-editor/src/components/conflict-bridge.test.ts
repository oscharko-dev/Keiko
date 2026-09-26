import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerConflictBridge,
  type ConflictBridge,
  type ConflictEditor,
  type ConflictModel,
} from "./conflict-bridge.js";

const SOURCE = "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n";
const DIFF3 = "<<<<<<< local\nleft\n||||||| base\nold\n=======\nright\n>>>>>>> remote\n";
const ACCEPTANCE_ACTIONS = [
  ["ours", "keiko.editor.acceptConflictOurs"],
  ["theirs", "keiko.editor.acceptConflictTheirs"],
  ["both", "keiko.editor.acceptConflictBoth"],
] as const;

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
  /** Fires the editor's `onDidChangeModel` listeners, mirroring real Monaco's own event order:
   * `getModel()` already returns the new model by the time this fires. Deliberately separate from
   * `setModel` -- most existing cases in this file swap the model WITHOUT firing the event, to
   * exercise the accept()-time staleness guard independently of model-change notification. */
  readonly fireModelChange: () => void;
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
  const modelListeners = new Set<() => void>();
  const editor = {
    getModel: (): ConflictModel | null => current,
    onDidChangeModel: (listener: () => void): { dispose(): void } => {
      modelListeners.add(listener);
      return {
        dispose: (): void => {
          modelListeners.delete(listener);
        },
      };
    },
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
    fireModelChange: (): void => {
      for (const listener of modelListeners) listener();
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
    expect(harness.editor.setPosition.mock.calls).toHaveLength(2);
    harness.bridge.dispose();
  });

  it("rebinds to a new model after a file switch and detects its conflicts (KEIKO-0034)", async () => {
    vi.useFakeTimers();
    const harness = setup(SOURCE);
    await vi.runAllTimersAsync();
    harness.bridge.next();
    const [firstPosition] = harness.editor.setPosition.mock.calls.at(-1) as [
      { lineNumber: number; column: number },
    ];
    harness.onChange.mockClear();
    harness.editor.setPosition.mockClear();

    // A second model with the SAME single conflict, shifted 3 lines down -- proves navigation
    // after the switch reads the new model's coordinates, not the detached one's.
    const shifted = model(`\n\n\n${SOURCE}`);
    harness.setModel(shifted);
    harness.fireModelChange();
    await vi.runAllTimersAsync();

    expect(harness.onChange).toHaveBeenCalledWith(1, false);
    harness.bridge.next();
    expect(harness.editor.setPosition.mock.calls.at(-1)).toEqual([
      {
        lineNumber: firstPosition.lineNumber + 3,
        column: 1,
      },
    ]);
    harness.bridge.dispose();
  });

  it("navigates three conflicts in both directions with wraparound", async () => {
    vi.useFakeTimers();
    const harness = setup(`${SOURCE}${DIFF3}${SOURCE}`);
    await vi.runAllTimersAsync();

    harness.bridge.previous();
    expect(harness.editor.setPosition.mock.lastCall).toEqual([{ lineNumber: 13, column: 1 }]);
    harness.bridge.next();
    expect(harness.editor.setPosition.mock.lastCall).toEqual([{ lineNumber: 1, column: 1 }]);
  });

  it("starts navigation at either edge when the cursor is outside every conflict", async () => {
    vi.useFakeTimers();
    const next = setup(`${SOURCE}${SOURCE}`, undefined, null);
    const previous = setup(`${SOURCE}${SOURCE}`, undefined, 999);
    await vi.runAllTimersAsync();

    next.bridge.next();
    previous.bridge.previous();
    expect(next.editor.setPosition.mock.lastCall).toEqual([{ lineNumber: 1, column: 1 }]);
    expect(previous.editor.setPosition.mock.lastCall).toEqual([{ lineNumber: 6, column: 1 }]);
  });

  it.each(ACCEPTANCE_ACTIONS)(
    "does not accept %s when the cursor is before every conflict",
    async (_choice, action) => {
      vi.useFakeTimers();
      const harness = setup(`before\n${SOURCE}`, undefined, 1);
      await vi.runAllTimersAsync();

      await harness.actions.get(action)?.();

      expect(harness.executeEdits).not.toHaveBeenCalled();
      expect(harness.pushUndoStop).not.toHaveBeenCalled();
      harness.bridge.dispose();
    },
  );

  it.each(ACCEPTANCE_ACTIONS)(
    "does not accept %s when the cursor is after every conflict",
    async (_choice, action) => {
      vi.useFakeTimers();
      const harness = setup(`${SOURCE}after\n`, undefined, 6);
      await vi.runAllTimersAsync();

      await harness.actions.get(action)?.();

      expect(harness.executeEdits).not.toHaveBeenCalled();
      expect(harness.pushUndoStop).not.toHaveBeenCalled();
      harness.bridge.dispose();
    },
  );

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

    expect(harness.editor.setPosition.mock.calls).toHaveLength(0);
    expect(harness.executeEdits).not.toHaveBeenCalled();
    expect(harness.editor.deltaDecorations.mock.calls).toContainEqual([[], []]);
  });

  it("coalesces content scans and keeps decoration identities separate", async () => {
    vi.useFakeTimers();
    const harness = setup();
    await vi.runAllTimersAsync();
    harness.initialModel.fire();
    harness.initialModel.fire();
    harness.initialModel.fire();
    await vi.runAllTimersAsync();
    expect(harness.editor.deltaDecorations.mock.calls).toHaveLength(2);
    expect(harness.editor.deltaDecorations.mock.calls[0]?.[1]).toHaveLength(2);
  });
});
