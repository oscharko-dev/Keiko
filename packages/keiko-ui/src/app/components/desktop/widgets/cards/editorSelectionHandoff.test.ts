import {
  EDITOR_AGENT_TARGET_PATH_MAX_BYTES,
  EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_SELECTION_MAX_BYTES,
  captureEditorSelection,
  composeEditorSelectionPrompt,
  createEditorSelectionHandoffRegistry,
  type EditorSelectionAskRequest,
  type EditorSelectionHandoff,
} from "./editorSelectionHandoff";

function request(text: string): EditorSelectionAskRequest {
  return {
    textMode: "selection",
    range: { start: { line: 1, column: 2 }, end: { line: 2, column: 3 } },
    text,
  };
}

function handoff(text: string): EditorSelectionHandoff {
  const captured = captureEditorSelection("src/example.ts", request(text));
  if (!captured.ok) throw new Error("Expected a valid selection fixture.");
  return captured.handoff;
}

const ROOT = "/workspace/Exact Root/";
const textEncoder = new TextEncoder();

function multibyteBoundary(prefix: string, maxBytes: number): string {
  const remaining = maxBytes - textEncoder.encode(prefix).length;
  return `${prefix}${"é".repeat(Math.floor(remaining / 2))}${remaining % 2 === 0 ? "" : "x"}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor selection capture", () => {
  it("preserves a CRLF selection and composes a root-relative, untrusted-input prompt", () => {
    const selected = "pha\r\nbet";
    const captured = captureEditorSelection("src/example.ts", {
      textMode: "selection",
      range: { start: { line: 0, column: 2 }, end: { line: 1, column: 3 } },
      text: selected,
    });

    expect(captured).toEqual({
      ok: true,
      handoff: {
        file: "src/example.ts",
        range: { start: { line: 0, column: 2 }, end: { line: 1, column: 3 } },
        text: selected,
        truncated: false,
      },
    });
    if (!captured.ok) return;
    const prompt = composeEditorSelectionPrompt(captured.handoff);
    expect(prompt).toContain('Root-relative file (JSON): "src/example.ts"');
    expect(prompt).toContain("Range: L1:C3-L2:C4");
    expect(prompt).toContain('"pha\\r\\nbet"');
    expect(prompt).toContain("untrusted workspace content");
    expect(composeEditorSelectionPrompt(captured.handoff)).toBe(prompt);
  });

  it("bounds raw selection text to 16 KiB of valid UTF-8 without leaking surrounding text", () => {
    const selected = `${"🙂".repeat(5_000)}SELECTED_TAIL`;
    const captured = captureEditorSelection("src/example.ts", request(selected));

    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(new TextEncoder().encode(captured.handoff.text)).toHaveLength(
      EDITOR_SELECTION_MAX_BYTES,
    );
    expect(captured.handoff.text).not.toContain("�");
    expect(captured.handoff.text).not.toContain("SELECTED_TAIL");
    expect(captured.handoff.truncated).toBe(true);

    const prompt = composeEditorSelectionPrompt(captured.handoff);
    expect(prompt).not.toContain("FULL_BUFFER_PREFIX");
    expect(prompt).not.toContain("FULL_BUFFER_SUFFIX");
  });

  it("rejects missing, empty, collapsed, and reversed selections", () => {
    expect(captureEditorSelection("src/example.ts", null)).toEqual({
      ok: false,
      reason: "no-selection",
    });
    expect(captureEditorSelection("src/example.ts", request(""))).toEqual({
      ok: false,
      reason: "no-selection",
    });
    expect(
      captureEditorSelection("src/example.ts", {
        ...request("x"),
        range: { start: { line: 1, column: 2 }, end: { line: 1, column: 2 } },
      }),
    ).toEqual({ ok: false, reason: "invalid-selection" });
    expect(
      captureEditorSelection("src/example.ts", {
        ...request("x"),
        range: { start: { line: 2, column: 0 }, end: { line: 1, column: 0 } },
      }),
    ).toEqual({ ok: false, reason: "invalid-selection" });
  });

  it("requires selection mode and a bounded root-relative file identifier", () => {
    const boundaryFile = multibyteBoundary("src/", EDITOR_AGENT_TARGET_PATH_MAX_BYTES);
    expect(textEncoder.encode(boundaryFile)).toHaveLength(EDITOR_AGENT_TARGET_PATH_MAX_BYTES);
    expect(captureEditorSelection(boundaryFile, request("selected")).ok).toBe(true);

    const invalidFiles = [
      "/etc/passwd",
      "../secret.ts",
      "src/../../secret.ts",
      "C:\\Windows\\secret.ts",
      `${boundaryFile}x`,
    ];
    for (const file of invalidFiles) {
      expect(captureEditorSelection(file, request("selected"))).toEqual({
        ok: false,
        reason: "invalid-selection",
      });
    }

    expect(
      captureEditorSelection("src/example.ts", {
        ...request("FULL_BUFFER_SECRET"),
        textMode: "activeFile",
      } as unknown as EditorSelectionAskRequest),
    ).toEqual({ ok: false, reason: "invalid-selection" });
  });
});

describe("editor selection handoff registry", () => {
  it("binds root-only metadata and consumes each handoff once under that exact root", () => {
    const registry = createEditorSelectionHandoffRegistry({
      createId: () => "opaque-1",
      now: () => 1_000,
    });
    const value = handoff("selected-content-that-must-not-be-inspected");
    const id = registry.register(ROOT, value);

    expect(id).toBe("opaque-1");
    if (id === null) return;
    expect(registry.inspect(id)).toEqual({ workspaceRoot: ROOT, expiresAt: 121_000 });
    expect(registry.inspect(id)).not.toHaveProperty("handoff");
    expect(registry.inspect(id)).not.toHaveProperty("text");
    expect(JSON.stringify(registry.inspect(id))).not.toContain(value.text);
    expect(JSON.stringify(registry.inspect(id))).not.toContain(value.file);
    expect(registry.consume(id, "/workspace/wrong")).toBeNull();
    expect(registry.consume(id, ROOT)).toEqual(value);
    expect(registry.consume(id, ROOT)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("expires entries and evicts the oldest entry at capacity", () => {
    let now = 1_000;
    let sequence = 0;
    const registry = createEditorSelectionHandoffRegistry({
      capacity: 2,
      createId: () => `opaque-${String((sequence += 1))}`,
      now: () => now,
      ttlMs: 50,
    });
    const first = registry.register(ROOT, handoff("first"));
    const second = registry.register(ROOT, handoff("second"));
    const third = registry.register(ROOT, handoff("third"));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    if (first === null || second === null || third === null) return;
    expect(registry.consume(first, ROOT)).toBeNull();
    expect(registry.consume(second, ROOT)?.text).toBe("second");
    expect(registry.consume(third, ROOT)?.text).toBe("third");

    const expiring = registry.register(ROOT, handoff("expires"));
    expect(expiring).not.toBeNull();
    if (expiring === null) return;
    now += 50;
    expect(registry.inspect(expiring)).toBeNull();
    expect(registry.consume(expiring, ROOT)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("bounds workspace roots by UTF-8 bytes at the shared contract boundary", () => {
    const registry = createEditorSelectionHandoffRegistry({ createId: () => "opaque-1" });
    const value = handoff("selected");
    const boundaryRoot = multibyteBoundary("/", EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES);

    expect(textEncoder.encode(boundaryRoot)).toHaveLength(EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES);
    expect(registry.register(boundaryRoot, value)).toBe("opaque-1");
    registry.discard("opaque-1");
    expect(registry.register("", value)).toBeNull();
    expect(registry.register("/workspace\nother", value)).toBeNull();
    expect(registry.register(`${boundaryRoot}x`, value)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("fails closed for throwing, unavailable, invalid, and colliding id allocators", () => {
    const value = handoff("selected");
    const throwing = createEditorSelectionHandoffRegistry({
      createId: () => {
        throw new Error("secret allocator failure");
      },
    });
    expect(() => throwing.register(ROOT, value)).not.toThrow();
    expect(throwing.register(ROOT, value)).toBeNull();

    vi.stubGlobal("crypto", undefined);
    expect(createEditorSelectionHandoffRegistry().register(ROOT, value)).toBeNull();

    for (const id of ["unsafe id", "unsafe/id", "é", "x".repeat(129)]) {
      const registry = createEditorSelectionHandoffRegistry({ createId: () => id });
      expect(registry.register(ROOT, value)).toBeNull();
      expect(registry.size()).toBe(0);
    }

    const colliding = createEditorSelectionHandoffRegistry({ createId: () => "same-id" });
    expect(colliding.register(ROOT, value)).toBe("same-id");
    expect(colliding.register(ROOT, value)).toBeNull();
    expect(colliding.size()).toBe(1);
  });

  it("normalizes non-finite and unsafe capacity and TTL options to bounded defaults", () => {
    let sequence = 0;
    const registry = createEditorSelectionHandoffRegistry({
      capacity: Number.POSITIVE_INFINITY,
      createId: () => `bounded-${String((sequence += 1))}`,
      now: () => 1_000,
      ttlMs: Number.NaN,
    });
    const ids = Array.from({ length: 9 }, () => registry.register(ROOT, handoff("selected")));

    expect(ids.every((id) => id !== null)).toBe(true);
    expect(registry.size()).toBe(8);
    expect(registry.inspect("bounded-1")).toBeNull();
    expect(registry.inspect("bounded-9")).toEqual({ workspaceRoot: ROOT, expiresAt: 121_000 });

    const finite = createEditorSelectionHandoffRegistry({
      createId: () => "finite-id",
      now: () => 1_000,
      ttlMs: Number.MAX_VALUE,
    });
    const id = finite.register(ROOT, handoff("selected"));
    expect(id).toBe("finite-id");
    if (id === null) return;
    expect(Number.isSafeInteger(finite.inspect(id)?.expiresAt)).toBe(true);
  });

  it("rejects malformed handoffs without retaining state or throwing", () => {
    const registry = createEditorSelectionHandoffRegistry({ createId: () => "opaque-1" });
    const value = handoff("selected");
    const malformed = [
      { ...value, file: "../secret.ts" },
      { ...value, text: "" },
      { ...value, text: "x".repeat(EDITOR_SELECTION_MAX_BYTES + 1) },
      { ...value, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } },
      { ...value, truncated: "yes" },
    ];

    for (const candidate of malformed) {
      expect(() =>
        registry.register(ROOT, candidate as unknown as EditorSelectionHandoff),
      ).not.toThrow();
      expect(registry.register(ROOT, candidate as unknown as EditorSelectionHandoff)).toBeNull();
    }
    expect(registry.size()).toBe(0);
  });
});
