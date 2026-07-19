import { describe, expect, it } from "vitest";
import { createInMemoryUiStore } from "./index.js";

describe("memory autonomy policy store", () => {
  it("persists one canonical requested mode and replaces it atomically", () => {
    const store = createInMemoryUiStore();
    expect(store.getMemoryAutonomyMode()).toBeUndefined();

    store.setMemoryAutonomyMode("supervised-coding");
    expect(store.getMemoryAutonomyMode()).toBe("supervised-coding");

    store.setMemoryAutonomyMode("autonomous-delivery");
    expect(store.getMemoryAutonomyMode()).toBe("autonomous-delivery");
    store.close();
  });
});
