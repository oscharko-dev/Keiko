// Regression tests for the Voice Digital Twin control / media protocol contract (Issue #496,
// ADR-0059). These pin the acceptance criteria as executable, mutation-resistant invariants:
//   AC1 — WebSocket control is separated from WebRTC media (no control kind carries raw audio).
//   AC2 — deterministic disabled behavior when voice capability is absent (`none` permits nothing).
//   AC3 — STT-only dictation does not require the full-realtime media path.
//   AC4 — no new runtime media packages beyond `ws` + browser-native WebRTC.
//   AC5 — replay includes control + committed-transcript events but excludes raw audio by default.
// The protocol module is pure; these tests are build-free apart from the package build vitest already
// runs, and read only repository manifests for the supply-chain assertion.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { VoiceProfile } from "./gateway.js";
import {
  DEFAULT_VOICE_PROTOCOL_TIMEOUTS,
  PREFERRED_VOICE_NEGOTIATION_MODE,
  VOICE_CONTROL_MESSAGE_KINDS,
  VOICE_CONTROL_MESSAGE_REDACTION,
  VOICE_CONTROL_MESSAGE_REPLAY,
  VOICE_CONTROL_TRANSPORT_V1,
  VOICE_DATA_CHANNEL_EVENT_KINDS,
  VOICE_MEDIA_PLANE,
  VOICE_NEGOTIATION_MODES,
  VOICE_PROFILE_ALLOWED_MESSAGE_KINDS,
  VOICE_PROFILE_MEDIA_TRANSPORT,
  VOICE_PROFILE_NEGOTIATION_MODE,
  VOICE_PROTOCOL_VERSION,
  isVoiceControlMessage,
  isVoiceControlMessageKind,
  isVoiceProtocolVersionSupported,
  isVoiceReplayEligible,
  validateVoiceControlMessage,
  voiceControlMessageRedactionClass,
  voiceControlMessageReplayClass,
  voiceMessageAllowedForProfile,
  type VoiceControlMessage,
  type VoiceControlMessageKind,
  type VoiceMediaTransport,
} from "./voice-protocol.js";

const ALL_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
];

function wellFormedMessage(kind: VoiceControlMessageKind): Record<string, unknown> {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId: "vs-abc123",
    seq: 0,
    direction: "client-to-host",
    kind,
  };
}

describe("voice protocol — version & catalog", () => {
  it("pins a string-literal protocol version distinct from the capability contract version", () => {
    expect(VOICE_PROTOCOL_VERSION).toBe("1");
    expect(typeof VOICE_PROTOCOL_VERSION).toBe("string");
  });

  it("accepts only the supported version", () => {
    expect(isVoiceProtocolVersionSupported("1")).toBe(true);
    expect(isVoiceProtocolVersionSupported("2")).toBe(false);
    expect(isVoiceProtocolVersionSupported(1)).toBe(false);
    expect(isVoiceProtocolVersionSupported(undefined)).toBe(false);
  });

  it("has a duplicate-free control-message catalog", () => {
    expect(new Set(VOICE_CONTROL_MESSAGE_KINDS).size).toBe(VOICE_CONTROL_MESSAGE_KINDS.length);
  });

  it("classifies every catalog kind for both replay and redaction (totality)", () => {
    for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
      expect(VOICE_CONTROL_MESSAGE_REPLAY[kind]).toBeDefined();
      expect(VOICE_CONTROL_MESSAGE_REDACTION[kind]).toBeDefined();
    }
    expect(Object.keys(VOICE_CONTROL_MESSAGE_REPLAY).sort()).toEqual(
      [...VOICE_CONTROL_MESSAGE_KINDS].sort(),
    );
    expect(Object.keys(VOICE_CONTROL_MESSAGE_REDACTION).sort()).toEqual(
      [...VOICE_CONTROL_MESSAGE_KINDS].sort(),
    );
  });

  it("keeps every data-channel event kind a subset of the control catalog", () => {
    for (const kind of VOICE_DATA_CHANNEL_EVENT_KINDS) {
      expect(VOICE_CONTROL_MESSAGE_KINDS).toContain(kind);
    }
  });

  it("recognises catalog kinds and rejects non-kinds", () => {
    expect(isVoiceControlMessageKind("transcript.committed")).toBe(true);
    expect(isVoiceControlMessageKind("not.a.kind")).toBe(false);
    expect(isVoiceControlMessageKind(42)).toBe(false);
  });
});

describe("AC1 — WebSocket control is separated from WebRTC media", () => {
  it("never classifies a control-message kind as raw media", () => {
    for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
      expect(VOICE_CONTROL_MESSAGE_REDACTION[kind]).not.toBe("raw-media");
    }
  });

  it("models raw audio only on the media plane, never as a control message", () => {
    expect(VOICE_MEDIA_PLANE.plane).toBe("media");
    expect(VOICE_MEDIA_PLANE.transport).toBe("webrtc");
    expect(VOICE_MEDIA_PLANE.redaction).toBe("raw-media");
    expect(VOICE_MEDIA_PLANE.replay).toBe("never-persisted");
    // No control kind references audio frames; the raw-media class is exclusive to the media plane.
    const kindStrings: readonly string[] = VOICE_CONTROL_MESSAGE_KINDS;
    expect(kindStrings.includes("media.audio")).toBe(false);
  });

  it("realizes the control plane on the loopback HTTP + SSE seam in v1", () => {
    expect(VOICE_CONTROL_TRANSPORT_V1).toBe("loopback-http-sse");
  });
});

describe("AC2 — deterministic disabled behavior when voice is absent", () => {
  it("permits no control message at all for the `none` profile", () => {
    expect(VOICE_PROFILE_ALLOWED_MESSAGE_KINDS.none).toEqual([]);
    for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
      expect(voiceMessageAllowedForProfile(kind, "none")).toBe(false);
    }
  });

  it("resolves `none` to no media transport and disabled negotiation", () => {
    expect(VOICE_PROFILE_MEDIA_TRANSPORT.none).toBe("none");
    expect(VOICE_PROFILE_NEGOTIATION_MODE.none).toBe("disabled");
  });
});

describe("AC3 — STT-only dictation does not require full-realtime voice", () => {
  const stt = VOICE_PROFILE_ALLOWED_MESSAGE_KINDS["speech-to-text"];

  it("permits the dictation transcript lifecycle", () => {
    expect(stt).toContain("transcript.partial");
    expect(stt).toContain("transcript.committed");
    expect(stt).toContain("transcript.discarded");
  });

  it("excludes every WebRTC signaling, media-track, interruption and playback kind", () => {
    for (const realtimeOnly of [
      "signal.sdp.offer",
      "signal.sdp.answer",
      "signal.ice.candidate",
      "media.track.state",
      "control.interrupt",
      "playback.state",
    ] satisfies VoiceControlMessageKind[]) {
      expect(stt).not.toContain(realtimeOnly);
      expect(voiceMessageAllowedForProfile(realtimeOnly, "speech-to-text")).toBe(false);
    }
  });

  it("uses the batch media path and disabled browser negotiation for STT", () => {
    expect(VOICE_PROFILE_MEDIA_TRANSPORT["speech-to-text"]).toBe("gateway-batch");
    expect(VOICE_PROFILE_NEGOTIATION_MODE["speech-to-text"]).toBe("disabled");
  });

  it("reserves WebRTC and proxied-SDP negotiation for the full-realtime profile only", () => {
    expect(VOICE_PROFILE_MEDIA_TRANSPORT["full-realtime"]).toBe("webrtc");
    expect(VOICE_PROFILE_NEGOTIATION_MODE["full-realtime"]).toBe("proxied-sdp");
    expect(PREFERRED_VOICE_NEGOTIATION_MODE).toBe("proxied-sdp");
    expect(VOICE_NEGOTIATION_MODES).toContain("disabled");
    // full-realtime is the only profile permitting SDP signaling.
    for (const profile of ALL_PROFILES) {
      const permitsSdp = VOICE_PROFILE_ALLOWED_MESSAGE_KINDS[profile].includes("signal.sdp.offer");
      expect(permitsSdp).toBe(profile === "full-realtime");
    }
  });

  it("permits a gating decision for every profile/kind pair without throwing", () => {
    for (const profile of ALL_PROFILES) {
      for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
        expect(typeof voiceMessageAllowedForProfile(kind, profile)).toBe("boolean");
      }
    }
  });
});

describe("AC5 — replay includes control + transcripts but excludes raw audio", () => {
  it("treats the committed transcript and core control events as replayable", () => {
    expect(isVoiceReplayEligible("transcript.committed")).toBe(true);
    expect(isVoiceReplayEligible("session.created")).toBe(true);
    expect(isVoiceReplayEligible("policy.decision")).toBe(true);
    expect(voiceControlMessageReplayClass("transcript.committed")).toBe("replayable");
  });

  it("treats ephemeral signaling and partial transcripts as non-replayable", () => {
    for (const ephemeral of [
      "signal.sdp.offer",
      "signal.sdp.answer",
      "signal.ice.candidate",
      "transcript.partial",
    ] satisfies VoiceControlMessageKind[]) {
      expect(isVoiceReplayEligible(ephemeral)).toBe(false);
      expect(voiceControlMessageReplayClass(ephemeral)).toBe("ephemeral");
    }
  });

  it("excludes raw audio from replay and persistence (media plane only)", () => {
    expect(VOICE_MEDIA_PLANE.replay).toBe("never-persisted");
    // `never-persisted` is exclusive to the media plane; no control kind carries it.
    for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
      expect(VOICE_CONTROL_MESSAGE_REPLAY[kind]).not.toBe("never-persisted");
    }
  });

  it("classifies SDP/ICE as secret-bearing and transcripts as reviewable-text", () => {
    expect(voiceControlMessageRedactionClass("signal.sdp.offer")).toBe("secret-bearing");
    expect(voiceControlMessageRedactionClass("signal.ice.candidate")).toBe("secret-bearing");
    expect(voiceControlMessageRedactionClass("transcript.committed")).toBe("reviewable-text");
    expect(voiceControlMessageRedactionClass("session.created")).toBe("content-free");
  });
});

describe("AC4 — no new runtime media packages beyond ws + native WebRTC", () => {
  // The protocol forbids any runtime WebRTC SDK / peer / SFU / media-server library by default
  // (ADR-0058 D8 / docs/voice/supply-chain-policy.md). Enforced as a live assertion over every
  // repository package manifest so a future accidental addition trips this test, not just review.
  const FORBIDDEN_MEDIA_PACKAGES: readonly string[] = [
    "socket.io",
    "socket.io-client",
    "simple-peer",
    "peerjs",
    "mediasoup",
    "mediasoup-client",
    "livekit",
    "livekit-client",
    "livekit-server-sdk",
    "wrtc",
    "node-webrtc",
    "janus-gateway",
    "kurento-client",
    "agora-rtc-sdk-ng",
    "twilio-video",
    "@daily-co/daily-js",
    "opentok",
    "sip.js",
    "jssip",
    "webrtc-adapter",
  ];

  function repoRoot(): string {
    // src/ → keiko-contracts → packages → repo root
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  }

  function manifestPaths(root: string): string[] {
    const paths: string[] = [join(root, "package.json")];
    const packagesDir = join(root, "packages");
    if (existsSync(packagesDir)) {
      for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const manifest = join(packagesDir, entry.name, "package.json");
          if (existsSync(manifest)) {
            paths.push(manifest);
          }
        }
      }
    }
    return paths;
  }

  function declaredDependencies(manifestPath: string): string[] {
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const names: string[] = [];
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const section = pkg[field];
      if (section !== null && typeof section === "object") {
        names.push(...Object.keys(section));
      }
    }
    return names;
  }

  it("declares none of the forbidden runtime media packages in any workspace", () => {
    const root = repoRoot();
    const manifests = manifestPaths(root);
    expect(manifests.length).toBeGreaterThan(1);
    const forbidden = new Set(FORBIDDEN_MEDIA_PACKAGES);
    const offenders: string[] = [];
    for (const manifest of manifests) {
      for (const dep of declaredDependencies(manifest)) {
        if (forbidden.has(dep)) {
          offenders.push(`${manifest} -> ${dep}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("models media transport using only native mechanisms (no SDK)", () => {
    expect(VOICE_PROFILE_MEDIA_TRANSPORT["full-realtime"]).toBe("webrtc");
    expect(VOICE_MEDIA_PLANE.transport).toBe("webrtc");
  });
});

describe("envelope validation & guards", () => {
  it("accepts a well-formed envelope for every kind", () => {
    for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
      const message = wellFormedMessage(kind);
      expect(validateVoiceControlMessage(message).ok).toBe(true);
      expect(isVoiceControlMessage(message)).toBe(true);
    }
  });

  it("rejects malformed envelopes with reasons", () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ ...wellFormedMessage("error"), protocolVersion: "2" }, "protocolVersion unsupported"],
      [{ ...wellFormedMessage("error"), sessionId: "  " }, "sessionId must be a non-empty string"],
      [{ ...wellFormedMessage("error"), seq: -1 }, "seq must be a non-negative integer"],
      [{ ...wellFormedMessage("error"), seq: 1.5 }, "seq must be a non-negative integer"],
      [{ ...wellFormedMessage("error"), direction: "sideways" }, "direction invalid"],
      [{ ...wellFormedMessage("error"), kind: "nope" }, "kind invalid"],
    ];
    for (const [input, reason] of cases) {
      const result = validateVoiceControlMessage(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasons).toContain(reason);
      }
      expect(isVoiceControlMessage(input)).toBe(false);
    }
  });

  it("rejects non-object inputs", () => {
    expect(validateVoiceControlMessage(null).ok).toBe(false);
    expect(validateVoiceControlMessage("x").ok).toBe(false);
    expect(isVoiceControlMessage(null)).toBe(false);
    expect(isVoiceControlMessage([])).toBe(false);
  });

  it("narrows a validated message to its payload type", () => {
    const created: VoiceControlMessage = {
      protocolVersion: VOICE_PROTOCOL_VERSION,
      sessionId: "vs-1",
      seq: 1,
      direction: "host-to-client",
      kind: "session.created",
      profile: "full-realtime",
      controlTransport: "loopback-http-sse",
      mediaTransport: "webrtc",
      negotiationMode: "proxied-sdp",
    };
    // Narrow over the full union (passed through a union-typed parameter) so the discriminant check
    // is meaningful rather than statically true.
    const narrow = (message: VoiceControlMessage): VoiceMediaTransport | undefined =>
      message.kind === "session.created" ? message.mediaTransport : undefined;
    expect(created.kind).toBe("session.created");
    expect(narrow(created)).toBe("webrtc");
  });
});

describe("timeout / reconnect defaults", () => {
  it("exposes positive, ordered backoff bounds", () => {
    const t = DEFAULT_VOICE_PROTOCOL_TIMEOUTS;
    expect(t.sessionCreateMs).toBeGreaterThan(0);
    expect(t.signalingMs).toBeGreaterThan(0);
    expect(t.heartbeatIntervalMs).toBeGreaterThan(0);
    expect(t.reconnectBackoffMaxMs).toBeGreaterThanOrEqual(t.reconnectBackoffInitialMs);
    expect(t.maxReconnectAttempts).toBeGreaterThan(0);
  });
});
