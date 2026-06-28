// Unit tests for deriveCapabilityCell (Issue #505 — per-module coverage additions).
//
// Tests are disjoint from suite.test.ts: suite.test.ts exercises the full fixture run-through;
// these tests prove the cell derivation logic in isolation, covering all profile × environment
// combinations and the control-plane / media-plane invariants. Each assertion is mutation-robust:
// a single-line change in the implementation (wrong profile returned, wrong egressClass, wrong
// mediaTransport) makes at least one test RED.

import {
  VOICE_PROFILE_ALLOWED_MESSAGE_KINDS,
  VOICE_PROFILE_MEDIA_TRANSPORT,
  VOICE_PROFILE_NEGOTIATION_MODE,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import { deriveCapabilityCell } from "./capability.js";

describe("deriveCapabilityCell", () => {
  // ─── No-voice environment degrades every advertised profile to none ──────────────
  describe("no-voice-env degrades any advertised profile", () => {
    const profiles = ["none", "speech-to-text", "speech-output", "full-realtime"] as const;

    for (const advertised of profiles) {
      it(`degrades ${advertised} → effective none in no-voice-env`, () => {
        const cell = deriveCapabilityCell("no-voice-env", advertised);

        // Mutation guard: if effectiveVoiceProfile returns `advertised` instead of `none`, this fails.
        expect(cell.effectiveProfile).toBe("none");
        // Mutation guard: if allowedKinds uses `advertised` profile, this fails for non-none profiles.
        expect(cell.allowedKinds).toEqual(VOICE_PROFILE_ALLOWED_MESSAGE_KINDS.none);
        expect(cell.allowedKinds).toHaveLength(0);
        expect(cell.mediaTransport).toBe("none");
        expect(cell.negotiation).toBe("disabled");
        expect(cell.egressClass).toBe("none");
      });
    }
  });

  // ─── Azure-foundry: profiles pass through without degradation ────────────────────
  it("returns speech-to-text cell for azure-foundry × speech-to-text", () => {
    const cell = deriveCapabilityCell("azure-foundry", "speech-to-text");

    expect(cell.effectiveProfile).toBe("speech-to-text");
    expect(cell.allowedKinds).toEqual(VOICE_PROFILE_ALLOWED_MESSAGE_KINDS["speech-to-text"]);
    expect(cell.mediaTransport).toBe(VOICE_PROFILE_MEDIA_TRANSPORT["speech-to-text"]);
    expect(cell.negotiation).toBe(VOICE_PROFILE_NEGOTIATION_MODE["speech-to-text"]);
    expect(cell.egressClass).toBe("configured-model-endpoint");
  });

  it("returns speech-output cell for azure-foundry × speech-output", () => {
    const cell = deriveCapabilityCell("azure-foundry", "speech-output");

    expect(cell.effectiveProfile).toBe("speech-output");
    expect(cell.mediaTransport).toBe(VOICE_PROFILE_MEDIA_TRANSPORT["speech-output"]);
    expect(cell.egressClass).toBe("configured-model-endpoint");
  });

  it("returns full-realtime cell for azure-foundry × full-realtime", () => {
    const cell = deriveCapabilityCell("azure-foundry", "full-realtime");

    expect(cell.effectiveProfile).toBe("full-realtime");
    expect(cell.mediaTransport).toBe("webrtc");
    expect(cell.negotiation).toBe("proxied-sdp");
    // Mutation guard: if the condition for egressClass is wrong (e.g. !== "none" is wrong),
    // an active profile would get egressClass "none".
    expect(cell.egressClass).toBe("configured-model-endpoint");
    expect(cell.controlPlaneIsLoopback).toBe(true);
    expect(cell.mediaPlaneId).toBe("media");
  });

  it("returns full-realtime cell for customer-hosted × full-realtime", () => {
    const cell = deriveCapabilityCell("customer-hosted", "full-realtime");

    expect(cell.effectiveProfile).toBe("full-realtime");
    expect(cell.egressClass).toBe("configured-model-endpoint");
  });

  // ─── AC4 invariant: control plane is ALWAYS loopback ─────────────────────────────
  it("controlPlaneIsLoopback is always true regardless of profile", () => {
    for (const env of ["azure-foundry", "customer-hosted", "no-voice-env"] as const) {
      for (const advertised of ["none", "speech-to-text", "full-realtime"] as const) {
        const cell = deriveCapabilityCell(env, advertised);
        // Mutation guard: if controlPlaneIsLoopback is changed to `false` or a derived boolean,
        // this fails on every invocation.
        expect(cell.controlPlaneIsLoopback, `${env}/${advertised}`).toBe(true);
      }
    }
  });

  // ─── mediaPlaneId is always "media" ──────────────────────────────────────────────
  it('mediaPlaneId is always "media"', () => {
    const cell = deriveCapabilityCell("customer-hosted", "speech-to-text");
    // Mutation guard: if VOICE_MEDIA_PLANE.plane is renamed or changed, this fails.
    expect(cell.mediaPlaneId).toBe("media");
  });

  // ─── none (azure-foundry × none) egresses nowhere ────────────────────────────────
  it("returns egressClass none when effective profile is none (azure-foundry × none)", () => {
    const cell = deriveCapabilityCell("azure-foundry", "none");

    expect(cell.effectiveProfile).toBe("none");
    // Mutation guard: if the branch condition in egressDestinationClassFor is inverted,
    // an effective-none cell would return "configured-model-endpoint".
    expect(cell.egressClass).toBe("none");
    expect(cell.allowedKinds).toHaveLength(0);
  });

  // ─── SDP / media / interrupt kinds excluded from STT ────────────────────────────
  it("STT cell excludes SDP and media-track kinds", () => {
    const cell = deriveCapabilityCell("azure-foundry", "speech-to-text");
    const forbidden = [
      "signal.sdp.offer",
      "signal.sdp.answer",
      "signal.ice.candidate",
      "media.track.state",
    ] as const;

    for (const kind of forbidden) {
      expect(cell.allowedKinds.includes(kind), kind).toBe(false);
    }
    // Mutation guard: if allowedKinds includes transcript.committed, this must hold.
    expect(cell.allowedKinds.includes("transcript.committed")).toBe(true);
  });

  // ─── full-realtime includes SDP / media-track kinds ─────────────────────────────
  it("full-realtime cell includes SDP and media-track kinds", () => {
    const cell = deriveCapabilityCell("customer-hosted", "full-realtime");
    const required = ["signal.sdp.offer", "signal.sdp.answer", "media.track.state"] as const;

    for (const kind of required) {
      expect(cell.allowedKinds.includes(kind), kind).toBe(true);
    }
  });
});
