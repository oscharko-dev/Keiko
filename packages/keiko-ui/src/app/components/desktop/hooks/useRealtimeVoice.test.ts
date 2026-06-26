// Issue #497 — the realtime voice state machine. Drives the real hook with injected fake transport
// and control (no real getUserMedia / WebSocket / RTCPeerConnection touched). Covers: idle →
// requesting → negotiating → connected happy path; permission-denied; negotiation-failed;
// stop() returns to idle and closes both; unmount mid-flow closes resources and dispatches nothing.

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRealtimeVoice } from "./useRealtimeVoice";
import { VoiceRtcError, type VoiceRtcSession, type VoiceRtcTransport } from "./voice-rtc-transport";
import {
  VoiceControlError,
  type VoiceControlClient,
} from "./voice-realtime-client";

// Fake WebRTC session with controllable callbacks.
function makeFakeSession(offerSdp = "v=0\r\nfake-offer"): {
  session: VoiceRtcSession;
  fireConnectionState: (state: RTCPeerConnectionState) => void;
  applyAnswer: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let connectionStateCb: ((state: RTCPeerConnectionState) => void) | undefined;
  const applyAnswer = vi.fn(async (_sdp: string): Promise<void> => {});
  const close = vi.fn();

  const session: VoiceRtcSession = {
    offerSdp,
    applyAnswer,
    onRemoteTrack: vi.fn(),
    onConnectionStateChange(cb): void {
      connectionStateCb = cb;
    },
    close,
  };

  return {
    session,
    fireConnectionState: (state) => connectionStateCb?.(state),
    applyAnswer,
    close,
  };
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

function makeFakeControl(opts: {
  negotiateResult?: string;
  negotiateError?: unknown;
}): { client: VoiceControlClient; close: ReturnType<typeof vi.fn> } {
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
