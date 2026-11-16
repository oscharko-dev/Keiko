import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { MarkdownSkillSelectionView } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { BrowserApprovalManagementResult } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { ApiError } from "@/lib/api";
import { inspectBrowserApprovals } from "@/lib/browser-approval-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import {
  fetchMarkdownSkillSelection,
  changeMarkdownSkillSelection,
} from "@/lib/markdown-skills-api";
import { MarkdownSkillControl } from "../skills/MarkdownSkillControl";
import {
  chatSkillBlocksSend,
  expectedMarkdownSkillSelection,
  useChatMarkdownSkill,
} from "./useChatMarkdownSkill";

vi.mock("@/lib/markdown-skills-api", () => ({
  fetchMarkdownSkillSelection: vi.fn(),
  changeMarkdownSkillSelection: vi.fn(),
}));
vi.mock("@/lib/browser-approval-api", () => ({ inspectBrowserApprovals: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const EMPTY: MarkdownSkillSelectionView = {
  availability: "none",
  selection: { revision: 0, skill: null },
};
const SELECTED: MarkdownSkillSelectionView = {
  availability: "available",
  name: "Synthetic review",
  selection: {
    revision: 1,
    skill: { id: "synthetic-skill", revision: 1, digest: "a".repeat(64) },
  },
};
const CONNECTION_HINT =
  "Choose Connect browser to refresh Skills and continue. Your selection is kept.";
const accessRefused = (): ApiError => new ApiError("NOT_FOUND", "Skill not found", 404);

function Harness(): ReactNode {
  const skill = useChatMarkdownSkill("chat-a");
  return <MarkdownSkillControl skill={skill} disabled={false} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchMarkdownSkillSelection).mockResolvedValue(EMPTY);
  vi.mocked(inspectBrowserApprovals).mockResolvedValue({ state: "unavailable" });
});
afterEach(cleanup);

describe("Chat skill recovery after a browser connection ends (#4407)", () => {
  it("replaces false selection guidance after a loaded empty selection loses access", async () => {
    vi.mocked(fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(EMPTY)
      .mockRejectedValueOnce(accessRefused());
    render(<Harness />);
    await waitFor(() => expect(fetchMarkdownSkillSelection).toHaveBeenCalledTimes(1));
    await act(async () => fireEvent.focus(window));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(CONNECTION_HINT));
    expect(
      screen.queryByText("Skills could not be updated. Reload the selection and try again."),
    ).toBeNull();
    expect(changeMarkdownSkillSelection).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ composerActivity: "skill-connection-unavailable" }),
    );
    act(() => notifyCodingAppSessionChanged());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(changeMarkdownSkillSelection).not.toHaveBeenCalled();
  });

  it.each([EMPTY, SELECTED])(
    "retains the loaded selection and blocks until a fresh read succeeds: $availability",
    async (view) => {
      vi.mocked(fetchMarkdownSkillSelection)
        .mockResolvedValueOnce(view)
        .mockRejectedValue(accessRefused());
      const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
      await waitFor(() => expect(hook.result.current.view).toEqual(view));
      await act(async () => hook.result.current.refresh());
      expect(hook.result.current.connectionRequired).toBe(true);
      expect(hook.result.current.view).toEqual(view);
      expect(chatSkillBlocksSend(hook.result.current)).toBe(true);
      expect(expectedMarkdownSkillSelection(hook.result.current)).toBe(view.selection.revision);
      vi.mocked(fetchMarkdownSkillSelection).mockResolvedValue(view);
      act(() => notifyCodingAppSessionChanged());
      await waitFor(() => expect(hook.result.current.failed).toBe(false));
      expect(hook.result.current.connectionRequired).toBe(false);
      expect(chatSkillBlocksSend(hook.result.current)).toBe(false);
      expect(changeMarkdownSkillSelection).not.toHaveBeenCalled();
    },
  );

  it("does not call a masked not-found a lost connection while the server reports active", async () => {
    vi.mocked(fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(SELECTED)
      .mockRejectedValue(accessRefused());
    vi.mocked(inspectBrowserApprovals).mockResolvedValue({
      state: "active",
      requests: [],
      approvals: [],
    });
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.view).toEqual(SELECTED));
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.connectionRequired).toBe(false);
    expect(chatSkillBlocksSend(hook.result.current)).toBe(true);
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });

  it("keeps the send blocked while connection inspection is pending, then ignores a superseded result", async () => {
    let resolveInspection: ((value: BrowserApprovalManagementResult) => void) | undefined;
    vi.mocked(inspectBrowserApprovals).mockReturnValue(
      new Promise((resolve) => {
        resolveInspection = resolve;
      }),
    );
    vi.mocked(fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(SELECTED)
      .mockRejectedValueOnce(accessRefused());
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.view).toEqual(SELECTED));
    let firstRefresh: Promise<void> | undefined;
    act(() => {
      firstRefresh = hook.result.current.refresh();
    });
    await waitFor(() => expect(inspectBrowserApprovals).toHaveBeenCalledTimes(1));
    expect(chatSkillBlocksSend(hook.result.current)).toBe(true);
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.view).toEqual(EMPTY);
    await act(async () => {
      resolveInspection?.({ state: "unavailable" });
      await firstRefresh;
    });
    expect(hook.result.current.failed).toBe(false);
    expect(hook.result.current.connectionRequired).toBe(false);
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });

  it("keeps technical inspection failures distinct and preserves selected-skill refusal", async () => {
    vi.mocked(fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(SELECTED)
      .mockRejectedValue(accessRefused());
    vi.mocked(inspectBrowserApprovals).mockRejectedValue(
      new TypeError("synthetic transport failure"),
    );
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.view).toEqual(SELECTED));
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.connectionRequired).toBe(false);
    expect(chatSkillBlocksSend(hook.result.current)).toBe(true);
    expect(hook.result.current.view).toEqual(SELECTED);
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorKind: expect.any(String) }),
    );
  });

  it("keeps initially unpaired ordinary Chat available with the server-checked no-skill precondition", async () => {
    vi.mocked(fetchMarkdownSkillSelection).mockRejectedValue(accessRefused());
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.connectionRequired).toBe(true));
    expect(hook.result.current.requireNoSkill).toBe(true);
    expect(expectedMarkdownSkillSelection(hook.result.current)).toBeNull();
    expect(chatSkillBlocksSend(hook.result.current)).toBe(false);
    expect(changeMarkdownSkillSelection).not.toHaveBeenCalled();
  });

  it("does not reinterpret other selection errors as lost browser connections", async () => {
    vi.mocked(fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(SELECTED)
      .mockRejectedValue(new ApiError("INTERNAL", "Synthetic failure", 500));
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.view).toEqual(SELECTED));
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.connectionRequired).toBe(false);
    expect(chatSkillBlocksSend(hook.result.current)).toBe(true);
    expect(inspectBrowserApprovals).not.toHaveBeenCalled();
  });

  it("does not apply an old connection inspection to another chat", async () => {
    let resolveInspection: ((value: BrowserApprovalManagementResult) => void) | undefined;
    vi.mocked(inspectBrowserApprovals).mockReturnValue(
      new Promise((resolve) => {
        resolveInspection = resolve;
      }),
    );
    vi.mocked(fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(SELECTED)
      .mockRejectedValueOnce(accessRefused());
    const hook = renderHook(({ chatId }) => useChatMarkdownSkill(chatId), {
      initialProps: { chatId: "chat-a" },
    });
    await waitFor(() => expect(hook.result.current.view).toEqual(SELECTED));
    let firstRefresh: Promise<void> | undefined;
    act(() => {
      firstRefresh = hook.result.current.refresh();
    });
    await waitFor(() => expect(inspectBrowserApprovals).toHaveBeenCalledTimes(1));
    hook.rerender({ chatId: "chat-b" });
    await waitFor(() => expect(hook.result.current.view).toEqual(EMPTY));
    await act(async () => {
      resolveInspection?.({ state: "unavailable" });
      await firstRefresh;
    });
    expect(hook.result.current.chatId).toBe("chat-b");
    expect(hook.result.current.failed).toBe(false);
    expect(hook.result.current.connectionRequired).toBe(false);
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });
});
