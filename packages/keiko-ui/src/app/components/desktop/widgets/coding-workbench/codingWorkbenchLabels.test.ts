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
import {
  changesetDeliveryAlert,
  eventDetail,
  lifecycleAnnouncement,
  modelSourceLabel,
  visibleAlert,
} from "./codingWorkbenchLabels";

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

// #2637: the operator approved a destination, never what the page would say. An accepted research
// read has to be visible in the timeline AS untrusted content, not just as a successful fetch.
describe("eventDetail untrusted research content", () => {
  it("names the quarantined content on an accepted research read", () => {
    expect(
      eventDetail(
        runtimeEvent({
          eventKind: "research-performed",
          auxiliaryOutcome: "accepted",
          contentTrust: "untrusted",
        }),
        t,
      ),
    ).toBe(
      "codingWorkbench.event.detail codingWorkbench.event.detailOutcome " +
        "codingWorkbench.event.detailUntrustedContent",
    );
  });

  it("says nothing about content for a research denial, which took nothing in", () => {
    expect(
      eventDetail(runtimeEvent({ eventKind: "research-performed", auxiliaryOutcome: "denied" }), t),
    ).toBe("codingWorkbench.event.detail codingWorkbench.event.detailOutcome");
  });
});

describe("lifecycleAnnouncement research grant", () => {
  const state: CodingWorkbenchRuntimeState = {
    ...createInitialCodingWorkbenchRuntimeState(),
    run: ready({
      schemaVersion: "1",
      state: "running",
      revision: 2,
      updatedAt: AT,
      runId: "run-1",
    }),
  };

  it("announces an active grant while one is present", () => {
    const grant: CodingWorkbenchRuntimeResearchGrant = {
      grantId: "grant-1",
      domains: ["nodejs.org"],
      expiresAt: "2026-07-13T12:30:00.000Z",
    };
    expect(lifecycleAnnouncement(state, t, grant)).toContain(
      "codingWorkbench.announcement.researchActive",
    );
  });

  it("stays silent about research when no grant is present", () => {
    expect(lifecycleAnnouncement(state, t, null)).not.toContain(
      "codingWorkbench.announcement.researchActive",
    );
  });
});

describe("visibleAlert mutation failures (F-09a)", () => {
  // Values-aware echo translator: pins that the alert carries the machine facts (code,
  // correlation id) through the catalog placeholders without re-stating locale text.
  const tv: CodingWorkbenchTranslate = (key, values) =>
    values === undefined ? key : `${key} ${JSON.stringify(values)}`;

  function failedMutationState(correlationId?: string): CodingWorkbenchRuntimeState {
    return {
      ...createInitialCodingWorkbenchRuntimeState(),
      mutation: {
        status: "error",
        kind: "start",
        requestId: "request-1",
        error: {
          code: "CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED",
          message: "Runtime request was rejected.",
          retryable: false,
          ...(correlationId === undefined ? {} : { correlationId }),
        },
      },
    };
  }

  it("names the machine error code for any failed mutation", () => {
    const alert = visibleAlert(failedMutationState(), tv, false);
    expect(alert).toContain("codingWorkbench.alert.actionFailedCode");
    expect(alert).toContain("CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED");
    expect(alert).not.toContain("codingWorkbench.alert.actionFailedSupportId");
  });

  it("appends the correlation id as a copyable support id when the transport carried one", () => {
    const alert = visibleAlert(failedMutationState("ui-correlation-9"), tv, false);
    expect(alert).toContain("codingWorkbench.alert.actionFailedSupportId");
    expect(alert).toContain("ui-correlation-9");
  });
});

describe("app-session pairing truth (release-audit F-08/RG-12)", () => {
  function unpairedState(): CodingWorkbenchRuntimeState {
    return { ...createInitialCodingWorkbenchRuntimeState(), pairing: "unpaired" };
  }

  // ADR-0141: an unpaired window's run start is guaranteed to fail authority resolution, so the
  // narration must name pairing as the missing input instead of narrating full readiness.
  it("names the unpaired window in the lifecycle narration", () => {
    expect(lifecycleAnnouncement(unpairedState(), t)).toContain("codingWorkbench.pairing.unpaired");
  });

  it("does not claim pairing truth while it is still unconfirmed", () => {
    expect(lifecycleAnnouncement(createInitialCodingWorkbenchRuntimeState(), t)).not.toContain(
      "codingWorkbench.pairing.unpaired",
    );
  });

  it("surfaces the unpaired window as a standing visible alert", () => {
    expect(visibleAlert(unpairedState(), t, false)).toBe("codingWorkbench.pairing.unpaired");
    expect(visibleAlert(createInitialCodingWorkbenchRuntimeState(), t, false)).toBeNull();
  });

  it("keeps an actionable refresh failure ahead of the standing pairing condition", () => {
    const state: CodingWorkbenchRuntimeState = {
      ...unpairedState(),
      runtime: {
        status: "error",
        value: null,
        error: { code: "RUNTIME_UNAVAILABLE", message: "redacted", retryable: true },
      },
    };
    expect(visibleAlert(state, t, false)).toBe("codingWorkbench.alert.runtimeRefreshFailed");
// F-09a: the editor-changeset approve/deny used to discard its error in a bare `catch { return
// false }`, so the review could only say "could not confirm this decision" — no code to act on and
// no support id to report, on the one decision that blocks the run's file write.
describe("changesetDeliveryAlert (F-09a)", () => {
  const tv: CodingWorkbenchTranslate = (key, values) =>
    values === undefined ? key : `${key} ${JSON.stringify(values)}`;

  it("names the machine error code of an undelivered decision", () => {
    const alert = changesetDeliveryAlert({ code: "BRIDGE_LEASE_INACTIVE" }, tv);
    expect(alert).toContain("codingWorkbench.changesetReview.deliveryFailedCode");
    expect(alert).toContain("BRIDGE_LEASE_INACTIVE");
    expect(alert).not.toContain("codingWorkbench.alert.actionFailedSupportId");
  });

  it("appends the correlation id as a copyable support id when the transport carried one", () => {
    const alert = changesetDeliveryAlert(
      { code: "BRIDGE_LEASE_INACTIVE", correlationId: "ui-correlation-4" },
      tv,
    );
    expect(alert).toContain("codingWorkbench.alert.actionFailedSupportId");
    expect(alert).toContain("ui-correlation-4");
  });

  it("falls back to the code-free sentence rather than an empty alert", () => {
    expect(changesetDeliveryAlert(null, tv)).toBe("codingWorkbench.changesetReview.deliveryFailed");
  });
});
