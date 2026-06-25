// Issue #504, Epic #491 (ADR-0067) — the Voice session recap binding (Artifact C). It is the
// deterministic, capability-gated seam that turns a voice session's COMMITTED transcript into governed
// memory candidates and exposes the review actions over them — WITHOUT inventing any new governance,
// memory status, or mutation endpoint. Candidate creation is delegated to the additive server route
// `POST /api/voice/recap/build`, which calls the EXISTING `extractCandidatesFromUserText` capture path
// (with its sensitive-material redaction, scope inference, and `buildProposal`). Review actions delegate
// to the EXISTING `memory-api.ts` endpoints (accept / reject / edit / forget).
//
// Three guarantees are load-bearing.
// (1) DORMANCY (AC1): `voiceRecapAllowed(profile)` gates the whole binding; for `none` and
//     `speech-output` `trigger` is a content-free no-op — no network call, no observer fire, no state
//     mutation — and `canTrigger()` is false. The recap is also inert when there is no committed
//     transcript (the committed projection is empty), so a session with nothing committed cannot
//     produce a side effect.
// (2) COMMITTED-ONLY INPUT (AC2): the recap input is derived EXCLUSIVELY from
//     `selectCommittedVoiceTranscript(segments).text`. Partial, stable, discarded, redacted, corrected
//     (superseded), and provider-error segments are excluded by construction in the contract projection,
//     so an in-flight or unreviewed transcript can never reach the extraction call. The committed text
//     is held only in this closure and transmitted to the server once for extraction; it is never cached
//     after the response and never leaves through the content-free observer (only counts do).
// (3) NO NEW SURFACE (AC3 / AC5): the binding adds no governance and no mutation endpoint. Candidate
//     creation rides the additive recap route; review rides the existing review-queue endpoints. The
//     per-turn capture path and the text-chat path are untouched.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CommittedVoiceTranscriptProjection,
  type MemoryId,
  type MemoryRecord,
  type VoiceProfile,
  type VoiceTranscriptSegment,
  selectCommittedVoiceTranscript,
  voiceRecapAllowed,
} from "@oscharko-dev/keiko-contracts";
import {
  type EditMemoryInput,
  type MemoryActionResponse,
  type MemoryForgetResponse,
  type MemoryReviewQueueResponse,
  acceptMemoryProposal,
  editMemory,
  fetchMemoryReviewQueue,
  forgetMemory,
  rejectMemoryProposal,
} from "@/lib/memory-api";

// ─── Wire shapes for the additive recap route ────────────────────────────────────
// The client sends only the committed text and its content-free counts; the server replies with two
// counts and never echoes any transcript text (ADR-0067 D5). This request body is the ONLY place the
// committed text leaves the client, and only to drive the existing extraction path on the BFF.
export interface VoiceRecapBuildRequest {
  readonly committedText: string;
  readonly segmentCount: number;
  readonly committedChars: number;
}

export interface VoiceRecapBuildResponse {
  readonly candidatesProposed: number;
  readonly candidatesRejected: number;
}

// ─── Injectable IO seams (mirrors the existing memory-api fetchImpl pattern) ──────
// Every network dependency is injected so the binding is deterministic and unit-testable without a real
// transport. Production defaults wire the real recap route and the existing memory-api review functions.
export interface VoiceSessionRecapIo {
  readonly buildRecap: (request: VoiceRecapBuildRequest) => Promise<VoiceRecapBuildResponse>;
  readonly fetchReviewQueue: () => Promise<MemoryReviewQueueResponse>;
  readonly accept: (id: string) => Promise<MemoryActionResponse>;
  readonly edit: (id: string, input: EditMemoryInput) => Promise<MemoryActionResponse>;
  readonly reject: (id: string, reason?: string) => Promise<MemoryActionResponse>;
  readonly forget: (id: string, reason?: string) => Promise<MemoryForgetResponse>;
}

async function postRecapBuild(request: VoiceRecapBuildRequest): Promise<VoiceRecapBuildResponse> {
  const res = await fetch("/api/voice/recap/build", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
    },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`voice recap build failed: HTTP ${res.status.toString()}`);
  }
  return res.json() as Promise<VoiceRecapBuildResponse>;
}

function defaultRecapIo(): VoiceSessionRecapIo {
  return {
    buildRecap: postRecapBuild,
    fetchReviewQueue: () => fetchMemoryReviewQueue(),
    // accept / reject take a plain string path segment; edit / forget take a branded MemoryId. The
    // HTTP boundary only needs the URL path segment, so the brand is applied at this seam (mirrors the
    // memory-api accept/reject rationale that both call sites supply a branded id).
    accept: (id) => acceptMemoryProposal(id),
    edit: (id, input) => editMemory(id as MemoryId, input),
    reject: (id, reason) => rejectMemoryProposal(id, reason),
    forget: (id, reason) => forgetMemory(id as MemoryId, reason),
  };
}

// ─── Content-free observer (mirrors the #500 / #502 observers) ───────────────────
// Every field is an integer count; the committed text never reaches the observer. `onTriggered` fires
// once a recap build resolves; `onReviewAction` fires after each delegated review mutation resolves.
export type VoiceRecapReviewActionKind = "approve" | "edit" | "reject" | "forget";

export interface VoiceRecapTriggeredEvent {
  readonly candidatesProposed: number;
  readonly candidatesRejected: number;
}

export interface VoiceRecapReviewActionEvent {
  readonly action: VoiceRecapReviewActionKind;
}

export interface VoiceSessionRecapObserver {
  onTriggered?(event: VoiceRecapTriggeredEvent): void;
  onReviewAction?(event: VoiceRecapReviewActionEvent): void;
}

// ─── Construction ────────────────────────────────────────────────────────────────
export interface VoiceSessionRecapBindingOptions {
  readonly profile: VoiceProfile;
  readonly io?: VoiceSessionRecapIo | undefined;
  readonly observer?: VoiceSessionRecapObserver | undefined;
}

// Read-only view for the consuming component. `active` mirrors `voiceRecapAllowed`; the counts are
// content-free (no transcript text). `lastResult` is the most recent recap build outcome (undefined
// before the first trigger).
export interface VoiceSessionRecapSnapshot {
  readonly profile: VoiceProfile;
  readonly active: boolean;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
  readonly lastResult: VoiceRecapBuildResponse | undefined;
}

export interface VoiceSessionRecapBinding {
  // Whether the recap may run for this profile (AC1 dormancy when false).
  canRecap(): boolean;
  // Whether a recap can be triggered RIGHT NOW: active AND a non-empty committed projection. False makes
  // the visible trigger inert so a session with nothing committed cannot produce a side effect (AC1).
  canTrigger(): boolean;
  // Replace the committed transcript the recap derives from. The binding holds only the committed
  // projection; it never retains partial / stable / discarded / redacted text (AC2).
  setSegments(segments: readonly VoiceTranscriptSegment[]): void;
  // Build the recap from the current committed projection. Dormant or empty → a no-op resolving to
  // `undefined` (no network call, no observer fire). Otherwise POSTs the committed text once for
  // extraction and returns the content-free counts.
  trigger(): Promise<VoiceRecapBuildResponse | undefined>;
  // Fetch the existing review queue so the surface can list the proposed candidates. Dormant → empty.
  loadReviewQueue(): Promise<MemoryReviewQueueResponse>;
  // Review actions — each DELEGATES to the existing governed memory endpoint (no new mutation surface).
  approve(id: string): Promise<MemoryActionResponse>;
  edit(id: string, input: EditMemoryInput): Promise<MemoryActionResponse>;
  reject(id: string, reason?: string): Promise<MemoryActionResponse>;
  forget(id: string, reason?: string): Promise<MemoryForgetResponse>;
  snapshot(): VoiceSessionRecapSnapshot;
  reset(): void;
}

const EMPTY_REVIEW_QUEUE: MemoryReviewQueueResponse = { memories: [], total: 0 };

function emptyProjection(): CommittedVoiceTranscriptProjection {
  return selectCommittedVoiceTranscript([]);
}

export function createVoiceSessionRecapBinding(
  options: VoiceSessionRecapBindingOptions,
): VoiceSessionRecapBinding {
  const { profile } = options;
  const io = options.io ?? defaultRecapIo();
  const observer = options.observer;
  const active = voiceRecapAllowed(profile);

  let committed: CommittedVoiceTranscriptProjection = emptyProjection();
  let lastResult: VoiceRecapBuildResponse | undefined;

  function hasCommitted(): boolean {
    return committed.text.trim().length > 0;
  }

  function canTrigger(): boolean {
    return active && hasCommitted();
  }

  function setSegments(segments: readonly VoiceTranscriptSegment[]): void {
    // Even when dormant we project to the empty/committed form so the snapshot stays consistent, but a
    // dormant profile never reaches `trigger`'s network path (AC1 short-circuits there).
    committed = selectCommittedVoiceTranscript(segments);
  }

  async function trigger(): Promise<VoiceRecapBuildResponse | undefined> {
    // AC1: a dormant profile or an empty committed projection produces NO side effect — no network call,
    // no observer fire, no state mutation. Short-circuit before any IO.
    if (!canTrigger()) {
      return undefined;
    }
    const result = await io.buildRecap({
      committedText: committed.text,
      segmentCount: committed.segmentCount,
      committedChars: committed.text.length,
    });
    lastResult = result;
    observer?.onTriggered?.({
      candidatesProposed: result.candidatesProposed,
      candidatesRejected: result.candidatesRejected,
    });
    return result;
  }

  async function loadReviewQueue(): Promise<MemoryReviewQueueResponse> {
    if (!active) {
      return EMPTY_REVIEW_QUEUE;
    }
    return io.fetchReviewQueue();
  }

  async function approve(id: string): Promise<MemoryActionResponse> {
    const response = await io.accept(id);
    observer?.onReviewAction?.({ action: "approve" });
    return response;
  }

  async function edit(id: string, input: EditMemoryInput): Promise<MemoryActionResponse> {
    const response = await io.edit(id, input);
    observer?.onReviewAction?.({ action: "edit" });
    return response;
  }

  async function reject(id: string, reason?: string): Promise<MemoryActionResponse> {
    const response = await io.reject(id, reason);
    observer?.onReviewAction?.({ action: "reject" });
    return response;
  }

  async function forget(id: string, reason?: string): Promise<MemoryForgetResponse> {
    const response = await io.forget(id, reason);
    observer?.onReviewAction?.({ action: "forget" });
    return response;
  }

  function snapshot(): VoiceSessionRecapSnapshot {
    return {
      profile,
      active,
      committedSegmentCount: committed.segmentCount,
      committedChars: committed.text.length,
      lastResult,
    };
  }

  function reset(): void {
    committed = emptyProjection();
    lastResult = undefined;
  }

  return {
    canRecap: (): boolean => active,
    canTrigger,
    setSegments,
    trigger,
    loadReviewQueue,
    approve,
    edit,
    reject,
    forget,
    snapshot,
    reset,
  };
}

// ─── React hook wrapper ──────────────────────────────────────────────────────────
// Binds `createVoiceSessionRecapBinding` to React state for the visible `VoiceRecap` surface. It owns
// the busy / loading flags and the candidate list, refreshing the list after a successful trigger and
// after each delegated review action so the surface reflects the existing review queue. Mirrors the
// `useVoicePlayback` React-state pattern (memoized binding, mounted guard, async dispatch).
export interface UseVoiceSessionRecapOptions {
  readonly profile: VoiceProfile;
  readonly segments?: readonly VoiceTranscriptSegment[] | undefined;
  readonly io?: VoiceSessionRecapIo | undefined;
}

export interface VoiceSessionRecapController {
  readonly active: boolean;
  readonly committedSegmentCount: number;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly candidates: readonly MemoryRecord[];
  readonly trigger: () => void;
  readonly approve: (id: string) => void;
  readonly edit: (id: string, body: string) => void;
  readonly reject: (id: string) => void;
  readonly forget: (id: string) => void;
}

const NO_SEGMENTS: readonly VoiceTranscriptSegment[] = [];

export function useVoiceSessionRecap(
  options: UseVoiceSessionRecapOptions,
): VoiceSessionRecapController {
  const { profile, io } = options;
  const segments = options.segments ?? NO_SEGMENTS;

  const binding = useMemo(() => createVoiceSessionRecapBinding({ profile, io }), [profile, io]);

  // Keep the binding's committed projection in sync with the segments the host supplies.
  binding.setSegments(segments);

  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<readonly MemoryRecord[]>([]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshQueue = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const queue = await binding.loadReviewQueue();
      if (mountedRef.current) {
        setCandidates(queue.memories);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [binding]);

  const trigger = useCallback((): void => {
    if (!binding.canTrigger()) {
      return;
    }
    setBusy(true);
    void binding
      .trigger()
      .then(() => refreshQueue())
      .finally(() => {
        if (mountedRef.current) {
          setBusy(false);
        }
      });
  }, [binding, refreshQueue]);

  const approve = useCallback(
    (id: string): void => {
      void binding.approve(id).then(() => refreshQueue());
    },
    [binding, refreshQueue],
  );
  const edit = useCallback(
    (id: string, body: string): void => {
      void binding.edit(id, { body }).then(() => refreshQueue());
    },
    [binding, refreshQueue],
  );
  const reject = useCallback(
    (id: string): void => {
      void binding.reject(id).then(() => refreshQueue());
    },
    [binding, refreshQueue],
  );
  const forget = useCallback(
    (id: string): void => {
      void binding.forget(id).then(() => refreshQueue());
    },
    [binding, refreshQueue],
  );

  const snapshot = binding.snapshot();
  return {
    active: snapshot.active,
    committedSegmentCount: snapshot.committedSegmentCount,
    busy,
    loading,
    candidates,
    trigger,
    approve,
    edit,
    reject,
    forget,
  };
}
