import { describe, expect, it, vi } from "vitest";

import { main, resolveQualityRange } from "../resolve-quality-range.mjs";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const ROOT = "3".repeat(40);
const MERGE_BASE = "4".repeat(40);

function gitResult(args) {
  if (args[0] === "rev-list") return ROOT;
  if (args[0] === "merge-base" && args[1] !== "--is-ancestor") return args[1];
  return "";
}

describe("immutable quality range resolution", () => {
  it("keeps a valid event range and verifies both commits and ancestry", () => {
    const git = vi.fn(gitResult);
    expect(resolveQualityRange({ base: BASE, head: HEAD }, git)).toEqual({
      base: BASE,
      head: HEAD,
    });
    expect(git.mock.calls).toEqual([
      [["cat-file", "-e", `${HEAD}^{commit}`]],
      [["cat-file", "-e", `${BASE}^{commit}`]],
      [["merge-base", BASE, HEAD]],
      [["merge-base", "--is-ancestor", BASE, HEAD]],
    ]);
  });

  it("resolves the real merge base when the target branch advanced after the fork", () => {
    const git = vi.fn((args) =>
      args[0] === "merge-base" && args[1] !== "--is-ancestor" ? MERGE_BASE : "",
    );
    expect(resolveQualityRange({ base: BASE, head: HEAD }, git)).toEqual({
      base: MERGE_BASE,
      head: HEAD,
    });
  });

  it.each([undefined, "", "main", "A".repeat(40), `${HEAD}extra`])(
    "rejects a hostile or mutable head value (%s)",
    (head) => {
      expect(() => resolveQualityRange({ base: BASE, head }, vi.fn())).toThrow(
        "head must be an immutable commit SHA",
      );
    },
  );

  it.each([undefined, "", "main", "0".repeat(40)])(
    "uses the repository root when the event base is unusable (%s)",
    (base) => {
      expect(resolveQualityRange({ base, head: HEAD }, gitResult)).toEqual({
        base: ROOT,
        head: HEAD,
      });
    },
  );

  it("uses the selected head parent for a manual run without an event base", () => {
    const git = vi.fn((args) => {
      if (args[0] === "rev-parse") return BASE;
      if (args[0] === "merge-base" && args[1] !== "--is-ancestor") return BASE;
      return "";
    });
    expect(
      resolveQualityRange({ base: undefined, eventName: "workflow_dispatch", head: HEAD }, git),
    ).toEqual({ base: BASE, head: HEAD });
    expect(git).toHaveBeenCalledWith(["rev-parse", "--verify", `${HEAD}^`]);
  });

  it("fails a manual run whose selected head has no resolvable parent", () => {
    expect(() =>
      resolveQualityRange(
        { base: undefined, eventName: "workflow_dispatch", head: HEAD },
        () => "",
      ),
    ).toThrow("manual run base could not be resolved to the selected head's parent");
  });

  it("fails when the fallback is not an immutable commit", () => {
    expect(() =>
      resolveQualityRange({ base: undefined, head: HEAD }, (args) =>
        args[0] === "rev-list" ? "not-a-sha" : "",
      ),
    ).toThrow("base could not be resolved to an immutable commit SHA");
  });

  it("fails when two valid commits have no merge base", () => {
    expect(() =>
      resolveQualityRange({ base: BASE, head: HEAD }, (args) =>
        args[0] === "merge-base" && args[1] !== "--is-ancestor" ? "" : "",
      ),
    ).toThrow("merge base could not be resolved to an immutable commit SHA");
  });

  it("renders only validated outputs and returns a process status", () => {
    const write = vi.fn();
    expect(main({ QUALITY_BASE_SHA: BASE, QUALITY_HEAD_SHA: HEAD }, gitResult, write)).toBe(0);
    expect(write.mock.calls).toEqual([[`base=${BASE}`], [`head=${HEAD}`]]);
  });

  it("returns failure without reflecting hostile input", () => {
    const error = vi.fn();
    expect(
      main({ QUALITY_BASE_SHA: BASE, QUALITY_HEAD_SHA: "hostile" }, gitResult, vi.fn(), error),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "quality-range: FAIL - head must be an immutable commit SHA",
    );
  });
});
