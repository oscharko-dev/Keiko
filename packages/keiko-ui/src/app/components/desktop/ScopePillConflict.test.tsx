import { useState, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchChats } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type {
  Chat,
  ChatConnectedScope,
  ChatGitChangeScope,
  ChatLocalKnowledgeScope,
  ChatResponse,
} from "@/lib/types";
import { ConnectedScopePill } from "./ConnectedScopePill";
import { ConnectorScopePill } from "./ConnectorScopePill";
import { GitChangeScopePill } from "./GitChangeScopePill";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchChats: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

type Scope = ChatConnectedScope | ChatLocalKnowledgeScope | ChatGitChangeScope;
interface PillProps {
  readonly chat: Chat;
  readonly onDisconnect: (chat: Chat) => void;
  readonly updateScopes: (
    id: string,
    scopes: readonly Scope[] | null,
    identity?: string,
  ) => Promise<ChatResponse>;
}
interface PillCase {
  readonly name: string;
  readonly initial: Chat;
  readonly remaining: readonly Scope[];
  readonly canonical: Chat;
  readonly clickLabel: string;
  readonly renderPill: (props: PillProps) => ReactNode;
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-pill",
    projectPath: "/project",
    title: "Source review",
    selectedModel: "model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
    ...overrides,
  };
}

function gitScope(id: string): ChatGitChangeScope {
  return {
    kind: "git-change",
    relationshipId: id,
    remoteDigest: "d".repeat(64),
    comparisonLabel: `main...${id}`,
    baseRef: "main",
    headRef: id,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    snapshotDigest: "e".repeat(64),
    fileCount: 3,
    totalFiles: 3,
    omittedFiles: 0,
    truncatedFiles: 0,
    descriptionStatus: "current",
    connectedAtMs: 10,
  };
}

function pillCases(): PillCase[] {
  const alpha: ChatConnectedScope = {
    kind: "workspace-root",
    relativePaths: [],
    connectedAtMs: 1,
    root: "/data/alpha",
  };
  const beta: ChatConnectedScope = { ...alpha, connectedAtMs: 2, root: "/data/beta" };
  const pod: ChatLocalKnowledgeScope = {
    kind: "capsule",
    capsuleId: "pod-1" as Extract<ChatLocalKnowledgeScope, { kind: "capsule" }>["capsuleId"],
    connectedAtMs: 1,
  };
  const set: ChatLocalKnowledgeScope = {
    kind: "capsule-set",
    capsuleSetId: "set-1" as Extract<
      ChatLocalKnowledgeScope,
      { kind: "capsule-set" }
    >["capsuleSetId"],
    connectedAtMs: 2,
  };
  const first = gitScope("first");
  const second = gitScope("second");
  return [
    {
      name: "folder",
      initial: chat({ connectedScopes: [beta, alpha] }),
      remaining: [beta],
      canonical: chat({ connectedScopes: [beta] }),
      clickLabel: "Disconnect Folder: alpha (/data/alpha) from chat",
      renderPill: (props) => <ConnectedScopePill {...props} />,
    },
    {
      name: "connector",
      initial: chat({ localKnowledgeScopes: [set, pod] }),
      remaining: [set],
      canonical: chat({ localKnowledgeScopes: [set] }),
      clickLabel: "Disconnect Pod One from chat",
      renderPill: (props) => (
        <ConnectorScopePill
          {...props}
          labels={
            new Map([
              ["capsule:pod-1", "Pod One"],
              ["set:set-1", "Set One"],
            ])
          }
        />
      ),
    },
    {
      name: "git",
      initial: chat({ gitChangeScopes: [second, first] }),
      remaining: [second],
      canonical: chat({ gitChangeScopes: [second] }),
      clickLabel: "Disconnect main...first from chat",
      renderPill: (props) => <GitChangeScopePill {...props} />,
    },
  ];
}

function refusal(): ApiError {
  const error = new ApiError("GROUNDING_SCOPE_CHANGED", "private-source-canary", 409);
  error.correlationId = "pill-conflict-attempt";
  return error;
}

function mountPill(
  subject: PillCase,
  updateScopes: PillProps["updateScopes"],
): ReturnType<typeof vi.fn> {
  const changed = vi.fn();
  function Harness(): ReactNode {
    const [current, setCurrent] = useState(subject.initial);
    return (
      <div className="chat-scope-header">
        {subject.renderPill({
          chat: current,
          updateScopes,
          onDisconnect: (next) => {
            changed(next);
            setCurrent(next);
          },
        })}
        <button type="button">Grounding</button>
      </div>
    );
  }
  render(<Harness />);
  return changed;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(pillCases())("$name source-pill conflict", (subject) => {
  it.each([false, true])(
    "keeps the refusal and focus after canonical refresh removes the clicked pill (empty: %s)",
    async (empty) => {
      const canonical = {
        ...(empty ? chat() : subject.canonical),
        groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
        updatedAt: 3,
      };
      vi.mocked(fetchChats).mockResolvedValue({ chats: [canonical] });
      const updateScopes = vi.fn().mockRejectedValue(refusal());
      const changed = mountPill(subject, updateScopes);
      await userEvent.click(screen.getByRole("button", { name: subject.clickLabel }));
      await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(canonical));
      expect(updateScopes).toHaveBeenCalledExactlyOnceWith(
        "chat-pill",
        subject.remaining,
        subject.initial.groundingScopeIdentity,
      );
      expect(fetchChats).toHaveBeenCalledExactlyOnceWith(
        "/project",
        "pill-conflict-attempt",
        "chat-pill",
      );
      expect(screen.queryByRole("button", { name: subject.clickLabel })).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("GROUNDING_SCOPE_CHANGED");
      expect(screen.getByRole("alert")).not.toHaveTextContent("private-source-canary");
      await waitFor(() => expect(screen.getAllByRole("button")[0]).toHaveFocus());
      expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
        "Grounding scope mutation refused.",
        expect.objectContaining({
          correlationId: "pill-conflict-attempt",
          errorKind: "conflict",
          errorEvidence: expect.objectContaining({ frames: [], causeChain: [] }),
        }),
      );
      expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain(
        "private-source-canary",
      );
    },
  );

  it("preserves the exact remaining source and sends one replacement against the original identity", async () => {
    const updateScopes = vi.fn().mockResolvedValue({ chat: subject.canonical });
    const changed = mountPill(subject, updateScopes);
    await userEvent.click(screen.getByRole("button", { name: subject.clickLabel }));
    await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(subject.canonical));
    expect(updateScopes).toHaveBeenCalledExactlyOnceWith(
      "chat-pill",
      subject.remaining,
      subject.initial.groundingScopeIdentity,
    );
    expect(fetchChats).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not move a late refusal into a different chat", async () => {
    let reject: ((reason: unknown) => void) | undefined;
    const pending = new Promise<ChatResponse>((_, rejectPromise) => {
      reject = rejectPromise;
    });
    const updateScopes = vi.fn().mockReturnValue(pending);
    const onDisconnect = vi.fn();
    const props = { chat: subject.initial, updateScopes, onDisconnect };
    const { rerender } = render(subject.renderPill(props));
    await userEvent.click(screen.getByRole("button", { name: subject.clickLabel }));
    expect(updateScopes).toHaveBeenCalledOnce();
    rerender(subject.renderPill({ ...props, chat: { ...subject.initial, id: "another-chat" } }));
    await act(async () => {
      reject?.(new ApiError("BAD_REQUEST", "The old request failed.", 400));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
