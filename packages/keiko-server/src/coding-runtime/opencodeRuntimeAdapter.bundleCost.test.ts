import { describe, expect, it, vi } from "vitest";

// Counts every compilation of the OpenCode registration set while leaving its result untouched.
const compilations = vi.hoisted(() => ({ count: 0 }));

vi.mock("@oscharko-dev/keiko-tool-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-tool-catalog")>();
  return {
    ...actual,
    opencodeRegistrationSet: (): ReturnType<typeof actual.opencodeRegistrationSet> => {
      compilations.count += 1;
      return actual.opencodeRegistrationSet();
    },
  };
});

const { createGeneratedOpenCodeBundle } = await import("./opencodeRuntimeAdapter.js");

// PR #3452: each tool source looked its catalog descriptor up by compiling the whole registration
// set again, twice per tool, for every bundle. The scripted transcripts generate a bundle per tool
// call, and the repeated compilation made their CI runs time out. A bundle reads the descriptors the
// adapter compiled once.
describe("generated OpenCode bundle cost", () => {
  it("compiles the registration set no further however many bundles are generated", () => {
    const before = compilations.count;
    const first = createGeneratedOpenCodeBundle();
    const second = createGeneratedOpenCodeBundle();

    expect(compilations.count).toBe(before);
    expect(Object.keys(second.toolSources)).toEqual(Object.keys(first.toolSources));
    expect(Object.keys(first.toolSources).length).toBeGreaterThan(0);
  });
});
