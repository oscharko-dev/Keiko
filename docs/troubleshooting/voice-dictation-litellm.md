# Dictation fails through LiteLLM with a configured Whisper model

Tracking: [#4032](https://github.com/oscharko-dev/Keiko/issues/4032).

## Symptom

The model list recognizes a speech-to-text deployment and the microphone captures a clip, but
`POST /api/voice/transcribe` returns `502 VOICE_PROVIDER_ERROR` after entering transcription.
Capability discovery describes the deployment; it does not certify a successful audio inference.

## Root Cause

One reproducible cause is a decoder/container mismatch. Chromium's preferred recording is
WebM/Opus. A valid OpenAI-compatible transcription endpoint may accept PCM WAV while rejecting
that container. LiteLLM routes the request but does not guarantee the downstream decoder supports
every browser codec. Older Keiko recordings were forwarded in the browser's container, and
different provider rejections were collapsed into a transport failure without the HTTP status.

A 502 alone does not prove this cause. Authentication, routing, endpoint configuration and an
unhealthy upstream can produce the same user-visible result. A customer's exact diagnosis needs
their validated local support report; photos alone do not establish the upstream failure.

## Diagnostic Steps

1. Query the existing Activity Log by the failed request's correlation id. For a received support
   report, validate it with `keiko support analyze REPORT --json` first.
2. Inspect `speech.stt.request.dispatch`: `audioFormat`, `audioBytes`, and the applied deadline.
3. Inspect `speech.stt.request.completed`: read `failureKind` first, then `httpStatus`, when present.
   A 400/422 response warrants checking the provider's accepted request and audio formats. A missing
   status indicates that no HTTP response was received; `failureKind` on that same event identifies
   the classified failure, such as a timeout, cancellation or transport error.
4. Compare the same synthetic spoken clip as browser-encoded audio and PCM WAV through the same
   gateway alias. Keep credentials, audio, transcripts and raw provider bodies out of diagnostics.

## Resolution

Updated browser dictation decodes the complete recording locally, mixes it to mono and resamples
to 16 kHz with native Web Audio, then uploads signed PCM16 WAV. This works without an additional
server decoder dependency or a second provider request. Unsupported or corrupt browser recordings
fail visibly through the existing diagnostic sink; they are never silently retried as raw WebM.
Explicit API callers can still submit the route's other allowed formats when their provider supports them.

Configure the LiteLLM alias with `model_info.mode: audio_transcription` and the correct upstream
provider, credentials and base URL. For a local Whisper.cpp qualification server, use its configurable
inference path to expose `/v1/audio/transcriptions`, then route LiteLLM to that server's `/v1` base.
Do not advertise an audio model as a chat model or change authentication to bypass a rejection.

Local qualification on 2026-10-15 used Apple M4 Max, Whisper.cpp 1.9.5 with the multilingual
Whisper small and large-v3-turbo models, and a synthetic German sentence, with the real Keiko BFF,
STT adapter and LiteLLM 1.104.0. WAV succeeded and WebM failed before normalization. Real Chromium
normalized the WebM clip to WAV in approximately 18–21 ms. Native Chromium microphone capture
(using a synthetic audio input) released its track and produced a successfully transcribed WAV.
Ogg/Opus at 48 kHz stereo and MP4/AAC at 44.1 kHz stereo also passed the browser normalization
and BFF-to-LiteLLM-to-large-v3-turbo path. Warm provider round trips for the roughly six-second
sentence took approximately 0.28–0.33 seconds; these are local observations, not latency guarantees.
The production CLI instance was also exercised through the built UI in English and German, using
native Chromium recording with synthetic German microphone input and the real LiteLLM route.
Recording, transcription, preview editing, insertion, a second recording, discard and window-close
cancellation passed; all captured microphone tracks ended. The subsequent Gemma chat turn completed.
A separate instance with an unreachable voice provider returned 502 and exercised retry and dismissal
while preserving text entry. Denied microphone permission produced the specific permission message
without uploading audio. Before the one-control UI follow-up, the four existing dictation smoke
journeys passed in each of Chromium, WebKit and Firefox. The later one-control layout has four passing
Chromium smoke journeys and actual In-App Browser inspection; those results do not establish a manual
layout check in the other engines.
WebKit also decoded real MP4/AAC and WAV clips that transcribed through the running application.
Firefox also normalized real Ogg/Opus, WebM/Opus and WAV clips and transcribed them through the
running application. Its initial profile-folder launch failure was resolved by using isolated
`MOZ_APP_DATA` and `MOZ_LOCAL_APP_DATA` directories, without changing browser security settings.
A real 120-second clip normalized to 3,840,044 bytes and transcribed through
the BFF and gateway successfully. The separate full-length native UI recording also stopped
automatically and returned a transcript: 3,841,964 WAV bytes, approximately 125 seconds from the
initial click through transcription, all microphone tracks ended and no browser page errors.

The complete local coverage-quality aggregate passed: package, UI and script suites, all 27
package metric floors, both release targets and all 73 governed file floors. The editor bundle
evidence was regenerated and verified with the repository-approved Node 24.18.0 runtime after
reproducing a gzip measurement mismatch from Node 24.21.0; no budget or threshold was changed.

This proves the compatibility defect and its repair; it does not establish the customer's exact upstream cause
or general transcription accuracy across microphones, accents and acoustic conditions.

Upstream references: [Whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server),
[LiteLLM gateway](https://docs.litellm.ai/docs/simple_proxy).
