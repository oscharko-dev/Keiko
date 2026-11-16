import { useRef, type ReactElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "./useWorkspace";
import type { AppWindow } from "../windows/types";

function savedWindow(id: string): AppWindow {
  return { id, type: "agents", x: 40, y: 40, w: 360, h: 320, z: 1, cfg: {}, max: false, zoom: 1 };
}

function Harness({ scope }: { readonly scope: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace(ref, { storageScope: scope });
  return (
    <main ref={ref}>
      <output data-testid="windows">{workspace.wins?.map((window) => window.id).join(",")}</output>
      <output data-testid="view">{workspace.view.zoom}</output>
      <button onClick={() => workspace.api.minimize("current")} type="button">
        Minimize
      </button>
    </main>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
});

afterEach(cleanup);

describe("workspace layout storage ownership", () => {
  it("does not restore windows or the camera from another database or an unowned legacy layout", () => {
    window.localStorage.setItem("keiko.workspace.v4", JSON.stringify([savedWindow("legacy")]));
    window.localStorage.setItem("keiko.workspace.v4:other", JSON.stringify([savedWindow("other")]));
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 0.3, x: 999, y: 999 }));
    render(<Harness scope="current-store" />);
    expect(screen.getByTestId("windows")).toBeEmptyDOMElement();
    expect(screen.getByTestId("view")).toHaveTextContent("1");
  });

  it("restores and saves the same store's windows without overwriting the former layout", () => {
    const former = JSON.stringify([savedWindow("former")]);
    window.localStorage.setItem("keiko.workspace.v4", former);
    window.localStorage.setItem(
      "keiko.workspace.v4:current-store",
      JSON.stringify([savedWindow("current")]),
    );
    const first = render(<Harness scope="current-store" />);
    expect(screen.getByTestId("windows")).toHaveTextContent("current");
    act(() => {
      screen.getByRole("button", { name: "Minimize" }).click();
      window.dispatchEvent(new Event("pagehide"));
    });
    first.unmount();
    expect(window.localStorage.getItem("keiko.workspace.v4")).toBe(former);
    expect(window.localStorage.getItem("keiko.workspace.v4:current-store")).toContain(
      '"minimized":true',
    );
    render(<Harness scope="current-store" />);
    expect(screen.getByTestId("windows")).toHaveTextContent("current");
  });

  it("ignores another store's cross-tab changes", () => {
    window.localStorage.setItem(
      "keiko.workspace.v4:current-store",
      JSON.stringify([savedWindow("current")]),
    );
    render(<Harness scope="current-store" />);
    act(() => {
      window.localStorage.setItem(
        "keiko.workspace.v4:other",
        JSON.stringify([savedWindow("other")]),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: "keiko.workspace.v4:other" }));
    });
    expect(screen.getByTestId("windows")).toHaveTextContent("current");
  });
});
