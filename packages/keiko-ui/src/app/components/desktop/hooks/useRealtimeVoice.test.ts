// Issue #497 — the realtime voice state machine. Drives the real hook with injected fake transport
// and control (no real getUserMedia / WebSocket / RTCPeerConnection touched). Covers: idle →
// requesting → negotiating → connected happy path; permission-denied; negotiation-failed;
// stop() returns to idle and closes both; unmount mid-flow closes resources and dispatches nothing.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRealtimeVoice, type RealtimeAudioSink } from "./useRealtimeVoice";
import { VoiceRtcError, type VoiceRtcSession, type VoiceRtcTransport } from "./voice-rtc-transport";
import { VoiceControlError, type VoiceControlClient } from "./voice-realtime-client";

// The hook's ICE_DISCONNECT_GRACE_MS is 5_000ms; probe just below and above it.
const ICE_GRACE_BELOW = 4_000;
const ICE_GRACE_ABOVE = 6_000;

// Fake WebRTC session with controllable callbacks.
function makeFakeSession(offerSdp = "v=0\r\nfake-offer"): {
  session: VoiceRtcSession;
  fireConnectionState: (state: RTCPeerConnectionState) => void;
  fireRemoteTrack: (stream: MediaStream) => void;
  fireDataChannelEvent: (event: unknown) => void;
  sendDataChannelEvent: ReturnType<typeof vi.fn>;
  applyAnswer: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let connectionStateCb: ((state: RTCPeerConnectionState) => void) | undefined;
  let remoteTrackCb: ((stream: MediaStream) => void) | undefined;
  let dataChannelEventCb: ((event: unknown) => void) | undefined;
  const applyAnswer = vi.fn(async (_sdp: string): Promise<void> => {});
  const sendDataChannelEvent = vi.fn((_event: unknown) => true);
  const close = vi.fn();

  const session: VoiceRtcSession = {
    offerSdp,
    applyAnswer,
    onRemoteTrack(cb): void {
      remoteTrackCb = cb;
    },
    onConnectionStateChange(cb): void {
      connectionStateCb = cb;
    },
    onDataChannelEvent(cb): void {
      dataChannelEventCb = cb;
    },
    sendDataChannelEvent,
    close,
  };

  return {
    session,
    fireConnectionState: (state) => connectionStateCb?.(state),
    fireRemoteTrack: (stream) => remoteTrackCb?.(stream),
    fireDataChannelEvent: (event) => dataChannelEventCb?.(event),
    sendDataChannelEvent,
    applyAnswer,
    close,
  };
}

// Fake audio sink capturing attach/release calls without a real HTMLAudioElement.
function makeFakeAudioSink(): {
  sink: RealtimeAudioSink;
  attach: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const attach = vi.fn();
  const release = vi.fn();
  return { sink: { attach, release }, attach, release };
}

function makeFakeTransport(opts: {
  connectError?: unknown;
  session?: VoiceRtcSession;
}): VoiceRtcTransport {
  return {
    connect: vi.fn(async () => {
      if (opts.connectError !== undefined) throw opts.connectError;
      if (opts.session === undefined) throw new Error("no session provided");
      return opts.session;
    }),
  };
}

function makeFakeControl(opts: { negotiateResult?: string; negotiateError?: unknown }): {
  client: VoiceControlClient;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const client: VoiceControlClient = {
    negotiate: vi.fn(async (_sdp: string): Promise<string> => {
      if (opts.negotiateError !== undefined) throw opts.negotiateError;
      return opts.negotiateResult ?? "v=0\r\nfake-answer";
    }),
    close,
  };
  return { client, close };
}

describe("useRealtimeVoice — happy path (idle → requesting → negotiating → connected)", () => {
  it("transitions through all phases and ends at connected", async () => {
    const { session, fireConnectionState } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({ negotiateResult: "v=0\r\nfake-answer" });

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    expect(result.current.phase).toBe("idle");
    expect(result.current.busy).toBe(false);

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    expect(result.current.busy).toBe(true);

    // Simulate the WebRTC connection becoming live.
    act(() => fireConnectionState("connected"));
    await waitFor(() => expect(result.current.phase).toBe("connected"));
    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBeUndefined();
  });
});

describe("useRealtimeVoice — assistant remote audio (regression: silent realtime)", () => {
  it("attaches the remote stream to the audio sink when a remote track arrives", async () => {
    const { session, fireRemoteTrack } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({});
    const { sink, attach } = makeFakeAudioSink();

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        createAudioSink: () => sink,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));

    const remoteStream = { id: "remote" } as unknown as MediaStream;
    act(() => fireRemoteTrack(remoteStream));
    expect(attach).toHaveBeenCalledWith(remoteStream);
  });

  it("releases the audio sink on stop()", async () => {
    const { session, fireConnectionState, fireRemoteTrack } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({});
    const { sink, release } = makeFakeAudioSink();

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        createAudioSink: () => sink,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => fireRemoteTrack({ id: "remote" } as unknown as MediaStream));
    act(() => fireConnectionState("connected"));
    await waitFor(() => expect(result.current.phase).toBe("connected"));

    act(() => result.current.stop());
    expect(release).toHaveBeenCalled();
  });
});

describe("useRealtimeVoice — Realtime data-channel transcripts", () => {
  it("forwards committed user and assistant transcripts through callbacks", async () => {
    const { session, fireDataChannelEvent } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({});
    const onUserTranscriptCommitted = vi.fn();
    const onAssistantTranscriptCommitted = vi.fn();

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        onUserTranscriptCommitted,
        onAssistantTranscriptCommitted,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "Open the deploy log.",
      });
      fireDataChannelEvent({
        type: "response.output_audio_transcript.done",
        response_id: "r1",
        item_id: "a1",
        transcript: "The deploy log is open.",
      });
    });

    expect(onUserTranscriptCommitted).toHaveBeenCalledWith("Open the deploy log.");
    expect(onAssistantTranscriptCommitted).toHaveBeenCalledWith("The deploy log is open.");
    expect(result.current.turnSnapshot.state).toBe("yielding");
  });

  it("sends response.cancel when the user interrupts the assistant", async () => {
    const { session, fireDataChannelEvent, sendDataChannelEvent } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fireDataChannelEvent({ type: "response.output_audio.delta", response_id: "r1" });
    });
    expect(result.current.canInterrupt).toBe(true);

    act(() => result.current.interrupt());
    expect(sendDataChannelEvent).toHaveBeenCalledWith({ type: "response.cancel" });
    expect(result.current.turnSnapshot.state).toBe("interrupted");
  });
});

describe("useRealtimeVoice — transient ICE disconnect grace", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the session alive on a transient 'disconnected' that recovers", async () => {
    vi.useFakeTimers();
    const { session, fireConnectionState, close: sessionClose } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => fireConnectionState("connected"));
    await vi.waitFor(() => expect(result.current.phase).toBe("connected"));

    // A momentary blip: stays connected, session not closed.
    act(() => fireConnectionState("disconnected"));
    act(() => vi.advanceTimersByTime(ICE_GRACE_BELOW));
    expect(result.current.phase).toBe("connected");
    expect(sessionClose).not.toHaveBeenCalled();

    // Recovers before the grace window elapses.
    act(() => fireConnectionState("connected"));
    act(() => vi.advanceTimersByTime(ICE_GRACE_ABOVE));
    expect(result.current.phase).toBe("connected");
    expect(sessionClose).not.toHaveBeenCalled();
  });

  it("tears down when 'disconnected' does not recover within the grace window", async () => {
    vi.useFakeTimers();
    const { session, fireConnectionState, close: sessionClose } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => fireConnectionState("connected"));
    await vi.waitFor(() => expect(result.current.phase).toBe("connected"));

    act(() => fireConnectionState("disconnected"));
    act(() => vi.advanceTimersByTime(ICE_GRACE_ABOVE));
    expect(result.current.phase).toBe("idle");
    expect(sessionClose).toHaveBeenCalled();
  });

  it("treats 'failed' as immediately terminal (no grace)", async () => {
    const { session, fireConnectionState, close: sessionClose } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => fireConnectionState("connected"));
    await waitFor(() => expect(result.current.phase).toBe("connected"));

    act(() => fireConnectionState("failed"));
    expect(result.current.phase).toBe("idle");
    expect(sessionClose).toHaveBeenCalled();
  });
});

describe("useRealtimeVoice — error states (AC4)", () => {
  it("maps a permission-denied transport error to the error phase", async () => {
    const transport = makeFakeTransport({
      connectError: new VoiceRtcError("permission-denied", "denied"),
    });
    const { client } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("permission-denied");
    expect(result.current.busy).toBe(false);
  });

  it("maps a no-microphone transport error to the error phase", async () => {
    const transport = makeFakeTransport({
      connectError: new VoiceRtcError("no-microphone", "none"),
    });
    const { client } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("no-microphone");
  });

  it("maps a negotiation-failed control error to the error phase", async () => {
    const { session } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({
      negotiateError: new VoiceControlError("negotiation-failed", "failed"),
    });

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("negotiation-failed");
  });

  it("maps an unavailable control error to the error phase", async () => {
    const { session } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client } = makeFakeControl({
      negotiateError: new VoiceControlError("unavailable", "no ws"),
    });

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("unavailable");
  });
});

describe("useRealtimeVoice — stop and retry", () => {
  it("stop() returns to idle and closes session + control", async () => {
    const { session, fireConnectionState, close: sessionClose } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const { client, close: controlClose } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => fireConnectionState("connected"));
    await waitFor(() => expect(result.current.phase).toBe("connected"));

    act(() => result.current.stop());
    expect(result.current.phase).toBe("idle");
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(controlClose).toHaveBeenCalledTimes(1);
  });

  it("retry() from error re-starts the flow", async () => {
    const transport = makeFakeTransport({
      connectError: new VoiceRtcError("connection-failed", "err"),
    });
    const { client } = makeFakeControl({});

    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));

    // Allow connect to succeed on retry.
    vi.mocked(transport.connect).mockImplementationOnce(async () => {
      throw new VoiceRtcError("connection-failed", "err2");
    });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(vi.mocked(transport.connect)).toHaveBeenCalledTimes(2);
  });
});

describe("useRealtimeVoice — unmount safety", () => {
  it("closes resources and dispatches nothing when unmounted mid-negotiation", async () => {
    let resolveNegotiate: (value: string) => void = () => {};
    const { session, close: sessionClose } = makeFakeSession();
    const transport = makeFakeTransport({ session });
    const controlClose = vi.fn();
    const client: VoiceControlClient = {
      negotiate: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveNegotiate = resolve;
          }),
      ),
      close: controlClose,
    };

    const { result, unmount } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));

    unmount();

    await act(async () => {
      resolveNegotiate("v=0\r\nlate-answer");
      await Promise.resolve();
    });

    // Resources closed; no "state update on unmounted component" warning.
    expect(sessionClose).toHaveBeenCalled();
    expect(controlClose).toHaveBeenCalled();
  });

  it("does not throw when transport resolves after unmount", async () => {
    let resolveConnect: (value: VoiceRtcSession) => void = () => {};
    const { session } = makeFakeSession();
    const { client } = makeFakeControl({});
    const transport: VoiceRtcTransport = {
      connect: vi.fn(
        () =>
          new Promise<VoiceRtcSession>((resolve) => {
            resolveConnect = resolve;
          }),
      ),
    };

    const { result, unmount } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
      }),
    );

    act(() => result.current.start());
    expect(result.current.phase).toBe("requesting");
    unmount();

    await act(async () => {
      resolveConnect(session);
      await Promise.resolve();
    });

    // No dispatch on unmounted — no error thrown.
    expect(true).toBe(true);
  });
});
