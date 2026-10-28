import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessScope } from "./process-scope.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistent process coordinates", () => {
  it("keeps native identity and liveness in one immutable coordinate", () => {
    const scope = createProcessScope();
    const probe = vi.fn().mockReturnValue("alive");
    scope.bind({ pid: 12345, kind: "outer-native", probe });
    expect(scope.pid()).toBe(12345);
    expect(scope.kind()).toBe("outer-native");
    expect(scope.liveness(23456)).toBe("alive");
    expect(probe).toHaveBeenCalledExactlyOnceWith(23456);
    expect(() => {
      scope.bind({ pid: 34567, kind: "outer-native", probe });
    }).toThrow();
  });

  it.each(["dead", "unknown", "alive"] as const)("retains the exact %s disposition", (state) => {
    const scope = createProcessScope();
    scope.bind({ pid: 12345, kind: "outer-native", probe: () => state });
    expect(scope.liveness(23456)).toBe(state);
  });

  it("does not turn an unavailable owner channel into a dead process", () => {
    const scope = createProcessScope();
    scope.bind({
      pid: 12345,
      kind: "outer-native",
      probe: () => {
        throw new Error("offline");
      },
    });
    expect(scope.liveness(23456)).toBe("unknown");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000])(
    "refuses invalid native identity %s and never probes invalid identifiers",
    (pid) => {
      const scope = createProcessScope(),
        probe = vi.fn().mockReturnValue("dead");
      expect(() => {
        scope.bind({ pid, kind: "outer-native", probe });
      }).toThrow(TypeError);
      scope.bind({ pid: 12345, kind: "outer-native", probe });
      expect(scope.liveness(pid)).toBe("unknown");
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("refuses late binding after a local identity has already been used", () => {
    const scope = createProcessScope();
    expect(scope.pid()).toBe(process.pid);
    expect(() => {
      scope.bind({ pid: 12345, kind: "outer-native", probe: () => "alive" });
    }).toThrow();
  });

  it("only a local ESRCH observation establishes death", () => {
    const scope = createProcessScope();
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: "EIO" });
    });
    expect(scope.liveness(12345)).toBe("unknown");
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: "EPERM" });
    });
    expect(scope.liveness(12345)).toBe("unknown");
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: "ESRCH" });
    });
    expect(scope.liveness(12345)).toBe("dead");
  });
});
