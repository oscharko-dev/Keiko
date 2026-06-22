import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TwinProvider } from "../context/TwinContext";
import { useTwinMode } from "./useTwinMode";

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return <TwinProvider>{children}</TwinProvider>;
}

describe("useTwinMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("exposes the TwinProvider mode and toggles between manual and autonomous", () => {
    const { result } = renderHook(() => useTwinMode(), { wrapper });

    expect(result.current.mode).toBe("manual");

    act(() => result.current.toggle());
    expect(result.current.mode).toBe("autonomous");

    act(() => result.current.toggle());
    expect(result.current.mode).toBe("manual");
  });

  it("forwards explicit mode changes to the provider", () => {
    const { result } = renderHook(() => useTwinMode(), { wrapper });

    act(() => result.current.setMode("autonomous"));

    expect(result.current.mode).toBe("autonomous");
  });
});
