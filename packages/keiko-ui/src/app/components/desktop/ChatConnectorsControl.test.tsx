import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/types";
import { ApiError } from "@/lib/api";
import {
  ATLASSIAN_CONNECTORS_CHANGED_EVENT,
  type AtlassianConnectorMetadata,
} from "@/lib/atlassian-connectors-api";
import type { updateGroundingScopes } from "@/lib/chat-grounding-mutation";
import { ChatConnectorsControl } from "./ChatConnectorsControl";
import type { McpServerChoice } from "./useMcpServerChoices";

const mocks = vi.hoisted(() => ({
  servers: {
    servers: [] as readonly McpServerChoice[],
    loading: false,
    failed: false,
    reload: vi.fn(),
  },
  canonical: vi.fn(),
  report: vi.fn(),
}));
vi.mock("./useMcpServerChoices", () => ({
  useMcpServerChoices: (): typeof mocks.servers => mocks.servers,
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: mocks.report }));
vi.mock("@/lib/chat-grounding-mutation", async (original) => ({
  ...(await original<typeof import("@/lib/chat-grounding-mutation")>()),
  canonicalGroundingChat: mocks.canonical,
}));

const CHAT: Chat = {
  id: "chat-1",
  projectPath: "/proj",
  title: "Chat",
  selectedModel: "model",
  branchLabel: undefined,
  status: undefined,
  connectedScope: undefined,
  localKnowledgeScope: undefined,
  createdAt: 1,
  updatedAt: 2,
  groundingScopeIdentity: "scope-one",
  toolModeCeiling: "autonomous-delivery",
};
const POD: AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "synthetic-ref",
  provider: "jira",
  deployment: "data-center",
  authScheme: "bearer-pat",
  generation: 1,
  displayName: "Lab Jira",
  baseUrl: "https://jira.example.invalid",
  createdAt: 1,
  livePod: {
    kind: "jira-live",
    podId: "pod-one",
    authenticationGeneration: 1,
    verificationRevision: 1,
    verificationInProgress: false,
    verificationStatus: "ok",
    capabilities: ["live-read"],
  },
};
const list = async (): Promise<AtlassianConnectorMetadata[]> => [POD];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.servers = {
    servers: [
      { name: "wiki", state: "connected" },
      { name: "build", state: "idle" },
    ],
    loading: false,
    failed: false,
    reload: vi.fn(),
  };
});
afterEach(() => {
  vi.useRealTimers();
});

function deferredPersist(): {
  persist: ReturnType<typeof vi.fn<typeof updateGroundingScopes>>;
  finish: (chat: Chat) => void;
  fail: (error: unknown) => void;
} {
  let finish!: (chat: Chat) => void;
  let fail!: (error: unknown) => void;
  const persist = vi.fn<typeof updateGroundingScopes>(
    () =>
      new Promise<Chat>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  return { persist, finish: (chat) => finish(chat), fail: (error) => fail(error) };
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: /Connectors/ }));
  const panel = screen.getByRole("region", { name: "Connectors" });
  await within(panel).findByRole("switch", { name: /Lab Jira/ });
  return panel;
}

describe("ChatConnectorsControl", () => {
  it("reloads both lists when opened and reflects the Chat's selection", async () => {
    const user = userEvent.setup();
    render(
      <ChatConnectorsControl
        chat={{ ...CHAT, mcpServers: ["wiki"], jiraPodBinding: binding("pod-one") }}
        onChatChanged={vi.fn()}
        list={list}
        persist={vi.fn()}
      />,
    );
    const panel = await open(user);
    expect(mocks.servers.reload).toHaveBeenCalledOnce();
    expect(within(panel).getByRole("switch", { name: /wiki/ })).toBeChecked();
    expect(within(panel).getByRole("switch", { name: /build/ })).not.toBeChecked();
    expect(within(panel).getByRole("switch", { name: /Lab Jira/ })).toBeChecked();
  });

  it("PATCHes the narrowed server selection and publishes the confirmed Chat", async () => {
    const user = userEvent.setup();
    const { persist, finish } = deferredPersist();
    const changed = vi.fn();
    render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={persist} />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    expect(persist).toHaveBeenCalledExactlyOnceWith(
      CHAT,
      { mcpServers: ["wiki"] },
      expect.any(Function),
    );
    expect(changed).not.toHaveBeenCalled();
    const updated = { ...CHAT, mcpServers: ["wiki"], updatedAt: 3 };
    await act(async () => {
      finish(updated);
    });
    await waitFor(() => expect(changed).toHaveBeenCalledWith(updated));
  });

  it("PATCHes null when the selection returns to every server", async () => {
    const user = userEvent.setup();
    const persist = vi.fn<typeof updateGroundingScopes>().mockResolvedValue(CHAT);
    render(
      <ChatConnectorsControl
        chat={{ ...CHAT, mcpServers: ["wiki"] }}
        onChatChanged={vi.fn()}
        list={list}
        persist={persist}
      />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    expect(persist).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { mcpServers: null },
      expect.any(Function),
    );
  });

  it("PATCHes the pod to bind and null to unbind", async () => {
    const user = userEvent.setup();
    const persist = vi.fn<typeof updateGroundingScopes>().mockResolvedValue(CHAT);
    const { rerender } = render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={vi.fn()} list={list} persist={persist} />,
    );
    let panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /Lab Jira/ }));
    await waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(persist).toHaveBeenLastCalledWith(CHAT, { jiraPodId: "pod-one" }, expect.any(Function));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Connectors" })).getAllByRole("switch")[0],
      ).toBeEnabled(),
    );

    const bound = { ...CHAT, jiraPodBinding: binding("pod-one") };
    rerender(
      <ChatConnectorsControl chat={bound} onChatChanged={vi.fn()} list={list} persist={persist} />,
    );
    panel = screen.getByRole("region", { name: "Connectors" });
    await user.click(within(panel).getByRole("switch", { name: /Lab Jira/ }));
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    expect(persist).toHaveBeenLastCalledWith(bound, { jiraPodId: null }, expect.any(Function));
  });

  it("PATCHes the chosen access mode, defaulting the shown mode to Full access", async () => {
    const user = userEvent.setup();
    const persist = vi.fn<typeof updateGroundingScopes>().mockResolvedValue(CHAT);
    render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={vi.fn()} list={list} persist={persist} />,
    );
    const panel = await open(user);
    expect(within(panel).getByRole("radio", { name: "Full access" })).toBeChecked();
    await user.click(within(panel).getByRole("radio", { name: "Ask for approval" }));
    expect(persist).toHaveBeenCalledExactlyOnceWith(
      CHAT,
      { toolMode: "governed-assist" },
      expect.any(Function),
    );
  });

  it("shows the server-clamped effective mode and disables modes above the ceiling", async () => {
    const user = userEvent.setup();
    render(
      <ChatConnectorsControl
        chat={{
          ...CHAT,
          toolMode: "autonomous-delivery",
          toolModeCeiling: "supervised-coding",
          effectiveToolMode: "supervised-coding",
        }}
        onChatChanged={vi.fn()}
        list={list}
        persist={vi.fn()}
      />,
    );
    const panel = await open(user);
    expect(within(panel).getByRole("radio", { name: "Supervised workspace" })).toBeChecked();
    expect(within(panel).getByRole("radio", { name: "Full access" })).toBeDisabled();
  });

  it("falls back to the stored mode when the server reports no effective mode", async () => {
    const user = userEvent.setup();
    render(
      <ChatConnectorsControl
        chat={{ ...CHAT, toolMode: "supervised-coding" }}
        onChatChanged={vi.fn()}
        list={list}
        persist={vi.fn()}
      />,
    );
    const panel = await open(user);
    expect(within(panel).getByRole("radio", { name: "Supervised workspace" })).toBeChecked();
  });

  it("allows one PATCH at a time and unlocks after it settles", async () => {
    const user = userEvent.setup();
    const { persist, finish } = deferredPersist();
    render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={vi.fn()} list={list} persist={persist} />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    for (const row of within(panel).getAllByRole("switch")) expect(row).toBeDisabled();
    for (const radio of within(panel).getAllByRole("radio")) expect(radio).toBeDisabled();
    await user.click(within(panel).getByRole("switch", { name: /wiki/ }));
    await user.click(within(panel).getByRole("switch", { name: /Lab Jira/ }));
    expect(persist).toHaveBeenCalledOnce();
    expect(panel).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      finish(CHAT);
    });
    await waitFor(() => expect(within(panel).getByRole("switch", { name: /wiki/ })).toBeEnabled());
    expect(panel).toHaveAttribute("aria-busy", "false");
  });

  it("shows the alert, reports one body-free diagnostic and publishes nothing on failure", async () => {
    const user = userEvent.setup();
    const persist = vi
      .fn<typeof updateGroundingScopes>()
      .mockRejectedValue(new ApiError("INTERNAL", "synthetic-private-detail", 500));
    const changed = vi.fn();
    render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={persist} />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Not saved. Try again.");
    expect(changed).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledOnce();
    const [message, meta] = mocks.report.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe("Chat connector selection failed.");
    expect(meta).toMatchObject({ kind: "other", correlationId: expect.any(String) });
    expect(JSON.stringify(meta)).not.toContain("synthetic-private-detail");
    await waitFor(() => expect(within(panel).getByRole("switch", { name: /wiki/ })).toBeEnabled());
  });

  it("clears the failure on the next attempt", async () => {
    const user = userEvent.setup();
    const persist = vi
      .fn<typeof updateGroundingScopes>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(CHAT);
    render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={vi.fn()} list={list} persist={persist} />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    await within(panel).findByRole("alert");
    await waitFor(() => expect(within(panel).getByRole("switch", { name: /build/ })).toBeEnabled());
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("does not show a failure for a Chat other than the one that failed", async () => {
    const user = userEvent.setup();
    const { persist, fail } = deferredPersist();
    const changed = vi.fn();
    const { rerender } = render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={persist} />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    rerender(
      <ChatConnectorsControl
        chat={{ ...CHAT, id: "chat-2" }}
        onChatChanged={changed}
        list={list}
        persist={persist}
      />,
    );
    await act(async () => {
      fail(new Error("offline"));
    });
    await waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not publish a reply for a Chat that is no longer shown", async () => {
    const user = userEvent.setup();
    const { persist, finish } = deferredPersist();
    const changed = vi.fn();
    const { rerender } = render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={persist} />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    rerender(
      <ChatConnectorsControl
        chat={{ ...CHAT, id: "chat-2" }}
        onChatChanged={changed}
        list={list}
        persist={persist}
      />,
    );
    await act(async () => {
      finish(CHAT);
    });
    expect(changed).not.toHaveBeenCalled();
  });

  it("publishes the interim canonical Chat that the mutation reports while it is shown", async () => {
    const user = userEvent.setup();
    const interim = { ...CHAT, updatedAt: 9 };
    const persist = vi.fn<typeof updateGroundingScopes>(async (_chat, _patch, publish) => {
      publish(interim);
      return interim;
    });
    const changed = vi.fn();
    render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={persist} />,
    );
    const panel = await open(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(changed).toHaveBeenNthCalledWith(1, interim);
  });

  it("surfaces a failed server or pod read as the failure alert", async () => {
    const user = userEvent.setup();
    mocks.servers = { ...mocks.servers, failed: true };
    render(
      <ChatConnectorsControl chat={CHAT} onChatChanged={vi.fn()} list={list} persist={vi.fn()} />,
    );
    await open(user);
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved. Try again.");
  });

  it("surfaces a failed pod listing", async () => {
    const user = userEvent.setup();
    render(
      <ChatConnectorsControl
        chat={CHAT}
        onChatChanged={vi.fn()}
        list={() => Promise.reject(new Error("offline"))}
        persist={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Connectors/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved. Try again.");
  });

  it("passes the Manage handlers through", async () => {
    const user = userEvent.setup();
    const onManageServers = vi.fn();
    const onManagePods = vi.fn();
    render(
      <ChatConnectorsControl
        chat={CHAT}
        onChatChanged={vi.fn()}
        list={list}
        persist={vi.fn()}
        onManageServers={onManageServers}
        onManagePods={onManagePods}
      />,
    );
    await open(user);
    await user.click(
      within(screen.getByRole("region", { name: "MCP servers" })).getByRole("button", {
        name: "MCP servers: Manage",
      }),
    );
    await user.click(
      within(screen.getByRole("region", { name: "Jira Pods" })).getByRole("button", {
        name: "Jira Pods: Manage",
      }),
    );
    expect(onManageServers).toHaveBeenCalledOnce();
    expect(onManagePods).toHaveBeenCalledOnce();
  });

  describe("canonical refresh", () => {
    it("adopts a newer canonical Chat after a connector change event", async () => {
      const changed = vi.fn();
      const newer = { ...CHAT, updatedAt: 5 };
      mocks.canonical.mockResolvedValue(newer);
      render(
        <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={vi.fn()} />,
      );
      act(() => {
        window.dispatchEvent(new Event(ATLASSIAN_CONNECTORS_CHANGED_EVENT));
      });
      await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(newer));
      expect(mocks.canonical).toHaveBeenCalledWith(CHAT);
    });

    it("ignores an older canonical Chat", async () => {
      const changed = vi.fn();
      mocks.canonical.mockResolvedValue({ ...CHAT, updatedAt: 1 });
      render(
        <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={vi.fn()} />,
      );
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(mocks.canonical).toHaveBeenCalledOnce());
      await act(async () => {
        await Promise.resolve();
      });
      expect(changed).not.toHaveBeenCalled();
    });

    it("ignores a canonical reply for a Chat that is no longer shown", async () => {
      const changed = vi.fn();
      let reply!: (chat: Chat) => void;
      mocks.canonical.mockReturnValue(
        new Promise<Chat>((resolve) => {
          reply = resolve;
        }),
      );
      const { rerender } = render(
        <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={vi.fn()} />,
      );
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      rerender(
        <ChatConnectorsControl
          chat={{ ...CHAT, id: "chat-2" }}
          onChatChanged={changed}
          list={list}
          persist={vi.fn()}
        />,
      );
      await act(async () => {
        reply({ ...CHAT, updatedAt: 5 });
      });
      expect(changed).not.toHaveBeenCalled();
    });

    it("reports a failed canonical read without publishing", async () => {
      const changed = vi.fn();
      mocks.canonical.mockRejectedValue(new Error("offline"));
      render(
        <ChatConnectorsControl chat={CHAT} onChatChanged={changed} list={list} persist={vi.fn()} />,
      );
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
      expect(mocks.report.mock.calls[0]?.[0]).toBe("Chat connector refresh failed.");
      expect(changed).not.toHaveBeenCalled();
    });
  });
});

function binding(podId: string): NonNullable<Chat["jiraPodBinding"]> {
  return { podId, bindingGeneration: 1, authenticationGeneration: 1, connectedAtMs: 1 };
}
