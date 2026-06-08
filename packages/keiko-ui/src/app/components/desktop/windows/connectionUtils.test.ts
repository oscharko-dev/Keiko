// Epic #270 Slice 1 — Quality Intelligence ↔ Files relationship binding.
// canConnect must allow a `quality` (QI hub) window to bind to a `files` window (in either
// direction) so the connected folder feeds "Generate test cases", and must keep rejecting
// unrelated pairings.

import { describe, expect, it } from "vitest";
import { canConnect, relLabel, type WinSnapshot } from "./connectionUtils";

function snap(type: WinSnapshot["type"], cfg: Record<string, unknown> = {}): WinSnapshot {
  return { id: `${type}-1`, type, x: 0, y: 0, w: 10, h: 10, cfg };
}

describe("canConnect — quality ↔ files (#270)", () => {
  it("allows quality to connect to files in both orders", () => {
    expect(canConnect("quality", "files")).toBe(true);
    expect(canConnect("files", "quality")).toBe(true);
  });

  it("still rejects unrelated pairings for quality", () => {
    expect(canConnect("quality", "terminal")).toBe(false);
    expect(canConnect("quality", "browser")).toBe(false);
    expect(canConnect("quality", "quality")).toBe(false);
    // Connector/capsule binding is a later slice — not connectable yet.
    expect(canConnect("quality", "connector")).toBe(false);
  });

  it("does not regress the existing chat ↔ files / connector bindings", () => {
    expect(canConnect("chat", "files")).toBe(true);
    expect(canConnect("chat", "connector")).toBe(true);
  });
});

describe("relLabel — files ↔ quality (#270)", () => {
  it("labels a files↔quality edge with the connected folder", () => {
    const label = relLabel(snap("files", { root: "/work/spec" }), snap("quality"));
    expect(label).toBe("uses /work/spec/");
  });
});
