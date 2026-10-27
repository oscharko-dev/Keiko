import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/types";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";
import { updateGroundingScopes } from "@/lib/chat-grounding-mutation";
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
  await user.click(screen.getByText("Jira connection"));
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
    expect(screen.getByLabelText("Chat autonomy mode")).toHaveValue("governed-assist");
    await user.selectOptions(screen.getByLabelText("Jira Pod"), "pod-one");
    await user.click(screen.getByRole("button", { name: "Apply Jira settings" }));
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
    expect(screen.getByRole("button", { name: "Apply Jira settings" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Apply Jira settings" }));
    unmount();
    if (finish === undefined) throw new Error("Missing server completion");
    finish(CHAT);
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
  });
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
  await user.selectOptions(screen.getByLabelText("Chat autonomy mode"), "autonomous-delivery");
  await user.click(screen.getByRole("button", { name: "Apply Jira settings" }));
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
  expect(screen.getByText("Jira connection")).toHaveFocus();
});
