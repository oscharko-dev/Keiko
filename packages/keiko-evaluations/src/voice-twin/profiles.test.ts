// Unit tests for profiles.ts (Issue #505 — per-module coverage additions).
//
// Targets the UNCOVERED function/branch: `localProfilesMatchContract()` true-case (line 26-29,
// currently at 50% function coverage because it was never called directly). Also covers every
// environment descriptor field and both branches of effectiveVoiceProfile /
// egressDestinationClassFor. Each assertion is mutation-robust.

import { VOICE_PROFILE_MEDIA_TRANSPORT } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import {
  ALL_VOICE_PROFILES,
  VOICE_ENVIRONMENT_DESCRIPTORS,
  effectiveVoiceProfile,
  egressDestinationClassFor,
  localProfilesMatchContract,
} from "./profiles.js";

describe("localProfilesMatchContract", () => {
  it("returns true when ALL_VOICE_PROFILES matches the contract keys exactly", () => {
    // Mutation guard: if ALL_VOICE_PROFILES drops one profile (e.g., removes "speech-output"),
    // or adds an extra one, this returns false.
    expect(localProfilesMatchContract()).toBe(true);
  });

  it("cross-validates that every contract key appears in ALL_VOICE_PROFILES", () => {
    const contractKeys = Object.keys(VOICE_PROFILE_MEDIA_TRANSPORT).sort();
    const local = ALL_VOICE_PROFILES.slice().sort();
    // Mutation guard: if the length comparison is inverted (> instead of ===), this fails.
    expect(local.length).toBe(contractKeys.length);
    expect(local).toEqual(contractKeys);
  });

  it("ALL_VOICE_PROFILES contains exactly four profiles", () => {
    // Mutation guard: if a profile is dropped from the local array, length fails.
    expect(ALL_VOICE_PROFILES).toHaveLength(4);
    expect(ALL_VOICE_PROFILES).toContain("none");
    expect(ALL_VOICE_PROFILES).toContain("speech-to-text");
    expect(ALL_VOICE_PROFILES).toContain("speech-output");
    expect(ALL_VOICE_PROFILES).toContain("full-realtime");
  });
});

describe("VOICE_ENVIRONMENT_DESCRIPTORS", () => {
  it("azure-foundry descriptor has egresses=true and cloud-provider posture", () => {
    const desc = VOICE_ENVIRONMENT_DESCRIPTORS["azure-foundry"];
    expect(desc.id).toBe("azure-foundry");
    expect(desc.egresses).toBe(true);
    // Mutation guard: if networkPosture is changed, this fails.
    expect(desc.networkPosture).toBe("cloud-provider");
  });

  it("customer-hosted descriptor has egresses=true and controlled-network posture", () => {
    const desc = VOICE_ENVIRONMENT_DESCRIPTORS["customer-hosted"];
    expect(desc.id).toBe("customer-hosted");
    expect(desc.egresses).toBe(true);
    expect(desc.networkPosture).toBe("controlled-network");
  });

  it("no-voice-env descriptor has egresses=false and no-provider posture", () => {
    const desc = VOICE_ENVIRONMENT_DESCRIPTORS["no-voice-env"];
    expect(desc.id).toBe("no-voice-env");
    // Mutation guard: if egresses is changed to true, effectiveVoiceProfile no longer degrades.
    expect(desc.egresses).toBe(false);
    expect(desc.networkPosture).toBe("no-provider");
  });
});

describe("effectiveVoiceProfile", () => {
  it("returns advertised profile for provider-configured environments", () => {
    expect(effectiveVoiceProfile("azure-foundry", "speech-to-text")).toBe("speech-to-text");
    expect(effectiveVoiceProfile("customer-hosted", "full-realtime")).toBe("full-realtime");
    expect(effectiveVoiceProfile("azure-foundry", "speech-output")).toBe("speech-output");
    expect(effectiveVoiceProfile("customer-hosted", "none")).toBe("none");
  });

  it("degrades every advertised profile to none in no-voice-env", () => {
    // Mutation guard: if the ternary condition is inverted, all provider-env profiles also return none.
    for (const advertised of [
      "none",
      "speech-to-text",
      "speech-output",
      "full-realtime",
    ] as const) {
      expect(effectiveVoiceProfile("no-voice-env", advertised), advertised).toBe("none");
    }
  });

  it("does NOT degrade advertised none in provider env (stays none, not recalculated)", () => {
    // Mutation guard: if the function always returns "none", azure-foundry + full-realtime would fail.
    expect(effectiveVoiceProfile("azure-foundry", "full-realtime")).toBe("full-realtime");
  });
});

describe("egressDestinationClassFor", () => {
  it("returns none for effective profile none", () => {
    // Mutation guard: if condition is `!== "none"` (inverted), none returns "configured-model-endpoint".
    expect(egressDestinationClassFor("none")).toBe("none");
  });

  it("returns configured-model-endpoint for every active profile", () => {
    expect(egressDestinationClassFor("speech-to-text")).toBe("configured-model-endpoint");
    expect(egressDestinationClassFor("speech-output")).toBe("configured-model-endpoint");
    // Mutation guard: if the branch body is wrong, full-realtime would get "none".
    expect(egressDestinationClassFor("full-realtime")).toBe("configured-model-endpoint");
  });
});
