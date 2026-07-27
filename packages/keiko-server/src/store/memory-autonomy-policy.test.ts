import { describe, expect, it } from "vitest";
import { createInMemoryUiStore } from "./index.js";

describe("memory autonomy policy store", () => {
  it("applies exact revisions, lets stale downgrades win, and rejects stale widening", () => {
    const store = createInMemoryUiStore();
    expect(store.readMemoryAutonomyPolicy()).toBeUndefined();

    expect(store.updateMemoryAutonomyPolicy("autonomous-delivery", 0)).toEqual({
      requestedMode: "autonomous-delivery",
      revision: 1,
    });
    expect(store.updateMemoryAutonomyPolicy("governed-assist", 0)).toEqual({
      requestedMode: "governed-assist",
      revision: 2,
    });
    expect(store.updateMemoryAutonomyPolicy("autonomous-delivery", 1)).toBeUndefined();
    expect(store.updateMemoryAutonomyPolicy("supervised-coding", 3)).toBeUndefined();

    expect(store.readMemoryAutonomyPolicy()).toEqual({
      requestedMode: "governed-assist",
      revision: 2,
    });
    store.close();
  });
});
