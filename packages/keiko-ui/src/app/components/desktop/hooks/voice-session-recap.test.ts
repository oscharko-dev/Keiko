// Issue #504 (ADR-0067) — the Voice session recap binding + React hook. Proves the ACs Artifact C owns:
// dormancy for `none` / `speech-output` and for an empty committed projection (AC1), committed-only
// input (AC2), and delegation of every review action to the EXISTING memory-api endpoints without a new
// mutation surface (AC3 / AC5). It also pins the content-free observer (only counts / action enums) and
// that the committed transcript text leaves only once, in the recap-build request body.

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { MemoryRecord, VoiceTranscriptSegment } from "@oscharko-dev/keiko-contracts";
import type { UserId } from "@oscharko-dev/keiko-contracts/memory";
import type {
  EditMemoryInput,
  MemoryActionResponse,
  MemoryForgetResponse,
  MemoryReviewQueueResponse,
} from "@/lib/memory-api";
import {
  type VoiceRecapBuildRequest,
  type VoiceRecapBuildResponse,
  type VoiceSessionRecapIo,
  type VoiceSessionRecapObserver,
  createVoiceSessionRecapBinding,
  useVoiceSessionRecap,
} from "./voice-session-recap";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function segment(partial: Partial<VoiceTranscriptSegment>): VoiceTranscriptSegment {
  return {
    id: partial.id ?? "seg-0",
    seq: partial.seq ?? 0,
    state: partial.state ?? "committed",
    text: partial.text ?? "",
    source: partial.source ?? "realtime",
    revision: partial.revision ?? 0,
    replayClass: partial.replayClass ?? "replayable",
    redactionClass: partial.redactionClass ?? "reviewable-text",
    supersedesId: partial.supersedesId,
    providerErrorKind: partial.providerErrorKind,
  };
}

function record(id: string, body: string): MemoryRecord {
  return {
    id: id as MemoryRecord["id"],
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "semantic-fact",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 0,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 0 },
    status: "proposed",
    pinned: false,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

interface SpyIo extends VoiceSessionRecapIo {
  readonly buildRecap: Mock<(request: VoiceRecapBuildRequest) => Promise<VoiceRecapBuildResponse>>;
  readonly fetchReviewQueue: Mock<() => Promise<MemoryReviewQueueResponse>>;
  readonly accept: Mock<(id: string) => Promise<MemoryActionResponse>>;
  readonly edit: Mock<(id: string, input: EditMemoryInput) => Promise<MemoryActionResponse>>;
  readonly reject: Mock<(id: string, reason?: string) => Promise<MemoryActionResponse>>;
  readonly forget: Mock<(id: string, reason?: string) => Promise<MemoryForgetResponse>>;
}

function spyIo(queue: readonly MemoryRecord[] = []): SpyIo {
  const action: MemoryActionResponse = { memory: record("m-x", "x") };
  const forgetResponse: MemoryForgetResponse = {
    forgotten: true,
    memoryIds: ["m-x"],
    count: 1,
  };
  return {
    buildRecap: vi.fn(async () => ({ candidatesProposed: 2, candidatesRejected: 1 })),
    fetchReviewQueue: vi.fn(async () => ({ memories: queue, total: queue.length })),
    accept: vi.fn(async () => action),
    edit: vi.fn(async () => action),
    reject: vi.fn(async () => action),
    forget: vi.fn(async () => forgetResponse),
  };
}

// ─── Binding: dormancy (AC1) ─────────────────────────────────────────────────────

describe("createVoiceSessionRecapBinding — dormancy (AC1)", () => {
  it.each(["none", "speech-output"] as const)(
    "is dormant for the %s profile: no build, no observer, empty queue",
    async (profile) => {
      const io = spyIo();
      const onTriggered = vi.fn();
      const binding = createVoiceSessionRecapBinding({
        profile,
        io,
        observer: { onTriggered },
      });
      binding.setSegments([segment({ text: "I prefer dark mode", state: "committed" })]);

      expect(binding.canRecap()).toBe(false);
      expect(binding.canTrigger()).toBe(false);
      expect(await binding.trigger()).toBeUndefined();
      expect(io.buildRecap).not.toHaveBeenCalled();
      expect(onTriggered).not.toHaveBeenCalled();

      const queue = await binding.loadReviewQueue();
      expect(queue.memories).toHaveLength(0);
      expect(io.fetchReviewQueue).not.toHaveBeenCalled();
    },
  );

  it("is inert when active but no transcript is committed (empty projection)", async () => {
    const io = spyIo();
    const binding = createVoiceSessionRecapBinding({ profile: "speech-to-text", io });
    // Only an in-flight partial — excluded from the committed projection (AC2).
    binding.setSegments([segment({ text: "in flight", state: "partial" })]);

    expect(binding.canRecap()).toBe(true);
    expect(binding.canTrigger()).toBe(false);
    expect(await binding.trigger()).toBeUndefined();
    expect(io.buildRecap).not.toHaveBeenCalled();
    expect(binding.snapshot().committedSegmentCount).toBe(0);
  });

  it("treats whitespace-only committed text as nothing to recap", async () => {
    const io = spyIo();
    const binding = createVoiceSessionRecapBinding({ profile: "full-realtime", io });
    binding.setSegments([segment({ text: "   ", state: "committed" })]);
    expect(binding.canTrigger()).toBe(false);
    expect(await binding.trigger()).toBeUndefined();
    expect(io.buildRecap).not.toHaveBeenCalled();
  });
});

// ─── Binding: committed-only input (AC2) + trigger ───────────────────────────────

describe("createVoiceSessionRecapBinding — trigger (AC2)", () => {
  it("submits ONLY the committed projection text and reports content-free counts", async () => {
    const io = spyIo();
    const onTriggered = vi.fn();
    const binding = createVoiceSessionRecapBinding({
      profile: "full-realtime",
      io,
      observer: { onTriggered },
    });
    binding.setSegments([
      segment({ id: "a", seq: 1, text: "I live in Berlin", state: "committed" }),
      segment({ id: "b", seq: 2, text: "partial noise", state: "partial" }),
      segment({ id: "c", seq: 3, text: "discarded", state: "discarded" }),
    ]);

    const result = await binding.trigger();
    expect(result).toEqual({ candidatesProposed: 2, candidatesRejected: 1 });
    expect(io.buildRecap).toHaveBeenCalledTimes(1);
    const request = io.buildRecap.mock.calls[0]?.[0];
    // Only the committed segment's text is submitted — partial / discarded excluded by construction.
    expect(request?.committedSpans).toEqual(["I live in Berlin"]);
    // The full transcript summary is sent (server overrides segmentCount/committedChars itself, but the
    // descriptive counts ride along). The committed projection holds exactly one committed segment.
    expect(request?.transcript.committedCount).toBe(1);
    expect(onTriggered).toHaveBeenCalledWith({ candidatesProposed: 2, candidatesRejected: 1 });
    expect(binding.snapshot().lastResult).toEqual(result);
  });

  it("excludes superseded (corrected) text from the recap input", async () => {
    const io = spyIo();
    const binding = createVoiceSessionRecapBinding({ profile: "speech-to-text", io });
    binding.setSegments([
      segment({ id: "old", seq: 1, text: "old wrong text", state: "committed" }),
      segment({
        id: "new",
        seq: 2,
        text: "corrected text",
        state: "corrected",
        supersedesId: "old",
      }),
    ]);
    await binding.trigger();
    const request = io.buildRecap.mock.calls[0]?.[0];
    expect(request?.committedSpans).toEqual(["corrected text"]);
    // The full summary records the correction (the committed projection alone could not).
    expect(request?.transcript.correctedCount).toBe(1);
  });

  it("sends each committed utterance as its own span (per-utterance extraction)", async () => {
    const io = spyIo();
    const binding = createVoiceSessionRecapBinding({ profile: "full-realtime", io });
    binding.setSegments([
      segment({ id: "a", seq: 1, text: "I prefer dark mode", state: "committed" }),
      segment({ id: "b", seq: 2, text: "I live in Berlin", state: "committed" }),
    ]);
    await binding.trigger();
    const request = io.buildRecap.mock.calls[0]?.[0];
    expect(request?.committedSpans).toEqual(["I prefer dark mode", "I live in Berlin"]);
  });
});

// ─── Binding: review actions delegate to memory-api (AC3 / AC5) ──────────────────

describe("createVoiceSessionRecapBinding — review actions delegate (AC3)", () => {
  it("approve → accept; edit → edit; reject → reject; forget → forget", async () => {
    const io = spyIo();
    const onReviewAction = vi.fn();
    const observer: VoiceSessionRecapObserver = { onReviewAction };
    const binding = createVoiceSessionRecapBinding({ profile: "speech-to-text", io, observer });

    await binding.approve("m-1");
    expect(io.accept).toHaveBeenCalledWith("m-1");
    expect(onReviewAction).toHaveBeenCalledWith({ action: "approve" });

    await binding.edit("m-2", { body: "edited" });
    expect(io.edit).toHaveBeenCalledWith("m-2", { body: "edited" });
    expect(onReviewAction).toHaveBeenCalledWith({ action: "edit" });

    await binding.reject("m-3", "not useful");
    expect(io.reject).toHaveBeenCalledWith("m-3", "not useful");
    expect(onReviewAction).toHaveBeenCalledWith({ action: "reject" });

    await binding.forget("m-4");
    expect(io.forget).toHaveBeenCalledWith("m-4", undefined);
    expect(onReviewAction).toHaveBeenCalledWith({ action: "forget" });
  });

  it("loadReviewQueue returns the existing review queue when active", async () => {
    const io = spyIo([record("m-1", "fact one")]);
    const binding = createVoiceSessionRecapBinding({ profile: "full-realtime", io });
    const queue = await binding.loadReviewQueue();
    expect(queue.memories).toHaveLength(1);
    expect(io.fetchReviewQueue).toHaveBeenCalledTimes(1);
  });

  it("reset clears the committed projection and last result", async () => {
    const io = spyIo();
    const binding = createVoiceSessionRecapBinding({ profile: "speech-to-text", io });
    binding.setSegments([segment({ text: "remember this", state: "committed" })]);
    await binding.trigger();
    expect(binding.snapshot().lastResult).toBeDefined();
    binding.reset();
    expect(binding.snapshot().lastResult).toBeUndefined();
    expect(binding.snapshot().committedSegmentCount).toBe(0);
    expect(binding.canTrigger()).toBe(false);
  });
});

// ─── Default IO wiring (real fetch + memory-api) ─────────────────────────────────

describe("createVoiceSessionRecapBinding — default IO", () => {
  it("POSTs the committed spans and parses the REAL flat server response shape", async () => {
    // Regression guard: the server replies with FLAT counts + proposalIds (ADR-0067 D5). If the counts
    // were ever re-nested under `summary`, `candidatesProposed`/`candidatesRejected` would read as
    // undefined here and the observer assertion below would fail.
    const onTriggered = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ candidatesProposed: 3, candidatesRejected: 0, proposalIds: ["m-1"] }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const binding = createVoiceSessionRecapBinding({
      profile: "full-realtime",
      observer: { onTriggered },
    });
    binding.setSegments([segment({ text: "default io fact", state: "committed" })]);
    const result = await binding.trigger();

    expect(result).toEqual({ candidatesProposed: 3, candidatesRejected: 0, proposalIds: ["m-1"] });
    // The observer must receive DEFINED numeric counts — proof the flat shape parsed correctly.
    const event = onTriggered.mock.calls[0]?.[0] as
      | { candidatesProposed: number; candidatesRejected: number }
      | undefined;
    expect(typeof event?.candidatesProposed).toBe("number");
    expect(typeof event?.candidatesRejected).toBe("number");
    expect(event?.candidatesProposed).toBe(3);
    expect(event?.candidatesRejected).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/recap/build",
      expect.objectContaining({ method: "POST" }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(String(requestInit.body)) as VoiceRecapBuildRequest;
    expect(sent.committedSpans).toEqual(["default io fact"]);
    expect(sent.transcript.committedCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it("rejects when the recap route responds with a non-ok status", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const binding = createVoiceSessionRecapBinding({ profile: "speech-to-text" });
    binding.setSegments([segment({ text: "fact", state: "committed" })]);
    const error = await binding.trigger().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/HTTP 403/u);
    vi.unstubAllGlobals();
  });

  it("defaults loadReviewQueue / review actions to the memory-api endpoints via fetch", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/review-queue")) {
        return { ok: true, status: 200, json: async () => ({ memories: [], total: 0 }) };
      }
      return { ok: true, status: 200, json: async () => ({ memory: record("m-1", "x") }) };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const binding = createVoiceSessionRecapBinding({ profile: "speech-to-text" });
    await binding.loadReviewQueue();
    await binding.approve("m-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/review-queue",
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/proposals/m-1/accept",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });
});

// ─── React hook ──────────────────────────────────────────────────────────────────

describe("useVoiceSessionRecap", () => {
  it("exposes the committed count and stays inert when nothing is committed", () => {
    const io = spyIo();
    const { result } = renderHook(() =>
      useVoiceSessionRecap({ profile: "speech-to-text", io, segments: [] }),
    );
    expect(result.current.active).toBe(true);
    expect(result.current.committedSegmentCount).toBe(0);
    act(() => {
      result.current.trigger();
    });
    expect(io.buildRecap).not.toHaveBeenCalled();
  });

  it("triggers a recap then loads the review queue", async () => {
    const io = spyIo([record("m-1", "from the session")]);
    const segments = [segment({ text: "keep this fact", state: "committed" })];
    const { result } = renderHook(() =>
      useVoiceSessionRecap({ profile: "full-realtime", io, segments }),
    );
    expect(result.current.committedSegmentCount).toBe(1);
    act(() => {
      result.current.trigger();
    });
    await waitFor(() => {
      expect(result.current.candidates).toHaveLength(1);
    });
    expect(io.buildRecap).toHaveBeenCalledTimes(1);
    expect(io.fetchReviewQueue).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  it("approve / edit / reject / forget delegate and refresh the queue", async () => {
    const io = spyIo([record("m-1", "fact")]);
    const segments = [segment({ text: "fact body", state: "committed" })];
    const { result } = renderHook(() =>
      useVoiceSessionRecap({ profile: "speech-to-text", io, segments }),
    );

    act(() => {
      result.current.approve("m-1");
    });
    await waitFor(() => {
      expect(io.accept).toHaveBeenCalledWith("m-1");
    });

    act(() => {
      result.current.edit("m-1", "new body");
    });
    await waitFor(() => {
      expect(io.edit).toHaveBeenCalledWith("m-1", { body: "new body" });
    });

    act(() => {
      result.current.reject("m-1");
    });
    await waitFor(() => {
      expect(io.reject).toHaveBeenCalledWith("m-1", undefined);
    });

    act(() => {
      result.current.forget("m-1");
    });
    await waitFor(() => {
      expect(io.forget).toHaveBeenCalledWith("m-1", undefined);
    });
  });
});
