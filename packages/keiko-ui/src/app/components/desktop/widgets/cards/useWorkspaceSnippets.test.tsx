import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  type EditorM7WorkspaceSnippetInput,
  type EditorM7WorkspaceSnippetSnapshot,
} from "@oscharko-dev/keiko-contracts";

import { resetSharedEventSourcesForTests } from "./sharedEventSource";
import { useWorkspaceSnippets } from "./useWorkspaceSnippets";

const api = vi.hoisted(() => ({
  currentSnapshot: undefined as EditorM7WorkspaceSnippetSnapshot | undefined,
  fetchWorkspaceSnippets: vi.fn(),
  mutateWorkspaceSnippets: vi.fn(),
}));

vi.mock("../../../../../lib/api", () => {
  return {
    fetchWorkspaceSnippets: api.fetchWorkspaceSnippets,
    mutateWorkspaceSnippets: api.mutateWorkspaceSnippets,
  };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    const event = new MessageEvent<string>(type, { data: "{}" });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function snippet(id = "log-value"): EditorM7WorkspaceSnippetInput {
  return {
    id,
    name: "Log value",
    prefixes: ["logv"],
    description: "Log a value",
    languages: ["typescript"],
    include: ["src/**/*.ts"],
    body: ["console.log(${1:value});", "$0"],
  };
}

function snapshot(revision: number): EditorM7WorkspaceSnippetSnapshot {
  const workspaceFingerprint = "abcdef1234567890";
  return {
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    storeState: revision === 0 ? "absent" : "ready",
    revision,
    etag: `"edsn-${revision.toString()}-test"`,
    workspaceFingerprint,
    snippets:
      revision === 0
        ? []
        : [{ ...snippet(), revision, provenance: { source: "workspace", workspaceFingerprint } }],
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("crypto", {});
  api.currentSnapshot = snapshot(0);
  api.fetchWorkspaceSnippets.mockImplementation(() => Promise.resolve(api.currentSnapshot));
  api.mutateWorkspaceSnippets.mockReset();
});

afterEach(() => {
  resetSharedEventSourcesForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useWorkspaceSnippets", () => {
  it("shares one snippets stream and refreshes mounted views after server events", async () => {
    const first = renderHook(() => useWorkspaceSnippets("/repo"));
    const second = renderHook(() => useWorkspaceSnippets("/repo"));

    await waitFor(() => {
      expect(first.result.current.snapshot?.revision).toBe(0);
      expect(second.result.current.snapshot?.revision).toBe(0);
    });
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      "/api/editor/snippets/events?root=%2Frepo",
    ]);
    expect(api.fetchWorkspaceSnippets).toHaveBeenCalledTimes(2);

    api.currentSnapshot = snapshot(1);
    act(() => {
      FakeEventSource.instances[0]?.emit("editor-snippets:changed");
    });

    await waitFor(() => {
      expect(first.result.current.snapshot?.revision).toBe(1);
      expect(second.result.current.snapshot?.revision).toBe(1);
    });
    expect(api.fetchWorkspaceSnippets).toHaveBeenCalledTimes(4);

    first.unmount();
    second.unmount();
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("sends guarded replace and reset mutations with snapshot etags", async () => {
    api.currentSnapshot = snapshot(1);
    api.mutateWorkspaceSnippets.mockResolvedValue({
      kind: "ok",
      changed: true,
      revision: 2,
      etag: '"edsn-2-test"',
      snapshot: snapshot(2),
    });
    const { result } = renderHook(() => useWorkspaceSnippets("/repo"));

    await waitFor(() => {
      expect(result.current.snapshot?.revision).toBe(1);
    });
    await act(async () => {
      await result.current.replace([snippet("next")]);
    });
    await act(async () => {
      await result.current.reset();
    });

    expect(api.mutateWorkspaceSnippets).toHaveBeenNthCalledWith(
      1,
      {
        schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
        root: "/repo",
        expectedRevision: 1,
        action: "replace",
        snippets: [snippet("next")],
      },
      '"edsn-1-test"',
      expect.stringMatching(/^workspace-snippets-ui-/u),
      expect.any(AbortSignal),
    );
    expect(api.mutateWorkspaceSnippets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "reset", expectedRevision: 2 }),
      '"edsn-2-test"',
      expect.stringMatching(/^workspace-snippets-ui-/u),
      expect.any(AbortSignal),
    );
  });

  it("keeps disabled roots local and surfaces load and mutation failures", async () => {
    const disabled = renderHook(() => useWorkspaceSnippets(undefined));

    await act(async () => {
      await disabled.result.current.refresh();
      await disabled.result.current.replace([snippet()]);
      await disabled.result.current.reset();
    });
    expect(api.fetchWorkspaceSnippets).not.toHaveBeenCalled();
    expect(api.mutateWorkspaceSnippets).not.toHaveBeenCalled();

    api.fetchWorkspaceSnippets.mockRejectedValueOnce(new Error("offline"));
    const failedLoad = renderHook(() => useWorkspaceSnippets("/repo"));
    await waitFor(() => {
      expect(failedLoad.result.current.issue).toBe("load");
    });

    api.fetchWorkspaceSnippets.mockResolvedValue(snapshot(1));
    api.mutateWorkspaceSnippets.mockRejectedValueOnce(new Error("write failed"));
    const failedMutation = renderHook(() => useWorkspaceSnippets("/repo"));
    await waitFor(() => {
      expect(failedMutation.result.current.snapshot?.revision).toBe(1);
    });
    await act(async () => {
      await failedMutation.result.current.replace([snippet("next")]);
    });

    expect(failedMutation.result.current.issue).toBe("mutation");
  });

  it("surfaces conflict/invalid/unavailable mutation outcomes and refreshes on conflict", async () => {
    api.fetchWorkspaceSnippets.mockResolvedValue(snapshot(1));
    api.mutateWorkspaceSnippets.mockResolvedValueOnce({
      kind: "conflict",
      code: "STALE_REVISION",
      etag: '"edsn-1-test"',
    });
    const conflict = renderHook(() => useWorkspaceSnippets("/repo"));
    await waitFor(() => {
      expect(conflict.result.current.snapshot?.revision).toBe(1);
    });
    const fetchCallsBefore = api.fetchWorkspaceSnippets.mock.calls.length;
    let succeeded = true;
    await act(async () => {
      succeeded = await conflict.result.current.replace([snippet("next")]);
    });
    expect(succeeded).toBe(false);
    expect(conflict.result.current.issue).toBe("conflict");
    await waitFor(() => {
      expect(api.fetchWorkspaceSnippets.mock.calls.length).toBeGreaterThan(fetchCallsBefore);
    });

    api.mutateWorkspaceSnippets.mockResolvedValueOnce({
      kind: "invalid",
      code: "UNSAFE_SNIPPET",
    });
    await act(async () => {
      succeeded = await conflict.result.current.replace([snippet("bad")]);
    });
    expect(succeeded).toBe(false);
    expect(conflict.result.current.issue).toBe("invalid");

    api.mutateWorkspaceSnippets.mockResolvedValueOnce({
      kind: "unavailable",
      code: "STATE_UNAVAILABLE",
    });
    await act(async () => {
      succeeded = await conflict.result.current.replace([snippet("bad")]);
    });
    expect(succeeded).toBe(false);
    expect(conflict.result.current.issue).toBe("unavailable");
  });

  it("resolves replace/reset to true only on a confirmed successful mutation", async () => {
    api.currentSnapshot = snapshot(1);
    api.mutateWorkspaceSnippets.mockResolvedValueOnce({
      kind: "ok",
      changed: true,
      revision: 2,
      etag: '"edsn-2-test"',
      snapshot: snapshot(2),
    });
    const { result } = renderHook(() => useWorkspaceSnippets("/repo"));
    await waitFor(() => {
      expect(result.current.snapshot?.revision).toBe(1);
    });
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.replace([snippet("next")]);
    });
    expect(succeeded).toBe(true);
  });
});
