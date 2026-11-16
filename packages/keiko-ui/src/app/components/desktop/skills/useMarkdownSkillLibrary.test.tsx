import { useLayoutEffect, useRef } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MarkdownSkillDocument,
  MarkdownSkillMetadata,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  deleteMarkdownSkill,
  fetchMarkdownSkills,
  readMarkdownSkill,
} from "@/lib/markdown-skills-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useMarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

const session = vi.hoisted(() => ({ redemptions: 0 }));
vi.mock("@/lib/coding-app-session-client", () => ({
  useCodingAppSessionRedemptions: (): number => session.redemptions,
}));
vi.mock("@/lib/markdown-skills-api", () => ({
  fetchMarkdownSkills: vi.fn(),
  readMarkdownSkill: vi.fn(),
  deleteMarkdownSkill: vi.fn(),
  saveMarkdownSkill: vi.fn(),
  markdownSkillUpload: vi.fn(),
  exportMarkdownSkill: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const SKILL: MarkdownSkillMetadata = {
  id: "skill-library-synthetic",
  revision: 1,
  digest: "a".repeat(64),
  name: "Synthetic review",
  byteCount: 20,
  createdAt: 1,
};
const DOCUMENT: MarkdownSkillDocument = { ...SKILL, body: "# Synthetic review" };
const UPDATED = { ...SKILL, revision: 2 };
const onChange = vi.fn<() => Promise<void>>();

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  const handle = {
    resolve: (_value: T): void => undefined,
    reject: (_reason: unknown): void => undefined,
  };
  const promise = new Promise<T>((resolve, reject) => {
    handle.resolve = resolve;
    handle.reject = reject;
  });
  return { promise, ...handle };
}

beforeEach(() => {
  vi.resetAllMocks();
  session.redemptions = 0;
  vi.mocked(fetchMarkdownSkills).mockResolvedValue([SKILL]);
  onChange.mockResolvedValue(undefined);
});
afterEach(cleanup);

function useInspectOnLayout(inspect: boolean): ReturnType<typeof useMarkdownSkillLibrary> {
  const library = useMarkdownSkillLibrary(onChange);
  const started = useRef(false);
  useLayoutEffect(() => {
    if (!inspect || started.current) return;
    started.current = true;
    void library.inspect(SKILL);
  }, [inspect, library]);
  return library;
}

describe("private Markdown skill library session refresh", () => {
  it("retains a redemption whose refresh meets a request locked before the busy render", async () => {
    const inspection = deferred<MarkdownSkillDocument>();
    vi.mocked(readMarkdownSkill).mockReturnValue(inspection.promise);
    const view = renderHook(({ inspect }) => useInspectOnLayout(inspect), {
      initialProps: { inspect: false },
    });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
    vi.mocked(fetchMarkdownSkills).mockResolvedValue([UPDATED]);

    session.redemptions += 1;
    view.rerender({ inspect: true });
    expect(readMarkdownSkill).toHaveBeenCalledOnce();
    expect(fetchMarkdownSkills).toHaveBeenCalledOnce();
    await act(async () => inspection.resolve(DOCUMENT));

    await waitFor(() => expect(fetchMarkdownSkills).toHaveBeenCalledTimes(2));
    expect(view.result.current.skills).toEqual([UPDATED]);
    expect(view.result.current.preview).toBeUndefined();
    expect(readMarkdownSkill).toHaveBeenCalledOnce();
  });

  it("coalesces trailing reads while a mutation is locked without replaying the mutation", async () => {
    const deletion = deferred<void>();
    vi.mocked(deleteMarkdownSkill).mockReturnValue(deletion.promise);
    const { result } = renderHook(() => useMarkdownSkillLibrary(onChange));
    await waitFor(() => expect(result.current.busy).toBe(false));

    act(() => {
      void result.current.remove(SKILL);
      void result.current.refresh();
      void result.current.refresh();
    });
    expect(fetchMarkdownSkills).toHaveBeenCalledOnce();
    await act(async () => deletion.resolve(undefined));

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(deleteMarkdownSkill).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    // One mutation readback and one coalesced trailing read follow the initial listing.
    expect(fetchMarkdownSkills).toHaveBeenCalledTimes(3);
  });

  it("retains session preview invalidation when a manual refresh joins the queued read", async () => {
    const inspection = deferred<MarkdownSkillDocument>();
    vi.mocked(readMarkdownSkill).mockReturnValue(inspection.promise);
    const view = renderHook(({ inspect }) => useInspectOnLayout(inspect), {
      initialProps: { inspect: false },
    });
    await waitFor(() => expect(view.result.current.busy).toBe(false));

    session.redemptions += 1;
    view.rerender({ inspect: true });
    act(() => void view.result.current.refresh());
    await act(async () => inspection.resolve(DOCUMENT));

    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(fetchMarkdownSkills).toHaveBeenCalledTimes(2);
    expect(view.result.current.preview).toBeUndefined();
  });

  it("discards a trailing read after the library unmounts", async () => {
    const inspection = deferred<MarkdownSkillDocument>();
    vi.mocked(readMarkdownSkill).mockReturnValue(inspection.promise);
    const view = renderHook(() => useMarkdownSkillLibrary(onChange));
    await waitFor(() => expect(view.result.current.busy).toBe(false));
    act(() => {
      void view.result.current.inspect(SKILL);
      void view.result.current.refresh();
    });

    view.unmount();
    await act(async () => inspection.resolve(DOCUMENT));

    expect(fetchMarkdownSkills).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an unsuccessful trailing read unavailable and diagnosable", async () => {
    const inspection = deferred<MarkdownSkillDocument>();
    vi.mocked(readMarkdownSkill).mockReturnValue(inspection.promise);
    const { result } = renderHook(() => useMarkdownSkillLibrary(onChange));
    await waitFor(() => expect(result.current.busy).toBe(false));
    vi.mocked(fetchMarkdownSkills).mockRejectedValue(new TypeError("Synthetic listing failure"));
    act(() => {
      void result.current.inspect(SKILL);
      void result.current.refresh();
    });

    await act(async () => inspection.resolve(DOCUMENT));

    expect(result.current.available).toBe(false);
    expect(result.current.skills).toEqual([]);
    expect(result.current.preview).toBeUndefined();
    expect(result.current.error).toBe("request");
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
  });

  it("clears an intervening file error when the active request succeeds", async () => {
    const inspection = deferred<MarkdownSkillDocument>();
    vi.mocked(readMarkdownSkill).mockReturnValue(inspection.promise);
    const { result } = renderHook(() => useMarkdownSkillLibrary(onChange));
    await waitFor(() => expect(result.current.busy).toBe(false));

    act(() => {
      void result.current.inspect(SKILL);
      void result.current.upload(new File(["invalid extension"], "review.txt"));
    });
    expect(result.current.error).toBe("file");
    await act(async () => inspection.resolve(DOCUMENT));

    expect(result.current.error).toBeUndefined();
    expect(result.current.preview).toEqual(DOCUMENT);
  });

  it("keeps a failed request diagnosable while a queued successful read clears its error", async () => {
    const inspection = deferred<MarkdownSkillDocument>();
    vi.mocked(readMarkdownSkill).mockReturnValue(inspection.promise);
    const { result } = renderHook(() => useMarkdownSkillLibrary(onChange));
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => {
      void result.current.inspect(SKILL);
      void result.current.refresh();
    });

    await act(async () => inspection.reject(new TypeError("Synthetic request failure")));

    await waitFor(() => expect(fetchMarkdownSkills).toHaveBeenCalledTimes(2));
    expect(result.current.error).toBeUndefined();
    expect(result.current.busy).toBe(false);
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
    expect(vi.mocked(reportClientDiagnostic).mock.calls[0]?.[0]).toBe(
      "Private skill library request failed.",
    );
  });
});
