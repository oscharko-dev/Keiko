import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { ApiError, fetchChats, type updateChatConnectedScopes } from "@/lib/api";
import type { Chat, ChatResponse, GroundedAnswer } from "@/lib/types";
import { MissingEvidenceActions } from "./MissingEvidenceActions";
import { ConnectedScopePill } from "./ConnectedScopePill";
import { reportScopeNotice } from "./ChatScopeNotice";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
} from "@oscharko-dev/keiko-contracts/connected-context";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchChats: vi.fn(),
}));
vi.mock("./ChatScopeNotice", () => ({ reportScopeNotice: vi.fn() }));

const chat: Chat = {
  id: "a",
  projectPath: "/repo",
  title: "Chat",
  selectedModel: "model",
  branchLabel: undefined,
  status: undefined,
  localKnowledgeScope: undefined,
  connectedScope: undefined,
  connectedScopes: [{ kind: "directory", root: "/repo", relativePaths: ["src"], connectedAtMs: 1 }],
  createdAt: 1,
  updatedAt: 1,
};
function answer(path: string): GroundedAnswer {
  return {
    groundingKind: "connected-context",
    userMessageId: "u",
    assistantMessageId: "a",
    answerKind: "insufficiency",
    insufficiencyDeclarations: [{ scopePath: path, state: "unread-in-scope" }],
    content: "Need the declared file.",
    citations: [],
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 1,
    contextPack: buildGroundedAnswerContextPackSummary(
      {
        schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
        stableId: "stable",
        emittedAtMs: 1,
        ledgerRef: undefined,
        scope: {
          schemaVersion: "1",
          scopeId: "scope",
          kind: "directory",
          workspaceRoot: "/repo",
          conversationId: "a",
          connectedAtMs: 1,
          relativePaths: ["src"],
        },
        query: {
          kind: "natural-language",
          text: "query",
          caseSensitive: false,
          maxResults: 24,
          emittedAtMs: 1,
        },
        budget: DEFAULT_EXPLORATION_BUDGET,
        usage: {
          searchCalls: 0,
          filesRead: 0,
          excerptBytes: 0,
          modelInputTokens: 0,
          modelOutputTokens: 0,
          elapsedMs: 0,
          rerankCalls: 0,
        },
        files: [],
        omitted: [],
        uncertainty: [],
      },
      0,
      1,
    ),
  };
}

function scopeResponse(): {
  readonly promise: Promise<ChatResponse>;
  readonly release: (value: ChatResponse) => void;
} {
  let release = (_value: ChatResponse): void => {
    throw new Error("Scope response has not been initialized.");
  };
  const promise = new Promise<ChatResponse>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function ScopeActionHarness({
  initial,
  updateScopes,
  focus,
}: {
  readonly initial: Chat;
  readonly updateScopes: typeof updateChatConnectedScopes;
  readonly focus: () => void;
}): ReactNode {
  const [current, setCurrent] = useState(initial);
  const [draft, setDraft] = useState("Unsent draft");
  return (
    <div className="chat-scope-header">
      <ConnectedScopePill chat={current} onDisconnect={setCurrent} updateScopes={updateScopes} />
      <MissingEvidenceActions
        answer={answer("src/validation.ts")}
        chat={current}
        onChatChanged={setCurrent}
        setDraft={setDraft}
        draft={draft}
        focusComposer={focus}
        updateScopes={updateScopes}
      />
      <output data-testid="scope-identity">{current.groundingScopeIdentity}</output>
      <output data-testid="scope-list">{JSON.stringify(current.connectedScopes)}</output>
      <output data-testid="draft">{draft}</output>
    </div>
  );
}

function delayedScopeTransport(): {
  readonly initial: Chat;
  readonly persist: typeof updateChatConnectedScopes;
  readonly acknowledgeAdd: () => void;
  readonly disconnectedIdentity: string;
} {
  const initial: Chat = { ...chat, groundingScopeIdentity: "gsi-v1:" + "a".repeat(64) };
  const pending = scopeResponse();
  let current = initial;
  let added: ChatResponse | undefined;
  const disconnectedIdentity = "gsi-v1:" + "c".repeat(64);
  const persist = vi
    .fn<typeof updateChatConnectedScopes>()
    .mockImplementation(async (_id, scopes, identity) => {
      if (identity !== current.groundingScopeIdentity) {
        throw new ApiError("GROUNDING_SCOPE_CHANGED", "The sources changed.", 409);
      }
      current = {
        ...current,
        connectedScopes: scopes ?? undefined,
        groundingScopeIdentity:
          added === undefined ? "gsi-v1:" + "b".repeat(64) : disconnectedIdentity,
        updatedAt: current.updatedAt + 1,
      };
      if (added !== undefined) return { chat: current };
      added = { chat: current };
      return pending.promise;
    });
  vi.mocked(fetchChats).mockImplementation(async () => ({ chats: [current] }));
  return {
    initial,
    persist,
    disconnectedIdentity,
    acknowledgeAdd: (): void => {
      if (added === undefined) throw new Error("No Add-file request was sent.");
      pending.release(added);
    },
  };
}

async function disconnectFolder(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^Disconnect Folder:/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Disconnect Folder:/ })).toHaveAttribute(
      "aria-disabled",
      "false",
    ),
  );
}

describe("missing-evidence scope acknowledgements", () => {
  it.each(["scope", "draft"] as const)(
    "preserves the %s after a newer Disconnect precedes the delayed Add-file reply",
    async (observable) => {
      const transport = delayedScopeTransport();
      const focus = vi.fn();
      render(
        <ScopeActionHarness
          initial={transport.initial}
          updateScopes={transport.persist}
          focus={focus}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Add file to scope" }));
      await waitFor(() => expect(transport.persist).toHaveBeenCalledTimes(1));
      await disconnectFolder();
      expect(fetchChats).toHaveBeenCalledExactlyOnceWith(
        chat.projectPath,
        expect.any(String),
        chat.id,
      );
      fireEvent.click(screen.getByRole("button", { name: /^Disconnect Folder:/ }));
      await waitFor(() =>
        expect(screen.getByTestId("scope-identity")).toHaveTextContent(
          transport.disconnectedIdentity,
        ),
      );
      const acknowledgedScopes = screen.getByTestId("scope-list").textContent;
      await act(async () => transport.acknowledgeAdd());
      if (observable === "draft") {
        expect(screen.getByTestId("draft")).toHaveTextContent(/^Unsent draft$/);
      }
      expect(screen.getByTestId("scope-identity")).toHaveTextContent(
        transport.disconnectedIdentity,
      );
      expect(screen.getByTestId("scope-list").textContent).toBe(acknowledgedScopes);
      expect(screen.queryByRole("button", { name: /^Disconnect Folder:/ })).toBeNull();
      expect(screen.getByTestId("draft")).toHaveTextContent(/^Unsent draft$/);
      expect(focus).not.toHaveBeenCalled();
      expect(reportScopeNotice).not.toHaveBeenCalled();
    },
  );

  it("adopts the initial successful Add-file reply and appends one focused unsent follow-up", async () => {
    const transport = delayedScopeTransport();
    const focus = vi.fn();
    render(
      <ScopeActionHarness
        initial={transport.initial}
        updateScopes={transport.persist}
        focus={focus}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add file to scope" }));
    await waitFor(() => expect(transport.persist).toHaveBeenCalledTimes(1));
    await act(async () => transport.acknowledgeAdd());
    expect(screen.getByTestId("scope-identity")).toHaveTextContent("gsi-v1:" + "b".repeat(64));
    expect(screen.getByTestId("draft")).toHaveTextContent("Unsent draft");
    expect(screen.getByTestId("draft")).toHaveTextContent("@src/validation.ts");
    expect(focus).toHaveBeenCalledOnce();
    expect(reportScopeNotice).toHaveBeenCalledOnce();
  });

  it("keeps the newer Disconnect when Add-file is acknowledged in normal request order", async () => {
    const transport = delayedScopeTransport();
    const focus = vi.fn();
    render(
      <ScopeActionHarness
        initial={transport.initial}
        updateScopes={transport.persist}
        focus={focus}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add file to scope" }));
    await waitFor(() => expect(transport.persist).toHaveBeenCalledTimes(1));
    await act(async () => transport.acknowledgeAdd());
    const acknowledgedDraft = screen.getByTestId("draft").textContent;
    fireEvent.click(screen.getByRole("button", { name: /^Disconnect Folder:/ }));
    await waitFor(() =>
      expect(screen.getByTestId("scope-identity")).toHaveTextContent(
        transport.disconnectedIdentity,
      ),
    );
    expect(screen.queryByRole("button", { name: /^Disconnect Folder:/ })).toBeNull();
    expect(screen.getByTestId("draft").textContent).toBe(acknowledgedDraft);
    expect(focus).toHaveBeenCalledOnce();
    expect(fetchChats).not.toHaveBeenCalled();
  });
});

describe("declared missing evidence", () => {
  it("uses the sole remaining eligible root after an acknowledged two-to-one transition", async () => {
    const persist = vi.fn().mockResolvedValue({ chat });
    const common = {
      answer: answer("src/validation.ts"),
      onChatChanged: vi.fn(),
      setDraft: vi.fn(),
      focusComposer: vi.fn(),
      updateScopes: persist,
    };
    const multiple = {
      ...chat,
      connectedScopes: [
        ...(chat.connectedScopes ?? []),
        { kind: "workspace-root" as const, root: "/other", relativePaths: [], connectedAtMs: 2 },
      ],
    };
    const view = render(<MissingEvidenceActions {...common} chat={multiple} />);
    expect(screen.getByRole("button", { name: "Add file to scope" })).toBeDisabled();
    view.rerender(<MissingEvidenceActions {...common} chat={chat} />);
    const add = screen.getByRole("button", { name: "Add file to scope" });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(persist).toHaveBeenCalled());
    expect(persist.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "files", root: "/repo" })]),
    );
  });
  it("requires an explicit choice when a previously sole root becomes ambiguous", () => {
    const common = {
      answer: answer("src/validation.ts"),
      onChatChanged: vi.fn(),
      setDraft: vi.fn(),
      focusComposer: vi.fn(),
    };
    const view = render(<MissingEvidenceActions {...common} chat={chat} />);
    expect(screen.getByRole("button", { name: "Add file to scope" })).toBeEnabled();
    view.rerender(
      <MissingEvidenceActions
        {...common}
        chat={{
          ...chat,
          connectedScopes: [
            ...(chat.connectedScopes ?? []),
            { kind: "workspace-root", root: "/other", relativePaths: [], connectedAtMs: 2 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Add file to scope" })).toBeDisabled();
  });
  it("adds a validated in-scope file using the existing merge and prefills a focused unsent follow-up", async () => {
    const updateScopes = vi.fn().mockResolvedValue({ chat });
    const changed = vi.fn();
    const draft = vi.fn();
    const focus = vi.fn();
    render(
      <MissingEvidenceActions
        answer={answer("src/validation.ts")}
        chat={chat}
        onChatChanged={changed}
        setDraft={draft}
        focusComposer={focus}
        updateScopes={updateScopes}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add file to scope/ }));
    await waitFor(() => expect(updateScopes).toHaveBeenCalled());
    expect(updateScopes.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "files",
          root: "/repo",
          relativePaths: ["src/validation.ts"],
        }),
      ]),
    );
    expect(changed).toHaveBeenCalledWith(chat);
    expect(draft).toHaveBeenCalledWith(expect.stringContaining("@src/validation.ts"));
    expect(focus).toHaveBeenCalledTimes(1);
  });
  it.each(["../secret.ts", "/absolute/file.ts", "outside/not-connected.ts"])(
    "offers no scope widening for %s",
    (path) => {
      render(
        <MissingEvidenceActions
          answer={answer(path)}
          chat={chat}
          onChatChanged={vi.fn()}
          setDraft={vi.fn()}
          focusComposer={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: /Add file to scope/ })).toBeNull();
    },
  );
  it("requires a connected-root choice when the declared path has multiple owners", () => {
    const multiple = {
      ...chat,
      connectedScopes: [
        ...(chat.connectedScopes ?? []),
        { kind: "workspace-root" as const, root: "/other", relativePaths: [], connectedAtMs: 2 },
      ],
    };
    const persist = vi.fn();
    render(
      <MissingEvidenceActions
        answer={answer("src/validation.ts")}
        chat={multiple}
        onChatChanged={vi.fn()}
        setDraft={vi.fn()}
        focusComposer={vi.fn()}
        updateScopes={persist}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Connected folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add file to scope/ })).toBeDisabled();
    expect(persist).not.toHaveBeenCalled();
  });
});

it("has no axe violations in the missing-file action and connected-root picker", async () => {
  const view = render(
    <MissingEvidenceActions
      answer={answer("src/validation.ts")}
      chat={chat}
      onChatChanged={vi.fn()}
      setDraft={vi.fn()}
      focusComposer={vi.fn()}
    />,
  );
  expect((await axe(view.container)).violations).toEqual([]);
});
