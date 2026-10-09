import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("acknowledged scope notice", () => {
  it.each([true, false])(
    "invalidates a %s-settled file notice and saved pin after disconnect ACK",
    (settled) => {
      vi.useFakeTimers();
      const keep = vi.fn();
      const changed = vi.fn();
      const view = render(
        <ChatScopeNotice chat={chat(folder)} onChatChanged={changed} onKeepFolderChange={keep} />,
      );
      view.rerender(
        <ChatScopeNotice chat={chat(file)} onChatChanged={changed} onKeepFolderChange={keep} />,
      );
      if (settled) settle();
      view.rerender(
        <ChatScopeNotice
          chat={{ ...chat(file), connectedScopes: [] }}
          onChatChanged={changed}
          onKeepFolderChange={keep}
        />,
      );
      settle();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("button", { name: "Keep folder" })).toBeNull();
      expect(keep).toHaveBeenCalledWith(false);
    },
  );
  it("coalesces previews, announces the new file and restores the prior folder with body-free evidence", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const changed = vi.fn();
    const keep = vi.fn();
    const updateScopes = vi.fn().mockResolvedValue({ chat: chat(folder) });
    const view = render(
      <ChatScopeNotice
        chat={chat(folder)}
        onChatChanged={changed}
        onKeepFolderChange={keep}
        updateScopes={updateScopes}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(
      <ChatScopeNotice
        chat={chat(file)}
        onChatChanged={changed}
        onKeepFolderChange={keep}
        updateScopes={updateScopes}
      />,
    );
    view.rerender(
      <ChatScopeNotice
        chat={chat({ ...file, relativePaths: ["src/b.ts"] })}
        onChatChanged={changed}
        onKeepFolderChange={keep}
        updateScopes={updateScopes}
      />,
    );
    settle();
    expect(screen.getByRole("status").textContent).toContain("File: b.ts");
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("/repo");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Keep folder" })));
    expect(updateScopes).toHaveBeenCalledWith("chat-a", [folder], "identity");
    expect(keep).toHaveBeenCalledWith(true);
    expect(changed).toHaveBeenCalledWith(chat(folder));
  });
  it("retains a pending notice when the pin callback changes on an unrelated render", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const view = render(
      <ChatScopeNotice chat={chat(folder)} onChatChanged={changed} onKeepFolderChange={vi.fn()} />,
    );
    view.rerender(
      <ChatScopeNotice chat={chat(file)} onChatChanged={changed} onKeepFolderChange={vi.fn()} />,
    );
    view.rerender(
      <ChatScopeNotice chat={chat(file)} onChatChanged={changed} onKeepFolderChange={vi.fn()} />,
    );
    settle();
    expect(screen.getByRole("status")).toHaveTextContent("File: validation.ts");
  });
  it("announces widening, dismisses politely and never replays a folder across chats", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const view = render(<ChatScopeNotice chat={chat(file)} onChatChanged={changed} />);
    view.rerender(<ChatScopeNotice chat={chat(folder)} onChatChanged={changed} />);
    settle();
    expect(screen.getByRole("status").textContent).toContain("expanded");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<ChatScopeNotice chat={chat(file, "chat-b")} onChatChanged={changed} />);
    settle();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("releases the pin on root change and does not offer the former folder", () => {
    vi.useFakeTimers();
    const keep = vi.fn();
    const changed = vi.fn();
    const view = render(
      <ChatScopeNotice chat={chat(folder)} onChatChanged={changed} onKeepFolderChange={keep} />,
    );
    view.rerender(
      <ChatScopeNotice
        chat={chat({ ...file, root: "/other" })}
        onChatChanged={changed}
        onKeepFolderChange={keep}
      />,
    );
    settle();
    expect(keep).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("button", { name: "Keep folder" })).toBeNull();
  });
});
