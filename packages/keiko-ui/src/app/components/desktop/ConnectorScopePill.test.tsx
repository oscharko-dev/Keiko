// Epic #189 Slice 3 M4 — unit tests for the connector-scope pills (mixed N).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectorScopePill } from "./ConnectorScopePill";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import type { Chat, ChatLocalKnowledgeScope, ChatResponse } from "@/lib/types";

// Display names from the shared Knowledge Pod catalog, keyed like ChatWindow's label map.
const LABELS: ReadonlyMap<string, string> = new Map([
  ["capsule:c1", "Pod One"],
  ["capsule:c2", "Pod Two"],
  ["capsule:only", "Only Pod"],
  ["set:s1", "Set One"],
]);

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/proj",
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeCapsule(id: string, ms = 1): ChatLocalKnowledgeScope {
  return {
    kind: "capsule",
    capsuleId: id as Extract<ChatLocalKnowledgeScope, { kind: "capsule" }>["capsuleId"],
    connectedAtMs: ms,
  };
}

function makeSet(id: string, ms = 1): ChatLocalKnowledgeScope {
  return {
    kind: "capsule-set",
    capsuleSetId: id as Extract<ChatLocalKnowledgeScope, { kind: "capsule-set" }>["capsuleSetId"],
    connectedAtMs: ms,
  };
}

describe("ConnectorScopePill", () => {
  it("renders nothing when the chat has no local-knowledge scope", () => {
    const { container } = render(<ConnectorScopePill chat={makeChat()} updateScopes={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one pill for a single capsule scope (legacy singular field)", () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("cap-abc") });
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} />);
    // GEN-UI-STATE-001: the visible label is a plain span (no longer role="status"), so it is
    // queried by text; each pill carries one disconnect button.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // uiux-fix F041 (C173) — the entity is a "Knowledge Pod" product-wide, not a "connector". A pod
    // the answered catalog does not list reads as unavailable, never by its raw id (PR #3678).
    expect(screen.getByText("Knowledge Pod (unavailable)")).toBeInTheDocument();
    expect(screen.queryByText(/cap-abc/)).toBeNull();
  });

  it("names only the kind while the catalog has not answered, never the raw id", () => {
    const chat = makeChat({ localKnowledgeScopes: [makeCapsule("cap-abc"), makeSet("set-xyz")] });
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} labelsSettled={false} />);
    expect(screen.getByText("Knowledge Pod")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Pod Set")).toBeInTheDocument();
    expect(screen.queryByText(/cap-abc|set-xyz/)).toBeNull();
  });

  it("renders resolved label from the labels map when provided", () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("cap-abc") });
    const labels = new Map([["capsule:cap-abc", "My Docs"]]);
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} labels={labels} />);
    expect(screen.getByText("My Docs")).toBeInTheDocument();
  });

  it("renders one pill per scope for a plural list (M4 mixed N)", () => {
    const scopes: ChatLocalKnowledgeScope[] = [makeCapsule("c1"), makeSet("s1")];
    const chat = makeChat({ localKnowledgeScopes: scopes });
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} />);
    // GEN-UI-STATE-001: one disconnect button per pill (labels are no longer status regions).
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("uses stable keys — each pill has a distinct aria-label (no index collision)", () => {
    const scopes: ChatLocalKnowledgeScope[] = [makeCapsule("c1"), makeCapsule("c2")];
    const chat = makeChat({ localKnowledgeScopes: scopes });
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} labels={LABELS} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("aria-label", "Disconnect Pod One from chat");
    expect(buttons[1]).toHaveAttribute("aria-label", "Disconnect Pod Two from chat");
  });

  it("PATCHes with the remaining scopes when a single connector is removed (#189)", async () => {
    const scopes: ChatLocalKnowledgeScope[] = [makeCapsule("c1"), makeSet("s1")];
    const chat = makeChat({ localKnowledgeScopes: scopes });
    const updated: Chat = { ...chat, localKnowledgeScopes: [scopes[1]!] };
    const updateScopes = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectorScopePill
        chat={chat}
        updateScopes={updateScopes}
        onDisconnect={onDisconnect}
        labels={LABELS}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Disconnect Pod One from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", [scopes[1]]);
    });
    expect(onDisconnect).toHaveBeenCalledWith(updated);
  });

  it("PATCHes null when the last connector scope is removed", async () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("only") });
    const cleared: Chat = { ...chat, localKnowledgeScope: undefined };
    const updateScopes = vi.fn().mockResolvedValue({ chat: cleared } satisfies ChatResponse);
    const user = userEvent.setup();
    render(<ConnectorScopePill chat={chat} updateScopes={updateScopes} labels={LABELS} />);
    await user.click(screen.getByRole("button", { name: "Disconnect Only Pod from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", null);
    });
  });

  it("surfaces wire errors via role=alert", async () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("c1") });
    const updateScopes = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<ConnectorScopePill chat={chat} updateScopes={updateScopes} />);
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("offline");
    });
  });

  it("announces removal once the last connector is disconnected via a prop change", async () => {
    const chat = makeChat({ localKnowledgeScopes: [makeCapsule("c1")] });
    const { rerender } = render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} />);
    rerender(
      <ConnectorScopePill chat={makeChat({ localKnowledgeScopes: [] })} updateScopes={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("connector-scope-announcer")).toHaveTextContent(
        "Connected Knowledge Pod removed.",
      );
    });
  });

  it("announces a binding update with singular/plural noun as the connector count changes", async () => {
    const { rerender } = render(
      <ConnectorScopePill chat={makeChat({ localKnowledgeScopes: [] })} updateScopes={vi.fn()} />,
    );
    rerender(
      <ConnectorScopePill
        chat={makeChat({ localKnowledgeScopes: [makeCapsule("c1")] })}
        updateScopes={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("connector-scope-announcer")).toHaveTextContent(
        "Connected Knowledge Pods updated: 1 source.",
      );
    });
    rerender(
      <ConnectorScopePill
        chat={makeChat({ localKnowledgeScopes: [makeCapsule("c1"), makeSet("s1")] })}
        updateScopes={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("connector-scope-announcer")).toHaveTextContent(
        "Connected Knowledge Pods updated: 2 sources.",
      );
    });
  });

  // PR #3678: the chat header's Knowledge Pod pills were English in the German UI.
  it("speaks German in the German UI: labels, disconnect action, errors and announcements", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const chat = makeChat({ localKnowledgeScopes: [makeCapsule("c1"), makeCapsule("gone")] });
    // A failure without a message of its own shows the localized fallback.
    const updateScopes = vi.fn().mockRejectedValue(undefined);
    const user = userEvent.setup();
    try {
      const { rerender } = render(
        <I18nProvider>
          <ConnectorScopePill chat={chat} updateScopes={updateScopes} labels={LABELS} />
        </I18nProvider>,
      );
      // The provider reads the stored locale after mount.
      expect(await screen.findByText("Knowledge Pod (nicht verfügbar)")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Pod One vom Chat trennen" }));
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Knowledge Pod konnte nicht getrennt werden.",
        );
      });
      rerender(
        <I18nProvider>
          <ConnectorScopePill
            chat={makeChat({ localKnowledgeScopes: [makeCapsule("c1")] })}
            updateScopes={updateScopes}
            labels={LABELS}
          />
        </I18nProvider>,
      );
      await waitFor(() => {
        expect(screen.getByTestId("connector-scope-announcer")).toHaveTextContent(
          "Verbundene Knowledge Pods aktualisiert: 1 Quelle.",
        );
      });
    } finally {
      window.localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });
});

it("sends the canonical scope baseline when disconnecting from a stale tab", async () => {
  const identity = "gsi-v1:" + "a".repeat(64);
  const chat = makeChat({
    groundingScopeIdentity: identity,
    localKnowledgeScope: makeCapsule("c1"),
  });
  const updateScopes = vi.fn().mockResolvedValue({ chat: makeChat() } satisfies ChatResponse);
  render(<ConnectorScopePill chat={chat} updateScopes={updateScopes} labels={LABELS} />);
  await userEvent.setup().click(screen.getByRole("button", { name: /^Disconnect/ }));
  await waitFor(() => expect(updateScopes).toHaveBeenCalledWith(chat.id, null, identity));
});
