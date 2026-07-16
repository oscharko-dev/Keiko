import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchResourceState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { lifecycleAnnouncement, modelSourceLabel } from "./codingWorkbenchLabels";

// Echo translator: announcements are asserted on their catalog keys so the tests pin the
// branching logic without re-stating locale catalog text.
const t: CodingWorkbenchTranslate = (key) => key;

function ready<T>(value: T): CodingWorkbenchResourceState<T> {
  return { status: "ready", value, error: null };
}

function subscriptionProfile(
  status: CodingWorkbenchCodexSubscriptionProfile["status"],
): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "profile-1",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status,
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: false,
    supportsDeviceCode: false,
    supportsAccessToken: false,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function codexState(profile: CodingWorkbenchRuntimeState["profile"]): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
    profile,
  };
}

describe("modelSourceLabel", () => {
  it("maps each server model source to its catalog key", () => {
    expect(modelSourceLabel("keiko-model-gateway", t)).toBe("codingWorkbench.modelSource.gateway");
    expect(modelSourceLabel("openai-api-key-through-gateway", t)).toBe(
      "codingWorkbench.modelSource.openaiGateway",
    );
    expect(modelSourceLabel("chatgpt-codex-subscription-profile", t)).toBe(
      "codingWorkbench.modelSource.codexSubscription",
    );
  });
});

describe("lifecycleAnnouncement authentication truth", () => {
  it("announces authentication as not selected outside the codex preference", () => {
    const state = createInitialCodingWorkbenchRuntimeState("governed-assist", "managed-gateway");
    expect(lifecycleAnnouncement(state, t)).toContain(
      "codingWorkbench.announcement.authenticationNotSelected",
    );
  });

  it("announces checking while the profile resource loads", () => {
    const state = codexState({ status: "loading", value: null, error: null });
    expect(lifecycleAnnouncement(state, t)).toContain(
      "codingWorkbench.announcement.authenticationChecking",
    );
  });

  it.each(["error", "unavailable"] as const)(
    "announces unavailability when the profile resource is %s",
    (status) => {
      const state = codexState({ status, value: null, error: null });
      expect(lifecycleAnnouncement(state, t)).toContain(
        "codingWorkbench.announcement.authenticationUnavailable",
      );
    },
  );

  it("announces readiness for a connected profile", () => {
    const state = codexState(ready(subscriptionProfile("connected")));
    expect(lifecycleAnnouncement(state, t)).toContain(
      "codingWorkbench.announcement.authenticationReady",
    );
  });

  it("announces a required sign-in for a missing profile", () => {
    const state = codexState(ready(subscriptionProfile("missing")));
    expect(lifecycleAnnouncement(state, t)).toContain(
      "codingWorkbench.announcement.authenticationRequired",
    );
  });

  it("treats any other server profile status as unavailable", () => {
    const state = codexState(ready(subscriptionProfile("revoked")));
    expect(lifecycleAnnouncement(state, t)).toContain(
      "codingWorkbench.announcement.authenticationUnavailable",
    );
  });

  it("announces the unchecked state before any profile truth exists", () => {
    const state = codexState({ status: "idle", value: null, error: null });
    expect(lifecycleAnnouncement(state, t)).toContain(
      "codingWorkbench.announcement.authenticationNotChecked",
    );
  });
});
