// The chat's Knowledge Pod catalog: unfiltered names and states, bounded self-healing while a bound
// pod is not ready, retryable failures, and body-free diagnostics (1.1.13 "Indexed in the panel,
// unavailable in the chat").

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { translate } from "@/lib/i18n";
import { recordResponseCorrelationId } from "@/lib/bff-correlation";
import {
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsulesResponse,
} from "@/lib/local-knowledge-api";
import type { ChatLocalKnowledgeScope } from "@/lib/types";
import {
  KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS,
  KNOWLEDGE_CATALOG_TTL_MS,
  boundScopeAvailability,
  boundScopesNeedRecovery,
  capsuleNameWithState,
  clearKnowledgeCatalogCacheForTests,
  loadKnowledgeCatalog,
  useKnowledgeCatalog,
  type KnowledgeCatalogSnapshot,
} from "./knowledge-catalog";

vi.mock("@/lib/local-knowledge-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-knowledge-api")>();
  return {
    ...actual,
    fetchCapsules: vi.fn(),
    fetchCapsuleSets: vi.fn(),
  };
});

const fetchCapsulesMock = vi.mocked(fetchCapsules);
const fetchCapsuleSetsMock = vi.mocked(fetchCapsuleSets);

interface CapturedDiagnostic {
  readonly message: string;
  readonly meta: ClientDiagnosticMeta | undefined;
}
let diagnostics: CapturedDiagnostic[] = [];

type WireCapsule = CapsulesResponse["capsules"][number];

function wireCapsule(
  id: string,
  displayName: string,
  lifecycleState: WireCapsule["lifecycleState"],
): WireCapsule {
  return {
    id: id as KnowledgeCapsuleId,
    displayName,
    lifecycleState,
    sourceCount: 1,
    updatedAt: 1,
  };
}

function capsuleScope(id: string): ChatLocalKnowledgeScope {
  return { kind: "capsule", capsuleId: id as KnowledgeCapsuleId, connectedAtMs: 1 };
}

const t = (
  key: Parameters<typeof translate>[1],
  values?: Parameters<typeof translate>[2],
): string => translate("en", key, values);

beforeEach(() => {
  clearKnowledgeCatalogCacheForTests();
  fetchCapsulesMock.mockReset();
  fetchCapsulesMock.mockResolvedValue({ capsules: [] });
  fetchCapsuleSetsMock.mockReset();
  fetchCapsuleSetsMock.mockResolvedValue({ capsuleSets: [] });
  diagnostics = [];
  setClientDiagnosticWriter((message, meta) => {
    diagnostics.push({ message, meta });
  });
});

afterEach(() => {
  resetClientDiagnosticWriter();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("loadKnowledgeCatalog", () => {
  it("keeps every lifecycle state so a bound pod keeps its name and state", async () => {
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        wireCapsule("cap-ready", "Ready pod", "ready"),
        wireCapsule("cap-indexing", "Indexing pod", "indexing"),
        wireCapsule("cap-error", "Failed pod", "error"),
      ],
    });

    const snapshot = await loadKnowledgeCatalog();

    expect(snapshot.capsules.map((capsule) => capsule.lifecycleState)).toEqual([
      "ready",
      "indexing",
      "error",
    ]);
    expect(snapshot.loadError).toBeNull();
  });

  it("shares one request between simultaneous callers", async () => {
    await Promise.all([loadKnowledgeCatalog(), loadKnowledgeCatalog(), loadKnowledgeCatalog(0)]);

    expect(fetchCapsulesMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a young snapshot and reads again when the caller demands a younger one", async () => {
    vi.useFakeTimers();
    await loadKnowledgeCatalog();
    vi.setSystemTime(Date.now() + 6_000);

    await loadKnowledgeCatalog();
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(1);

    await loadKnowledgeCatalog(5_000);
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + KNOWLEDGE_CATALOG_TTL_MS);
    await loadKnowledgeCatalog();
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(3);
  });

  it("reports a failed load body-free and returns it as an error, not an empty catalog", async () => {
    fetchCapsulesMock.mockRejectedValueOnce(new Error("secret /Users/alice/private/pod.db"));

    const snapshot = await loadKnowledgeCatalog();

    expect(snapshot.loadError).toBeInstanceOf(Error);
    expect(snapshot.capsules).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe("Keiko knowledge catalog load failed (list=capsules).");
    expect(diagnostics[0]?.meta?.errorKind).toBeDefined();
    expect(JSON.stringify(diagnostics)).not.toContain("alice");
  });

  it("reports both failed lists instead of stopping at the capsule failure", async () => {
    fetchCapsulesMock.mockRejectedValueOnce(new Error("capsules down"));
    fetchCapsuleSetsMock.mockRejectedValueOnce(new Error("sets down"));

    const snapshot = await loadKnowledgeCatalog();

    expect(snapshot.loadError).toBeInstanceOf(Error);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      "Keiko knowledge catalog load failed (list=capsules).",
      "Keiko knowledge catalog load failed (list=capsule-sets).",
    ]);
  });

  it("returns a load error for a capsule response without capsules instead of rejecting", async () => {
    const malformed = {} as CapsulesResponse;
    // What the BFF fetch scaffold records for a parsed 200 body (PR #3678 review).
    recordResponseCorrelationId(malformed, "catalog-original-request");
    fetchCapsulesMock.mockResolvedValueOnce(malformed);

    const snapshot = await loadKnowledgeCatalog();

    expect(snapshot.loadError).toBeInstanceOf(TypeError);
    expect(snapshot.capsules).toEqual([]);
    expect(snapshot.loadedAt).toBeGreaterThan(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe("Keiko knowledge catalog load failed (list=capsules).");
    expect(diagnostics[0]?.meta?.errorKind).toBe("validation-failed");
    expect(diagnostics[0]?.meta?.correlationId).toBe("catalog-original-request");
  });

  it("returns a load error when a list request throws before it returns a promise", async () => {
    fetchCapsulesMock.mockImplementationOnce(() => {
      throw new Error("request could not be built");
    });

    const snapshot = await loadKnowledgeCatalog();

    expect(snapshot.loadError).toBeInstanceOf(Error);
    expect(snapshot.capsules).toEqual([]);
    expect(snapshot.loadedAt).toBeGreaterThan(0);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      "Keiko knowledge catalog load failed (list=catalog).",
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("could not be built");
  });

  it("keeps the capsules when only the capsule-set response is malformed", async () => {
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [wireCapsule("cap-1", "Ready pod", "ready")],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({} as Awaited<ReturnType<typeof fetchCapsuleSets>>);

    const snapshot = await loadKnowledgeCatalog();

    expect(snapshot.capsules.map((capsule) => capsule.displayName)).toEqual(["Ready pod"]);
    expect(snapshot.capsuleSets).toEqual([]);
    expect(snapshot.loadError).toBeInstanceOf(TypeError);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      "Keiko knowledge catalog load failed (list=capsule-sets).",
    ]);
    expect(diagnostics[0]?.meta?.errorKind).toBe("validation-failed");
  });

  it("does not let a request that started before a clear repopulate the cache", async () => {
    let release: (value: CapsulesResponse) => void = () => undefined;
    fetchCapsulesMock.mockReturnValueOnce(
      new Promise<CapsulesResponse>((resolve) => {
        release = resolve;
      }),
    );
    const stale = loadKnowledgeCatalog();
    clearKnowledgeCatalogCacheForTests();
    release({ capsules: [wireCapsule("cap-old", "Old", "ready")] });
    await stale;

    fetchCapsulesMock.mockResolvedValueOnce({ capsules: [] });
    const fresh = await loadKnowledgeCatalog();

    expect(fresh.capsules).toEqual([]);
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
  });
});

describe("boundScopeAvailability", () => {
  const snapshot: KnowledgeCatalogSnapshot = {
    capsules: [
      wireCapsule("cap-ready", "Ready", "ready"),
      wireCapsule("cap-indexing", "Indexing", "indexing"),
    ] as readonly CapsuleListEntry[],
    capsuleSets: [],
    loadError: null,
    loadedAt: 1,
  };

  it("counts missing and not-ready bound sources", () => {
    expect(
      boundScopeAvailability(
        [capsuleScope("cap-ready"), capsuleScope("cap-indexing"), capsuleScope("cap-gone")],
        snapshot,
      ),
    ).toEqual({ bound: 3, missing: 1, notReady: 1 });
  });

  it("claims nothing before the first load or without a bound source", () => {
    expect(
      boundScopeAvailability([capsuleScope("cap-gone")], { ...snapshot, loadedAt: 0 }),
    ).toEqual({ bound: 0, missing: 0, notReady: 0 });
    expect(boundScopeAvailability([], snapshot)).toEqual({ bound: 0, missing: 0, notReady: 0 });
  });

  it("needs recovery for a not-ready or missing source or a failed load, never for a ready one", () => {
    const ready = boundScopeAvailability([capsuleScope("cap-ready")], snapshot);
    expect(boundScopesNeedRecovery(ready, snapshot)).toBe(false);
    expect(boundScopesNeedRecovery(ready, { ...snapshot, loadError: new Error("x") })).toBe(true);
    const indexing = boundScopeAvailability([capsuleScope("cap-indexing")], snapshot);
    expect(boundScopesNeedRecovery(indexing, snapshot)).toBe(true);
    const none = boundScopeAvailability([], snapshot);
    expect(boundScopesNeedRecovery(none, { ...snapshot, loadError: new Error("x") })).toBe(false);
  });
});

describe("capsuleNameWithState", () => {
  it("names a ready pod bare and any other pod with its real state", () => {
    const entry = (state: WireCapsule["lifecycleState"]): CapsuleListEntry =>
      wireCapsule("cap-1", "test", state) as CapsuleListEntry;

    expect(capsuleNameWithState(entry("ready"), t)).toBe("test");
    expect(capsuleNameWithState(entry("indexing"), t)).toBe("test (indexing)");
    expect(capsuleNameWithState(entry("error"), t)).toBe("test (failed)");
    expect(capsuleNameWithState(entry("stale"), t)).toBe("test (stale)");
    expect(capsuleNameWithState(entry("draft"), t)).toBe("test (not indexed)");
    expect(capsuleNameWithState(entry("deleting"), t)).toBe("test (deleting)");
    expect(capsuleNameWithState(entry("indexing"), t, (name) => `Knowledge Pod: ${name}`)).toBe(
      "Knowledge Pod: test (indexing)",
    );
  });
});

describe("useKnowledgeCatalog recovery", () => {
  it("re-reads a not-ready bound pod on a backoff and stops once it is ready", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock
      .mockResolvedValueOnce({ capsules: [wireCapsule("cap-1", "test", "indexing")] })
      .mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "ready")] });
    const scopes = [capsuleScope("cap-1")];
    const { result } = renderHook(() => useKnowledgeCatalog(scopes));
    await flush();
    expect(result.current.capsules[0]?.lifecycleState).toBe("indexing");
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(1);

    await advance(KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS[0] ?? 0);

    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
    expect(result.current.capsules[0]?.lifecycleState).toBe("ready");
    expect(result.current.loading).toBe(false);

    await advance(10 * 60_000 - (KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS[0] ?? 0));
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
  });

  it("is bounded: a pod that never becomes ready stops being re-read", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock.mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "error")] });
    const scopes = [capsuleScope("cap-1")];
    renderHook(() => useKnowledgeCatalog(scopes));
    await flush();

    await advance(60 * 60_000);

    expect(fetchCapsulesMock).toHaveBeenCalledTimes(
      1 + KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS.length,
    );
  });

  it("does not poll when every bound source is ready or nothing is bound", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock.mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "ready")] });
    const bound = [capsuleScope("cap-1")];
    renderHook(() => useKnowledgeCatalog(bound));
    const unbound: readonly ChatLocalKnowledgeScope[] = [];
    renderHook(() => useKnowledgeCatalog(unbound));
    await flush();

    await advance(10 * 60_000);

    expect(fetchCapsulesMock).toHaveBeenCalledTimes(1);
  });

  it("does not poll while the page is hidden and restarts when it becomes visible", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock.mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "indexing")] });
    const scopes = [capsuleScope("cap-1")];
    renderHook(() => useKnowledgeCatalog(scopes));
    await flush();
    setVisibility("hidden");
    try {
      await advance(10 * 60_000);
      expect(fetchCapsulesMock).toHaveBeenCalledTimes(1);

      setVisibility("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
    } finally {
      setVisibility("visible");
    }
  });

  it("re-reads on focus only once the snapshot is older than the TTL", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock.mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "ready")] });
    const scopes = [capsuleScope("cap-1")];
    renderHook(() => useKnowledgeCatalog(scopes));
    await flush();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(1);

    await advance(KNOWLEDGE_CATALOG_TTL_MS);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good snapshot when a background re-read fails", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock
      .mockResolvedValueOnce({ capsules: [wireCapsule("cap-1", "test", "indexing")] })
      .mockRejectedValue(new Error("gateway restarting"));
    const scopes = [capsuleScope("cap-1")];
    const { result } = renderHook(() => useKnowledgeCatalog(scopes));
    await flush();

    await advance(KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS[0] ?? 0);

    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
    expect(result.current.capsules[0]?.displayName).toBe("test");
    expect(result.current.loadError).toBeNull();
    expect(diagnostics.some((entry) => entry.message.includes("load failed"))).toBe(true);
  });

  it("surfaces a failed deliberate refresh as an error and clears it while retrying", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock
      .mockResolvedValueOnce({ capsules: [wireCapsule("cap-1", "test", "ready")] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ capsules: [wireCapsule("cap-1", "test", "ready")] });
    const unbound: readonly ChatLocalKnowledgeScope[] = [];
    const { result } = renderHook(() => useKnowledgeCatalog(unbound));
    await flush();

    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loadError).toBeInstanceOf(Error);
    expect(result.current.capsules).toEqual([]);

    act(() => {
      result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.loadError).toBeNull();
    await flush();
    expect(result.current.loadError).toBeNull();
    expect(result.current.capsules).toHaveLength(1);
  });

  it("reuses a young mount-time answer on the first picker open only", async () => {
    vi.useFakeTimers();
    const unbound: readonly ChatLocalKnowledgeScope[] = [];
    const { result } = renderHook(() => useKnowledgeCatalog(unbound));
    await flush();

    await act(async () => {
      result.current.refreshOnPickerOpen();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refreshOnPickerOpen();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes on the first picker open when the mount-time answer has aged", async () => {
    vi.useFakeTimers();
    const unbound: readonly ChatLocalKnowledgeScope[] = [];
    const { result } = renderHook(() => useKnowledgeCatalog(unbound));
    await flush();
    await advance(6_000);

    await act(async () => {
      result.current.refreshOnPickerOpen();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchCapsulesMock).toHaveBeenCalledTimes(2);
  });
});

describe("useKnowledgeCatalog malformed response", () => {
  it("settles loading with a retryable error when the catalog response is malformed", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock.mockResolvedValueOnce({} as CapsulesResponse);
    const unbound: readonly ChatLocalKnowledgeScope[] = [];

    const { result } = renderHook(() => useKnowledgeCatalog(unbound));
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBeInstanceOf(TypeError);

    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [wireCapsule("cap-1", "Recovered", "ready")],
    });
    act(() => {
      result.current.refresh();
    });
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBeNull();
    expect(result.current.capsules.map((capsule) => capsule.displayName)).toEqual(["Recovered"]);
  });
});

describe("useKnowledgeCatalog diagnostics", () => {
  it("reports the availability picture once, with counts only", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock.mockResolvedValue({
      capsules: [wireCapsule("cap-1", "Customer contracts", "indexing")],
    });
    const scopes = [capsuleScope("cap-1")];
    renderHook(() => useKnowledgeCatalog(scopes));
    await flush();

    // Recovery re-reads the same picture twice more: still one line.
    await advance(KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS[0] ?? 0);
    await advance(KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS[1] ?? 0);

    const lines = diagnostics.filter((entry) => entry.message.includes("offers no usable pod"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("Keiko knowledge catalog offers no usable pod.");
    // PR #3678 review: the counts travel as structured evidence — the server reduces the message
    // to a digest, so counts inside it never reached the Activity Log.
    expect(lines[0]?.meta?.knowledgeCatalog).toEqual({
      podCount: 1,
      readyPodCount: 0,
      setCount: 0,
      boundCount: 1,
      missingCount: 0,
      notReadyCount: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Customer");
    expect(JSON.stringify(diagnostics)).not.toContain("cap-1");
  });

  it("reports a recurrence of the same picture after a healthy interval", async () => {
    vi.useFakeTimers();
    fetchCapsulesMock.mockResolvedValue({
      capsules: [wireCapsule("cap-1", "test", "indexing")],
    });
    const scopes = [capsuleScope("cap-1")];
    const { result } = renderHook(() => useKnowledgeCatalog(scopes));
    await flush();
    const usableLines = (): number =>
      diagnostics.filter((entry) => entry.message.includes("offers no usable pod")).length;
    expect(usableLines()).toBe(1);

    fetchCapsulesMock.mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "ready")] });
    act(() => {
      result.current.refresh();
    });
    await flush();
    expect(result.current.capsules[0]?.lifecycleState).toBe("ready");
    expect(usableLines()).toBe(1);

    // The same counts as the first episode: a new episode, not a repeat of the old one.
    fetchCapsulesMock.mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "indexing")] });
    act(() => {
      result.current.refresh();
    });
    await flush();
    expect(result.current.capsules[0]?.lifecycleState).toBe("indexing");
    expect(usableLines()).toBe(2);
  });

  it("stays silent for a fresh installation with no pods and for ready pods", async () => {
    vi.useFakeTimers();
    const unbound: readonly ChatLocalKnowledgeScope[] = [];
    renderHook(() => useKnowledgeCatalog(unbound));
    await flush();
    expect(diagnostics).toEqual([]);

    clearKnowledgeCatalogCacheForTests();
    fetchCapsulesMock.mockResolvedValue({ capsules: [wireCapsule("cap-1", "test", "ready")] });
    const bound = [capsuleScope("cap-1")];
    renderHook(() => useKnowledgeCatalog(bound));
    await flush();
    expect(diagnostics).toEqual([]);
  });
});
