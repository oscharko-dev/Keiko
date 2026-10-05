import { createRef, useMemo, useRef, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceApiFixture } from "../../../../test-utils/workspace-api-fixture";
import { makeMutations } from "../hooks/workspaceActions";
import { RepositoryReferenceInline } from "../repositoryReferences";
import { WindowFrame } from "./WindowFrame";
import { registerWindowRender } from "./WindowsRegistry";
import type { AppWindow } from "./types";

function testWindow(id: string, type: AppWindow["type"]): AppWindow {
  return {
    id,
    type,
    x: 0,
    y: 0,
    w: 900,
    h: 700,
    z: type === "chat" ? 2 : 1,
    cfg: type === "editor" ? { root: "/selected", file: "old.txt" } : {},
    max: type === "chat",
    zoom: 1,
  };
}

function SourceActivationHarness({ reuse }: { readonly reuse: boolean }): ReactNode {
  const [wins, setWins] = useState<AppWindow[] | null>(() => [
    testWindow("chat", "chat"),
    ...(reuse ? [testWindow("editor", "editor")] : []),
    testWindow("other", "agents"),
  ]);
  const winsRef = useRef(wins ?? []);
  winsRef.current = wins ?? [];
  const zc = useRef(2);
  const api = useMemo(
    () =>
      workspaceApiFixture(
        makeMutations({ setWins, zc, winsRef, worldVP: () => ({ x: 0, y: 0, w: 1200, h: 900 }) }),
      ),
    [],
  );
  const topZ = Math.max(...(wins ?? []).map((win) => win.z));
  return (
    <>
      {wins?.map((win) => (
        <WindowFrame
          key={win.id}
          win={win}
          top={win.z === topZ}
          connState={null}
          linkRevision={0}
          api={api}
          wsRef={createRef<HTMLElement>()}
        />
      ))}
    </>
  );
}

function installSourceRenderers(): void {
  registerWindowRender("chat", (_cfg, ctx) => (
    <RepositoryReferenceInline
      reference={{
        path: "station-crlf.txt",
        label: "station-crlf.txt:9",
        lineStart: 9,
        lineEnd: 9,
      }}
      roots={[{ root: "/selected", label: "selected" }]}
      rootRelative
      openReference={ctx.openEditorFile}
    />
  ));
  registerWindowRender("editor", (cfg) => (
    <output data-testid="source-document">
      {JSON.stringify({ root: cfg.root, file: cfg.file, line: cfg.revealLineStart })}
    </output>
  ));
  registerWindowRender("agents", () => <button type="button">Other window</button>);
}

function activateSource(method: "pointer" | "Enter" | " "): void {
  const source = screen.getByRole("button", { name: /station-crlf\.txt/u });
  source.focus();
  if (method !== "pointer") {
    fireEvent.keyDown(source, { key: method });
    return;
  }
  fireEvent.pointerDown(source, { button: 0 });
  fireEvent.click(source);
}

function expectPhysicalSource(): Element | null {
  const document = screen.getByTestId("source-document");
  expect(document).toHaveTextContent(
    JSON.stringify({ root: "/selected", file: "station-crlf.txt", line: 9 }),
  );
  return document.closest(".window");
}

afterEach(() => vi.useRealTimers());

describe("WindowFrame physical source activation", () => {
  it.each([
    [false, "pointer"],
    [true, "pointer"],
    [false, "Enter"],
    [true, "Enter"],
    [false, " "],
    [true, " "],
  ] as const)(
    "raises and focuses a manual Editor from fullscreen Chat (reuse=%s, method=%s)",
    (reuse, method) => {
      vi.useFakeTimers();
      installSourceRenderers();
      render(<SourceActivationHarness reuse={reuse} />);
      activateSource(method);
      act(() => vi.advanceTimersByTime(30));
      const editor = expectPhysicalSource();
      expect(editor).toHaveAttribute("data-top", "true");
      expect(document.activeElement).toBe(editor);
    },
  );

  it("does not steal focus or stacking from a later user interaction", () => {
    vi.useFakeTimers();
    installSourceRenderers();
    render(<SourceActivationHarness reuse />);
    activateSource("pointer");
    const other = screen.getByRole("button", { name: "Other window" });
    other.focus();
    fireEvent.pointerDown(other, { button: 0 });
    act(() => vi.advanceTimersByTime(30));
    expectPhysicalSource();
    expect(other.closest(".window")).toHaveAttribute("data-top", "true");
    expect(document.activeElement).toBe(other);
  });

  it("keeps focus in Chat when opening the source is refused", () => {
    vi.useFakeTimers();
    installSourceRenderers();
    render(
      <WindowFrame
        win={testWindow("chat", "chat")}
        top
        connState={null}
        linkRevision={0}
        api={workspaceApiFixture()}
        wsRef={createRef<HTMLElement>()}
      />,
    );
    activateSource("pointer");
    act(() => vi.advanceTimersByTime(30));
    expect(screen.queryByTestId("source-document")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /station-crlf\.txt/u }));
    expect(screen.getByRole("button", { name: /station-crlf\.txt/u })).toHaveAttribute(
      "data-state",
      "failed",
    );
  });
});
