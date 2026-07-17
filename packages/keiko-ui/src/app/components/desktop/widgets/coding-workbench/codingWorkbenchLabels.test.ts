import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchCodexSubscriptionProfile,
  type CodingWorkbenchRuntimeResearchGrant,
  type CodingWorkbenchRuntimeSnapshot,
  type CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchResourceState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { eventDetail, lifecycleAnnouncement, modelSourceLabel } from "./codingWorkbenchLabels";

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

const AT = "2026-07-13T12:00:00.000Z";

function runtimeEvent(extra: Record<string, unknown>): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: "cursor-1",
    sequence: 3,
    occurredAt: AT,
    kind: "runtime-event",
    runId: "run-1",
    state: "running",
    revision: 3,
    eventKind: "child-run-completed",
    ...extra,
  } as CodingWorkbenchRuntimeSseEvent;
}

describe("eventDetail auxiliary outcome", () => {
  it("appends the normalized outcome as a content-free sentence", () => {
    expect(eventDetail(runtimeEvent({ auxiliaryOutcome: "denied" }), t)).toBe(
      "codingWorkbench.event.detail codingWorkbench.event.detailOutcome",
    );
  });

  it("omits the outcome line when no auxiliary outcome is present", () => {
    expect(eventDetail(runtimeEvent({}), t)).toBe("codingWorkbench.event.detail");
  });

  it("keeps a redacted failure distinct from the outcome vocabulary", () => {
    expect(
      eventDetail(runtimeEvent({ failureCode: "runtime-crashed", auxiliaryOutcome: "stopped" }), t),
    ).toBe("codingWorkbench.event.detailFailure codingWorkbench.event.detailOutcome");
  });
});

describe("lifecycleAnnouncement research grant", () => {
  function withGrant(
    researchGrant: CodingWorkbenchRuntimeResearchGrant | null,
  ): CodingWorkbenchRuntimeState {
    return {
      ...createInitialCodingWorkbenchRuntimeState(),
      run: ready({
        schemaVersion: "1",
        state: "running",
        revision: 2,
        updatedAt: AT,
        runId: "run-1",
        ...(researchGrant === null ? {} : { researchGrant }),
      } as CodingWorkbenchRuntimeSnapshot),
    };
  }

  it("announces an active grant while one is present", () => {
    const state = withGrant({
      grantId: "grant-1",
      domains: ["nodejs.org"],
      expiresAt: "2026-07-13T12:30:00.000Z",
    });
    expect(lifecycleAnnouncement(state, t)).toContain(
      "codingWorkbench.announcement.researchActive",
    );
  });

  it("stays silent about research when no grant is present", () => {
    expect(lifecycleAnnouncement(withGrant(null), t)).not.toContain(
      "codingWorkbench.announcement.researchActive",
    );
  });
});
