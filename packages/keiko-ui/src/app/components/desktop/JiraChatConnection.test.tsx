import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/types";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";
import { updateGroundingScopes } from "@/lib/chat-grounding-mutation";
import { requestJiraChatConnection } from "./jira-chat-connection-request";
import { JiraChatConnection } from "./JiraChatConnection";

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
  effectiveToolMode: "governed-assist",
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
async function open(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText("Tool access"));
}

describe("Jira Chat connection", () => {
  it("keeps the binding inactive until the server confirms and defaults to Ask for approval", async () => {
    const user = userEvent.setup();
    let finish: ((chat: Chat) => void) | undefined;
    const persist = vi.fn<typeof updateGroundingScopes>(
      () =>
        new Promise<Chat>((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    render(
      <JiraChatConnection
        chat={CHAT}
        onChatChanged={changed}
        list={async () => [POD]}
        persist={persist}
      />,
    );
    await open(user);
    await screen.findByRole("option", { name: "Lab Jira" });
    expect(screen.getByLabelText("Chat autonomy mode")).toHaveTextContent("Ask for approval");
    await user.selectOptions(screen.getByLabelText("Jira Pod"), "pod-one");
    await user.click(screen.getByRole("button", { name: "Apply tool settings" }));
    expect(changed).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith(
      CHAT,
      { jiraPodId: "pod-one", toolMode: "governed-assist" },
      expect.any(Function),
    );
    if (finish === undefined) throw new Error("Missing server completion");
    finish({
      ...CHAT,
      jiraPodBinding: {
        podId: "pod-one",
        bindingGeneration: 1,
        authenticationGeneration: 1,
        connectedAtMs: 1,
      },
    });
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  });
  it("requires explicit replacement confirmation and ignores a late result after unmount", async () => {
    const user = userEvent.setup();
    const bound = {
      ...CHAT,
      jiraPodBinding: {
        podId: "old-pod",
        bindingGeneration: 1,
        authenticationGeneration: 1,
        connectedAtMs: 1,
      },
    };
    let finish: ((chat: Chat) => void) | undefined;
    const persist = vi.fn<typeof updateGroundingScopes>(
      () =>
        new Promise<Chat>((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    const { unmount } = render(
      <JiraChatConnection
        chat={bound}
        onChatChanged={changed}
        list={async () => [POD]}
        persist={persist}
      />,
    );
    await open(user);
    await screen.findByRole("option", { name: "Lab Jira" });
    await user.selectOptions(screen.getByLabelText("Jira Pod"), "pod-one");
    expect(screen.getByRole("button", { name: "Apply tool settings" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Apply tool settings" }));
    unmount();
    if (finish === undefined) throw new Error("Missing server completion");
    finish(CHAT);
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
  });
});

it("shows the server-clamped effective mode and prevents selecting modes above its ceiling", async () => {
  const user = userEvent.setup();
  render(
    <JiraChatConnection
      chat={{
        ...CHAT,
        toolMode: "autonomous-delivery",
        toolModeCeiling: "supervised-coding",
        effectiveToolMode: "supervised-coding",
      }}
      onChatChanged={vi.fn()}
      list={async () => [POD]}
    />,
  );
  await open(user);
  expect(await screen.findByText("Effective mode: Supervised workspace")).toBeVisible();
  await user.click(screen.getByRole("combobox", { name: "Chat autonomy mode" }));
  expect(screen.getByRole("option", { name: "Full access" })).toBeDisabled();
  expect(screen.getByRole("option", { name: "Supervised workspace" })).not.toBeDisabled();
});

it("shows the bound Pod identity while the connection disclosure stays closed", async () => {
  render(
    <JiraChatConnection
      chat={{
        ...CHAT,
        jiraPodBinding: {
          podId: "pod-one",
          bindingGeneration: 1,
          authenticationGeneration: 1,
          connectedAtMs: 1,
        },
      }}
      list={async () => [POD]}
      onChatChanged={vi.fn()}
    />,
  );
  expect(await screen.findByText("Lab Jira")).toBeVisible();
  expect(screen.getByTestId("jira-chat-connection")).not.toHaveAttribute("open");
  expect(screen.queryByRole("button", { name: "Apply tool settings" })).not.toBeInTheDocument();
});

it("persists the selected mode through the same owner and never treats failure as confirmation", async () => {
  const user = userEvent.setup();
  const persist = vi.fn<typeof updateGroundingScopes>().mockRejectedValue(new Error("conflict"));
  const changed = vi.fn();
  render(
    <JiraChatConnection
      chat={CHAT}
      onChatChanged={changed}
      list={async () => [POD]}
      persist={persist}
    />,
  );
  await open(user);
  await screen.findByRole("option", { name: "Lab Jira" });
  await user.click(screen.getByRole("combobox", { name: "Chat autonomy mode" }));
  await user.click(screen.getByRole("option", { name: "Full access" }));
  await user.click(screen.getByRole("button", { name: "Apply tool settings" }));
  await screen.findByRole("alert");
  expect(persist).toHaveBeenCalledWith(
    CHAT,
    { jiraPodId: null, toolMode: "autonomous-delivery" },
    expect.any(Function),
  );
  expect(changed).not.toHaveBeenCalled();
});

it("disables unverified Pods and closes with Escape while restoring focus", async () => {
  const user = userEvent.setup();
  if (POD.deployment !== "data-center" || POD.livePod === undefined)
    throw new Error("Missing fixture");
  const failed: AtlassianConnectorMetadata = {
    ...POD,
    livePod: { ...POD.livePod, verificationStatus: "auth-failed" as const },
  };
  const { container } = render(
    <JiraChatConnection chat={CHAT} onChatChanged={vi.fn()} list={async () => [failed]} />,
  );
  await open(user);
  expect(await screen.findByRole("option", { name: /Lab Jira/ })).toBeDisabled();
  expect(await axe(container)).toHaveNoViolations();
  screen.getByLabelText("Chat autonomy mode").focus();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.getByTestId("jira-chat-connection")).not.toHaveAttribute("open"),
  );
  expect(screen.getByText("Tool access").closest("summary")).toHaveFocus();
});

describe("Jira workspace connection requests", () => {
  it("settles the requested edge only after the exact Chat and Pod are acknowledged", async () => {
    const user = userEvent.setup();
    let finish!: (chat: Chat) => void;
    const persist = vi.fn<typeof updateGroundingScopes>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <div data-window-id="chat-window">
        <JiraChatConnection
          chat={CHAT}
          list={async () => [POD]}
          persist={persist}
          onChatChanged={vi.fn()}
        />
      </div>,
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = requestJiraChatConnection("chat-window", CHAT.id, "pod-one");
    });
    const settled = vi.fn();
    void pending.then(settled);
    await screen.findByRole("option", { name: "Lab Jira" });
    await user.click(screen.getByRole("button", { name: "Apply tool settings" }));
    expect(settled).not.toHaveBeenCalled();
    await act(async () => {
      finish({
        ...CHAT,
        jiraPodBinding: {
          podId: "pod-one",
          bindingGeneration: 1,
          authenticationGeneration: 1,
          connectedAtMs: 1,
        },
      });
    });
    expect(await pending).toBe(true);
  });

  it("re-acknowledges an already-bound Pod through the server when a new workspace edge requests it", async () => {
    const user = userEvent.setup();
    const bound: Chat = {
      ...CHAT,
      jiraPodBinding: {
        podId: "pod-one",
        bindingGeneration: 2,
        authenticationGeneration: 1,
        connectedAtMs: 1,
      },
    };
    const persist = vi.fn<typeof updateGroundingScopes>().mockResolvedValue(bound);
    render(
      <div data-window-id="chat-window">
        <JiraChatConnection
          chat={bound}
          list={async () => [POD]}
          persist={persist}
          onChatChanged={vi.fn()}
        />
      </div>,
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = requestJiraChatConnection("chat-window", CHAT.id, "pod-one");
    });
    await screen.findByRole("option", { name: "Lab Jira" });
    expect(screen.getByRole("button", { name: "Apply tool settings" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Apply tool settings" }));
    expect(await pending).toBe(true);
    expect(persist).toHaveBeenCalledWith(
      bound,
      { jiraPodId: "pod-one", toolMode: "governed-assist" },
      expect.any(Function),
    );
  });

  it("keeps explicit replacement confirmation and cancels pending requests with Escape", async () => {
    const user = userEvent.setup();
    const persist = vi.fn<typeof updateGroundingScopes>();
    const chat = {
      ...CHAT,
      jiraPodBinding: {
        podId: "old-pod",
        bindingGeneration: 1,
        authenticationGeneration: 1,
        connectedAtMs: 1,
      },
    };
    render(
      <div data-window-id="chat-window">
        <JiraChatConnection
          chat={chat}
          list={async () => [POD]}
          persist={persist}
          onChatChanged={vi.fn()}
        />
      </div>,
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = requestJiraChatConnection("chat-window", CHAT.id, "pod-one");
    });
    await screen.findByRole("option", { name: "Lab Jira" });
    expect(screen.getByRole("button", { name: "Apply tool settings" })).toBeDisabled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await user.keyboard("{Escape}");
    await waitFor(async () => expect(await pending).toBe(false));
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects superseded requests and late responses after the requested form is gone", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    let finish!: (chat: Chat) => void;
    const persist = vi.fn<typeof updateGroundingScopes>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(
      <div data-window-id="chat-window">
        <JiraChatConnection
          chat={CHAT}
          list={async () => [POD]}
          persist={persist}
          onChatChanged={changed}
        />
      </div>,
    );
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = requestJiraChatConnection("chat-window", CHAT.id, "pod-one");
    });
    act(() => {
      second = requestJiraChatConnection("chat-window", CHAT.id, "pod-one");
    });
    expect(await first).toBe(false);
    await screen.findByRole("option", { name: "Lab Jira" });
    await user.click(screen.getByRole("button", { name: "Apply tool settings" }));
    view.unmount();
    expect(await second).toBe(false);
    await act(async () => {
      finish({
        ...CHAT,
        jiraPodBinding: {
          podId: "pod-one",
          bindingGeneration: 1,
          authenticationGeneration: 1,
          connectedAtMs: 1,
        },
      });
    });
    expect(changed).not.toHaveBeenCalled();
  });

  it("rejects an absent or differently targeted form without changing any source", async () => {
    render(
      <div data-window-id="other-window">
        <JiraChatConnection chat={CHAT} list={async () => [POD]} onChatChanged={vi.fn()} />
      </div>,
    );
    expect(await requestJiraChatConnection("chat-window", CHAT.id, "pod-one")).toBe(false);
    expect(await requestJiraChatConnection("other-window", "another-chat", "pod-one")).toBe(false);
  });
});
