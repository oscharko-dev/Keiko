"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MarkdownSkillReference,
  MarkdownSkillSelectionView,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import { ApiError } from "@/lib/api";

export interface ChatMarkdownSkill {
  readonly chatId: string | undefined;
  readonly view: MarkdownSkillSelectionView | undefined;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly requireNoSkill?: boolean;
  readonly refresh: () => Promise<void>;
  readonly select: (skill: MarkdownSkillReference | null) => Promise<void>;
}

interface SelectionState {
  readonly chatId?: string | undefined;
  readonly view?: MarkdownSkillSelectionView | undefined;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly accessUnavailable?: boolean;
}

export function chatSkillBlocksSend(skill: ChatMarkdownSkill | undefined): boolean {
  return (
    skill?.busy === true ||
    (skill?.failed === true && skill.requireNoSkill !== true) ||
    skill?.view?.availability === "unavailable"
  );
}

export function expectedMarkdownSkillSelection(
  skill: ChatMarkdownSkill | undefined,
): number | null | undefined {
  return skill?.requireNoSkill === true ? null : skill?.view?.selection.revision;
}

function reportFailure(error: unknown): void {
  reportClientDiagnostic("Private skill selection request failed.", {
    correlationId: correlationIdOf(error),
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
}

function failedSelectionRead(
  previous: SelectionState,
  chatId: string,
  accessUnavailable: boolean,
): SelectionState {
  return {
    chatId,
    view: previous.chatId === chatId ? previous.view : undefined,
    busy: false,
    failed: true,
    accessUnavailable,
  };
}

export function useChatMarkdownSkill(chatId: string | undefined): ChatMarkdownSkill {
  const [state, setState] = useState<SelectionState>({ busy: false, failed: false });
  const current = useRef(chatId);
  current.current = chatId;
  const request = useRef(0);
  const mutating = useRef<string | undefined>(undefined);
  const refresh = useCallback(async (): Promise<void> => {
    if (chatId === undefined || mutating.current === chatId) return;
    const epoch = ++request.current;
    try {
      const { fetchMarkdownSkillSelection } = await import("@/lib/markdown-skills-api");
      const view = await fetchMarkdownSkillSelection(chatId);
      if (current.current === chatId && request.current === epoch)
        setState({ chatId, view, busy: false, failed: false });
    } catch (error) {
      if (current.current !== chatId || request.current !== epoch) return;
      const accessUnavailable = error instanceof ApiError && error.status === 404;
      if (!accessUnavailable) reportFailure(error);
      setState((previous) => failedSelectionRead(previous, chatId, accessUnavailable));
    }
  }, [chatId]);
  useEffect(() => {
    const requests = request;
    void refresh();
    window.addEventListener("focus", refresh);
    return (): void => {
      requests.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const view = state.chatId === chatId ? state.view : undefined;
  const requireNoSkill =
    view === undefined && state.chatId === chatId && state.accessUnavailable === true;
  const reload = useRef(refresh);
  reload.current = refresh;
  const select = useSelectionMutation(chatId, view, current, request, mutating, setState, reload);
  return useMemo(
    () => ({
      chatId,
      view,
      select,
      refresh,
      busy: chatId !== undefined && !requireNoSkill && (view === undefined || state.busy),
      failed: state.chatId === chatId && state.failed,
      requireNoSkill,
    }),
    [chatId, view, select, refresh, state, requireNoSkill],
  );
}

function useSelectionMutation(
  chatId: string | undefined,
  view: MarkdownSkillSelectionView | undefined,
  current: { current: string | undefined },
  request: { current: number },
  mutating: { current: string | undefined },
  setState: (update: SelectionState | ((previous: SelectionState) => SelectionState)) => void,
  reload: { current: () => Promise<void> },
): ChatMarkdownSkill["select"] {
  return useCallback(
    async (skill): Promise<void> => {
      if (chatId === undefined || view === undefined || mutating.current === chatId) return;
      mutating.current = chatId;
      const epoch = ++request.current;
      setState((previous) => ({ ...previous, busy: true }));
      const ownsResult = (): boolean => current.current === chatId && request.current === epoch;
      try {
        const { changeMarkdownSkillSelection } = await import("@/lib/markdown-skills-api");
        const updated = await changeMarkdownSkillSelection(chatId, skill, view.selection.revision);
        if (ownsResult()) setState({ chatId, view: updated, busy: false, failed: false });
      } catch (error) {
        reportFailure(error);
        if (ownsResult()) setState((previous) => ({ ...previous, busy: false, failed: true }));
        throw error;
      } finally {
        if (mutating.current === chatId) mutating.current = undefined;
        if (current.current === chatId && request.current !== epoch) void reload.current();
      }
    },
    [chatId, view, current, request, mutating, setState, reload],
  );
}
