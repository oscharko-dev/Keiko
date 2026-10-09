import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { Chat, GroundedAnswer } from "@/lib/types";
import { MissingEvidenceActions } from "./MissingEvidenceActions";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
} from "@oscharko-dev/keiko-contracts/connected-context";

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

describe("declared missing evidence", () => {
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
