# Voice dialogue session

Voice Dialogue is a second input/output interface for the same canonical desktop chat. Its current
architecture is governed by
[ADR-0154](../adr/ADR-0154-canonical-twin-voice-pipeline.md), which supersedes the provider-owned
assistant paths described by ADR-0096 and ADR-0116.

## Canonical turn pipeline

Realtime has exactly three responsibilities: microphone media transport, voice activity detection,
and final user transcription. The browser negotiates an input-only WebRTC audio track. It does not
accept a remote provider-audio track, configure assistant instructions or tools, or request a native
provider response.

After the continuation window settles, each provider-final transcript is admitted once through the
same `sendMessage` path as typed Composer input. That path owns the user message, conversation/project/
workspace/user scopes, Memoria Viva, retrieval, grounding, citations, the visible assistant message,
and persistence. There is no `/api/desktop/chat/voice-turn` endpoint and no Voice-specific retrieval,
memory, or assistant route.

The visible canonical assistant message is the only speech source. Its exact persisted message id is
returned by the chat send outcome and used to arm text-to-speech; a concurrently arriving assistant
message cannot be selected by recency. Speech-safe projection may remove URLs and citation appendices
from audio, while the visible message retains its grounding and citation metadata.

## Capability gate

`voiceDialogueModeForResolution` offers the switch only when all of these are true:

- a reachable Realtime capability and WebRTC media transport are available;
- an independent speech-output capability is available;
- at least one persona has an explicit provider voice-id mapping on that speech-output provider; and
- the browser supports microphone capture, `RTCPeerConnection`, and send-only transceivers.

Realtime-only, STT-only, speech-output-only, unresolved, unreachable, policy-disabled, missing-persona,
and non-WebRTC configurations all fail closed. Realtime never contributes an output persona. Composer
dictation and Read Aloud remain independently capability-gated helper surfaces.

## Settlement, interruption, and teardown

Provider final events are deduplicated by their bounded item identity. A short continuation window
joins natural pauses and self-corrections before one canonical admission. A repeated final after
reconnect cannot create a duplicate message. Oversized transcripts fail closed rather than being
truncated into a different user statement.

Barge-in stops canonical TTS playback and returns the floor to microphone capture. It does not cancel
or create a provider-native assistant response because no such response exists.

Stop or mode leave flushes an already final transcript immediately, exactly once. Component unmount
does the same before invalidating asynchronous callbacks and without scheduling React state updates.
A partial transcription delta without a provider final is not promoted during stop or unmount. All
settlement, warm-up, reconnect, ICE-grace, and input-rearm timers are cleared, and microphone tracks,
the data channel, peer connection, and control socket are closed. Recoverable transport replacement
preserves the control identity for bounded replay; deliberate teardown emits `session.close` so the
server removes terminal resume state immediately.

The Realtime hook owns no admission retry. After its one synchronous final handoff, the canonical Chat
session owns an immutable, bounded FIFO keyed by chat and canonical turn id. The handoff captures the
original chat/model/memory target and projects the user message immediately, so leaving Voice,
switching chats, or replacing media cannot drop or re-scope it. `not-sent` and reconciled
`in-progress` outcomes are retried only inside the Chat queue's finite window with the same id.
Completion is used to arm TTS only for that exact assistant message; a persisted cancellation and a
terminal failure never arm speech.

## Privacy and failure behavior

Raw audio remains ephemeral and is never persisted. Transcript text is kept out of the content-free
turn-manager signals and latency observations. Provider error bodies, endpoints, credentials, SDP,
and voice ids never enter browser-visible errors, logs, or evidence.

Generic provider-session errors close the media and control resources immediately while leaving any
partial transcript visible for review; partial text is never promoted as a final. The written chat
remains usable when capture, transcription, synthesis, or playback fails.

## Related

- [ADR-0154](../adr/ADR-0154-canonical-twin-voice-pipeline.md)
- [realtime-transport.md](realtime-transport.md)
- [assistant-speech-synthesis.md](assistant-speech-synthesis.md)
- [privacy-contract.md](privacy-contract.md)
