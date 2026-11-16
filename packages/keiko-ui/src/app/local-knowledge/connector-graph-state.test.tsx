import { act, cleanup, renderHook, type RenderHookResult } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { fetchCapsules, fetchCapsuleSets } from "@/lib/local-knowledge-api";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticWriter,
} from "@/lib/client-diagnostics";
import type {
  CapsuleListEntry,
  ConnectorGraphProps,
  ConnectorGraphState,
} from "./connector-graph-types";
import { useConnectorGraph } from "./connector-graph-state";

vi.mock("next/navigation", () => ({
  useRouter: (): { readonly push: (href: string) => void } => ({ push: vi.fn() }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetClientDiagnosticWriter();
});

function pod(id: string, lifecycleState: CapsuleListEntry["lifecycleState"]): CapsuleListEntry {
  return {
    id: id as KnowledgeCapsuleId,
    displayName: "Synthetic Pod",
    lifecycleState,
    sourceCount: 1,
    updatedAt: 1,
  };
}
interface GraphFixture {
  readonly capsules: Mock<typeof fetchCapsules>;
  readonly sets: Mock<typeof fetchCapsuleSets>;
  readonly hook: RenderHookResult<ConnectorGraphState, unknown>;
}
function mountGraph(
  capsules: readonly CapsuleListEntry[],
  actions: Pick<ConnectorGraphProps, "startIndexingImpl"> = {},
): GraphFixture {
  const fetchCapsulesImpl = vi.fn<typeof fetchCapsules>().mockResolvedValue({ capsules });
  const fetchCapsuleSetsImpl = vi
    .fn<typeof fetchCapsuleSets>()
    .mockResolvedValue({ capsuleSets: [] });
  const hook = renderHook(() =>
    useConnectorGraph({ fetchCapsulesImpl, fetchCapsuleSetsImpl, ...actions }),
  );
  return { capsules: fetchCapsulesImpl, sets: fetchCapsuleSetsImpl, hook };
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
async function advance(milliseconds = 2_000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
function visibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

it.each(["draft", "ready", "stale", "error"] as const)(
  "does not poll a catalog containing only %s Pods",
  async (state) => {
    const f = mountGraph([pod("synthetic", state)]);
    await flush();
    await advance(10_000);
    expect(f.capsules).toHaveBeenCalledOnce();
    expect(f.sets).toHaveBeenCalledOnce();
  },
);

it("keeps refreshing while any Pod indexes and stops when the final Pod settles", async () => {
  const f = mountGraph([pod("first", "indexing"), pod("second", "indexing")]);
  await flush();
  f.capsules.mockResolvedValue({ capsules: [pod("first", "ready"), pod("second", "indexing")] });
  await advance();
  expect(f.capsules).toHaveBeenCalledTimes(2);
  f.capsules.mockResolvedValue({ capsules: [pod("first", "ready"), pod("second", "error")] });
  await advance();
  expect(f.hook.result.current.capsules.map((capsule) => capsule.lifecycleState)).toEqual([
    "ready",
    "error",
  ]);
  await advance(10_000);
  act(() => visibility("visible"));
  expect(f.capsules).toHaveBeenCalledTimes(3);
  expect(f.sets).toHaveBeenCalledTimes(3);
  expect(f.capsules).toHaveBeenLastCalledWith({ includeKnowledgePods: true });
  expect(f.sets).toHaveBeenLastCalledWith({ includeKnowledgePods: true });
});

it("pauses indexing refresh while hidden and catches up immediately when visible", async () => {
  const f = mountGraph([pod("synthetic", "indexing")]);
  await flush();
  await advance();
  act(() => visibility("hidden"));
  await advance(10_000);
  expect(f.capsules).toHaveBeenCalledTimes(2);
  f.capsules.mockResolvedValue({ capsules: [pod("synthetic", "ready")] });
  await act(async () => {
    visibility("visible");
    await Promise.resolve();
  });
  expect(f.capsules).toHaveBeenCalledTimes(3);
  expect(f.hook.result.current.capsules[0]?.lifecycleState).toBe("ready");
  await advance(10_000);
  expect(f.capsules).toHaveBeenCalledTimes(3);
});

it("does not arm indexing refresh in an initially hidden document", async () => {
  act(() => visibility("hidden"));
  const f = mountGraph([pod("synthetic", "indexing")]);
  await flush();
  await advance(10_000);
  expect(f.capsules).toHaveBeenCalledOnce();
  await act(async () => {
    visibility("visible");
    await Promise.resolve();
  });
  expect(f.capsules).toHaveBeenCalledTimes(2);
});

it("does not overlap a held refresh with another tick or visibility catch-up", async () => {
  const f = mountGraph([pod("synthetic", "indexing")]);
  await flush();
  let settle: ((response: Awaited<ReturnType<typeof fetchCapsules>>) => void) | undefined;
  const held = new Promise<Awaited<ReturnType<typeof fetchCapsules>>>((resolve) => {
    settle = resolve;
  });
  f.capsules.mockReturnValue(held);
  await advance();
  expect(f.hook.result.current.loadStatus).toBe("ready");
  await advance(10_000);
  act(() => visibility("visible"));
  expect(f.capsules).toHaveBeenCalledTimes(2);
  if (settle === undefined) throw new TypeError("Missing held catalog resolver");
  const resolve = settle;
  await act(async () => {
    resolve({ capsules: [pod("synthetic", "ready")] });
    await held;
  });
  await advance(10_000);
  expect(f.capsules).toHaveBeenCalledTimes(2);
});

it("removes the poll and visibility listener when the overview unmounts", async () => {
  const f = mountGraph([pod("synthetic", "indexing")]);
  await flush();
  f.hook.unmount();
  await advance(10_000);
  act(() => visibility("visible"));
  expect(f.capsules).toHaveBeenCalledOnce();
});

it("starts refreshing after an accepted indexing action reloads an indexing Pod", async () => {
  const id = "synthetic" as KnowledgeCapsuleId;
  const startIndexingImpl = vi
    .fn<NonNullable<ConnectorGraphProps["startIndexingImpl"]>>()
    .mockResolvedValue({ ok: true, capsuleId: id });
  const f = mountGraph([pod(id, "draft")], { startIndexingImpl });
  await flush();
  f.capsules.mockResolvedValue({ capsules: [pod(id, "indexing")] });
  await act(async () => {
    f.hook.result.current.handleStartIndexing(id);
    await Promise.resolve();
  });
  expect(startIndexingImpl).toHaveBeenCalledWith(id);
  f.capsules.mockResolvedValue({ capsules: [pod(id, "ready")] });
  await advance();
  expect(f.hook.result.current.capsules[0]?.lifecycleState).toBe("ready");
  expect(f.capsules).toHaveBeenCalledTimes(3);
});

it("reports a failed refresh without its body and recovers on the next visible tick", async () => {
  const writer = vi.fn<ClientDiagnosticWriter>();
  setClientDiagnosticWriter(writer);
  const f = mountGraph([pod("synthetic", "indexing")]);
  await flush();
  const privateMessage = "Private document /private/operator@example.invalid";
  const correlationId = "a53ebd46-3100-4d33-9e1d-77282d977c30";
  f.capsules.mockRejectedValueOnce(Object.assign(new TypeError(privateMessage), { correlationId }));
  await advance();
  expect(f.hook.result.current.loadStatus).toBe("error");
  expect(f.hook.result.current.capsules[0]?.lifecycleState).toBe("indexing");
  expect(writer).toHaveBeenCalledWith(
    "Knowledge Pod catalog load failed.",
    expect.objectContaining({ correlationId }),
  );
  expect(JSON.stringify(writer.mock.calls)).not.toContain(privateMessage);
  f.capsules.mockResolvedValue({ capsules: [pod("synthetic", "ready")] });
  await advance();
  expect(f.hook.result.current.loadStatus).toBe("ready");
  expect(f.hook.result.current.loadError).toBeNull();
  await advance(10_000);
  expect(f.capsules).toHaveBeenCalledTimes(3);
});
