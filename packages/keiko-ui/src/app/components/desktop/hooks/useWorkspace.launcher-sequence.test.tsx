import { useRef, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
import type { UseWorkspaceResult } from "./useWorkspace.types";

let latest: UseWorkspaceResult | undefined;

function Harness(): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  latest = useWorkspace(ref);
  return <main ref={ref} />;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1400, 900),
  );
  latest = undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function visible(): string[] {
  return (latest?.wins ?? []).filter((w) => w.minimized !== true).map((w) => w.type);
}

function click(type: "coding" | "governedGit"): string | undefined {
  let outcome: string | undefined;
  act(() => {
    outcome = latest?.api.toggleTool(type);
  });
  return outcome;
}

describe("launcher clicks through the real workspace hook", () => {
  it("raises the background window after the other one was minimized and restored", () => {
    render(<Harness />);
    click("governedGit");
    click("coding");
    expect(click("coding")).toBe("minimize");
    expect(visible()).toEqual(["governedGit"]);
    // The footer's "N windows" is wins.length: a launcher click must never drop a window.
    expect(latest?.wins).toHaveLength(2);
    expect(click("coding")).toBe("restore");
    expect(visible().toSorted()).toEqual(["coding", "governedGit"]);

    expect(click("governedGit")).toBe("raise");
    expect(visible().toSorted()).toEqual(["coding", "governedGit"]);
    const z = (type: string): number => latest?.wins?.find((w) => w.type === type)?.z ?? 0;
    expect(z("governedGit")).toBeGreaterThan(z("coding"));

    expect(click("coding")).toBe("raise");
    expect(visible().toSorted()).toEqual(["coding", "governedGit"]);
    expect(latest?.wins).toHaveLength(2);
  });
});
