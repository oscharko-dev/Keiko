import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatConnectedScope } from "@/lib/types";
import { ChatScopeNotice } from "./ChatScopeNotice";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

const folder: ChatConnectedScope = {
  kind: "directory",
  root: "/repo",
  relativePaths: ["src"],
  connectedAtMs: 1,
};
const file: ChatConnectedScope = { ...folder, kind: "files", relativePaths: ["src/validation.ts"] };
function chat(scope: ChatConnectedScope, id = "chat-a"): Chat {
  return {
    id,
    projectPath: "/repo",
    title: "Chat",
    selectedModel: "model",
    branchLabel: undefined,
    status: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    connectedScope: scope,
    groundingScopeIdentity: "identity",
  };
}
function settle(): void {
  act(() => vi.advanceTimersByTime(120));
}
afterEach(() => {
  resetClientDiagnosticWriter();
  vi.useRealTimers();
});

describe("automatic source transition evidence", () => {
  it("renders no confirmation or folder pin after narrowing", () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const view = render(<ChatScopeNotice chat={chat(folder)} />);
    view.rerender(<ChatScopeNotice chat={chat(file)} />);
    settle();
    expect(screen.queryByRole("button", { name: "OK" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep folder" })).toBeNull();
    expect(view.container).toBeEmptyDOMElement();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({
      scopeNotice: { reason: "narrowed-to-file", scopeKind: "files", pathCount: 1 },
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("/repo");
  });
  it("coalesces rapid navigation and ignores timestamps and another chat", () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const view = render(<ChatScopeNotice chat={chat(folder)} />);
    view.rerender(<ChatScopeNotice chat={chat(file)} />);
    view.rerender(<ChatScopeNotice chat={chat({ ...file, relativePaths: ["src/next.ts"] })} />);
    settle();
    expect(diagnostic).toHaveBeenCalledOnce();
    view.rerender(
      <ChatScopeNotice
        chat={chat({ ...file, relativePaths: ["src/next.ts"], connectedAtMs: 99 })}
      />,
    );
    settle();
    view.rerender(<ChatScopeNotice chat={chat(folder, "chat-b")} />);
    settle();
    expect(diagnostic).toHaveBeenCalledOnce();
  });
  it("records independent changed sources and widening without source bodies", () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const view = render(<ChatScopeNotice chat={chat(file)} />);
    view.rerender(
      <ChatScopeNotice
        chat={{
          ...chat(folder),
          connectedScopes: [
            folder,
            { ...folder, kind: "workspace-root", root: "/other", relativePaths: [] },
          ],
        }}
      />,
    );
    settle();
    expect(diagnostic).toHaveBeenCalledTimes(2);
    for (const call of diagnostic.mock.calls)
      expect(call[1]).toMatchObject({ scopeNotice: { reason: "widened" } });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("/other");
  });
  it("drops pending evidence when the source is removed or observer unmounts", () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const view = render(<ChatScopeNotice chat={chat(folder)} />);
    view.rerender(<ChatScopeNotice chat={chat(file)} />);
    view.rerender(<ChatScopeNotice chat={{ ...chat(file), connectedScopes: [] }} />);
    settle();
    expect(diagnostic).not.toHaveBeenCalled();
    view.rerender(<ChatScopeNotice chat={chat(folder)} />);
    view.unmount();
    settle();
    expect(diagnostic).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "attributes directory narrowing only to its replaced source (%s)",
  (reverse) => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const unchanged = { ...file, relativePaths: ["docs/readme.md"] };
    const before = reverse ? [unchanged, folder] : [folder, unchanged];
    const narrowed = { ...folder, relativePaths: ["src/nested"] };
    const view = render(<ChatScopeNotice chat={{ ...chat(folder), connectedScopes: before }} />);
    view.rerender(
      <ChatScopeNotice chat={{ ...chat(narrowed), connectedScopes: [narrowed, unchanged] }} />,
    );
    settle();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({
      scopeNotice: { reason: "narrowed-to-directory" },
    });
  },
);

it("records widening from a nested directory to its parent", () => {
  vi.useFakeTimers();
  const diagnostic = vi.fn();
  setClientDiagnosticWriter(diagnostic);
  const view = render(
    <ChatScopeNotice chat={chat({ ...folder, relativePaths: ["src/nested"] })} />,
  );
  view.rerender(<ChatScopeNotice chat={chat(folder)} />);
  settle();
  expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({ scopeNotice: { reason: "widened" } });
});
